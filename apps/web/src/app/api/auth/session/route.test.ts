import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalAdmissionNetwork, GET, POST, trustedDeploymentNetwork } from "./route";

const {
  assertSameOrigin,
  authErrorResponse,
  createLearnerId,
  getSession,
  createSessionToken,
  upsertProfile,
  createAuthSession,
  revokeAuthSession,
  admitAnonymousLearner,
  releaseAnonymousLearner,
} = vi.hoisted(() => ({
  assertSameOrigin: vi.fn(),
  authErrorResponse: vi.fn(),
  createLearnerId: vi.fn(),
  getSession: vi.fn(),
  createSessionToken: vi.fn(),
  upsertProfile: vi.fn(),
  createAuthSession: vi.fn(),
  revokeAuthSession: vi.fn(),
  admitAnonymousLearner: vi.fn(),
  releaseAnonymousLearner: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/server/auth", () => ({
  AuthRegistryUnavailable: class AuthRegistryUnavailable extends Error {
    readonly status = 503;
    readonly code = "auth_registry_unavailable";

    constructor(cause?: unknown) {
      super("The learner session registry is temporarily unavailable.", { cause });
    }
  },
  AuthError: class AuthError extends Error {},
  assertSameOrigin,
  authErrorResponse,
  createLearnerId,
  getSession,
  publicLearner: (learner: object) => learner,
  SESSION_COOKIE_NAME: "axiom_session",
  SESSION_TTL_SECONDS: 604_800,
  sessionCookieOptions: () => ({ httpOnly: true, sameSite: "strict" as const, path: "/" }),
  createSessionToken,
}));
vi.mock("@/lib/server/session/runtime", () => ({
  getPersistenceServicesFromEnv: () => ({
    repository: { upsertProfile },
    sessions: { createAuthSession, revokeAuthSession, admitAnonymousLearner, releaseAnonymousLearner },
  }),
}));

function request(body: unknown = {}): Request {
  return new Request("http://localhost/api/auth/session", {
    method: "POST",
    headers: { origin: "http://localhost", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("GET /api/auth/session", () => {
  it("maps an invalid cookie to 401", async () => {
    getSession.mockRejectedValueOnce(Object.assign(new Error("A valid learner session is required."), {
      status: 401,
      code: "authentication_required",
    }));
    authErrorResponse.mockImplementationOnce((error: { status: number; code: string; message: string }) => (
      Response.json(
        { error: { code: error.code, message: error.message } },
        { status: error.status },
      )
    ));

    const response = await GET(new Request("http://localhost/api/auth/session", {
      headers: { cookie: "axiom_session=invalid" },
    }));

    expect(response.status).toBe(401);
  });

  it("maps session registry outages to 503", async () => {
    getSession.mockRejectedValueOnce(Object.assign(new Error("The learner session registry is temporarily unavailable."), {
      status: 503,
      code: "auth_registry_unavailable",
    }));
    authErrorResponse.mockImplementationOnce((error: { status: number; code: string; message: string }) => (
      Response.json(
        { error: { code: error.code, message: error.message } },
        { status: error.status },
      )
    ));

    const response = await GET(new Request("http://localhost/api/auth/session", {
      headers: { cookie: "axiom_session=signed" },
    }));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "auth_registry_unavailable" },
    });
  });

  it("marks learner identity responses as non-cacheable", async () => {
    getSession.mockResolvedValueOnce({
      v: 1,
      sid: "11111111-1111-4111-8111-111111111111",
      learnerId: "lrn_3xV7USq8K9h2mN5p",
      displayName: "Guest",
      ageBand: "13-15",
    });

    const response = await GET(new Request("http://localhost/api/auth/session"));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});

describe("POST /api/auth/session", () => {

  beforeEach(() => {
    assertSameOrigin.mockReset();
    authErrorResponse.mockReset().mockImplementation(
      (error: { status?: number; code?: string; message?: string }) => Response.json(
        {
          error: {
            code: error.code ?? "internal_error",
            message: error.message ?? "The request could not be completed.",
          },
        },
        { status: error.status ?? 500 },
      ),
    );
    createLearnerId.mockReset().mockResolvedValue("lrn_3xV7USq8K9h2mN5p");
    createSessionToken.mockReset().mockReturnValue("11111111-1111-4111-8111-111111111111");
    upsertProfile.mockReset().mockResolvedValue(undefined);
    createAuthSession.mockReset().mockResolvedValue(undefined);
    revokeAuthSession.mockReset().mockResolvedValue(undefined);
    releaseAnonymousLearner.mockReset().mockResolvedValue(undefined);
    admitAnonymousLearner.mockReset().mockResolvedValue({ allowed: true });
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("uses only the deployment-authenticated client IP header in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VERCEL", "1");
    const deploymentRequest = new Request("https://axiom.example/api/auth/session", {
      headers: {
        "x-forwarded-for": "198.51.100.66",
        "x-vercel-forwarded-for": "203.0.113.9",
      },
    });

    expect(trustedDeploymentNetwork(deploymentRequest)).toBe("ipv4:203.0.113.9/32");
  });

  it("does not treat an untrusted forwarding header as the production source address", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VERCEL", "");
    vi.stubEnv("CF_PAGES", "");
    vi.stubEnv("CLOUDFLARE_WORKER", "");
    vi.stubEnv("FLY_APP_NAME", "");
    vi.stubEnv("TRUSTED_CLIENT_IP_HEADER", "");

    const spoofedRequest = new Request("https://axiom.example/api/auth/session", {
      headers: { "x-forwarded-for": "198.51.100.66" },
    });

    expect(trustedDeploymentNetwork(spoofedRequest)).toBeNull();
  });

  it("shares an admission bucket across rotating IPv6 hosts in one /64", () => {
    const firstHost = canonicalAdmissionNetwork("2001:db8:abcd:12::1");
    const rotatedHost = canonicalAdmissionNetwork("2001:0DB8:ABCD:0012:ffff:eeee:dddd:cccc");

    expect(firstHost).toBe("ipv6:2001:0db8:abcd:0012::/64");
    expect(rotatedHost).toBe(firstHost);
  });

  it("keeps distinct IPv6 /64 prefixes in distinct admission buckets", () => {
    const firstPrefix = canonicalAdmissionNetwork("2001:db8:abcd:12::1");
    const secondPrefix = canonicalAdmissionNetwork("2001:db8:abcd:13::1");

    expect(firstPrefix).not.toBe(secondPrefix);
    expect(secondPrefix).toBe("ipv6:2001:0db8:abcd:0013::/64");
  });

  it("rejects a streamed body that exceeds the application byte ceiling", async () => {
    const encoder = new TextEncoder();
    let cancelCalled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('{\"displayName\":\"'));
        controller.enqueue(encoder.encode("x".repeat(16_384)));
      },
      cancel() {
        cancelCalled = true;
      },
    }, { highWaterMark: 0 });
    const oversizedRequest = new Request("http://localhost/api/auth/session", {
      method: "POST",
      headers: {
        origin: "http://localhost",
        "content-type": "application/json",
        "content-length": "1",
      },
      body: stream,
      duplex: "half",
    } as RequestInit & { duplex: "half" });

    const response = await POST(oversizedRequest);

    expect(response.status).toBe(413);
    expect(cancelCalled).toBe(true);
    expect(admitAnonymousLearner).not.toHaveBeenCalled();
  });

  it("normalizes IPv4-mapped IPv6 as the conservative IPv4 /32 identity", () => {
    expect(canonicalAdmissionNetwork("::ffff:192.0.2.128")).toBe("ipv4:192.0.2.128/32");
    expect(canonicalAdmissionNetwork("0:0:0:0:0:ffff:c000:0280")).toBe("ipv4:192.0.2.128/32");
    expect(canonicalAdmissionNetwork("192.0.2.128")).toBe("ipv4:192.0.2.128/32");
  });

  it("rejects scoped and invalid source addresses", () => {
    expect(canonicalAdmissionNetwork("fe80::1%eth0")).toBeNull();
    expect(canonicalAdmissionNetwork("2001:db8:::1")).toBeNull();
    expect(canonicalAdmissionNetwork("not-an-address")).toBeNull();
  });

  it("creates an opaque guest profile without onboarding fields", async () => {
    const response = await POST(request());

    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(upsertProfile).toHaveBeenCalledWith({
      learnerId: "lrn_3xV7USq8K9h2mN5p",
      displayName: "Guest",
      ageBand: "13-15",
      ageBandConfirmedAt: expect.any(Date),
    });
    expect(createAuthSession).toHaveBeenCalledWith(
      expect.stringMatching(/^[0-9a-f-]{36}$/u),
      "lrn_3xV7USq8K9h2mN5p",
      604_800,
    );
    expect(upsertProfile.mock.invocationCallOrder[0]).toBeLessThan(createAuthSession.mock.invocationCallOrder[0]!);
    const cookieValue = response.headers.get("set-cookie")?.match(/axiom_session=([^;]+)/u)?.[1];
    expect(cookieValue).toMatch(/^[0-9a-f-]{36}$/u);
    expect(cookieValue).not.toContain("Maya");
    expect(() => JSON.parse(Buffer.from(cookieValue!, "base64url").toString("utf8"))).toThrow();
  });

  it("rejects removed onboarding and profile fields", async () => {
    const response = await POST(request({
      displayName: "Maya",
      ageBand: "13-15",
      privacyNoticeAcknowledged: true,
    }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "invalid_guest_session" },
    });
    expect(upsertProfile).not.toHaveBeenCalled();
    expect(createAuthSession).not.toHaveBeenCalled();
  });
  it("rejects exhausted shared admission before creating a profile or auth session", async () => {

    admitAnonymousLearner.mockResolvedValueOnce({
      allowed: false,
      reason: "network_limit",
      retryAfterSeconds: 600,
    });

    const response = await POST(request());

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("600");
    expect(upsertProfile).not.toHaveBeenCalled();
    expect(createAuthSession).not.toHaveBeenCalled();
  });


  it("maps auth-session registry creation outages to 503 without issuing a cookie", async () => {
    createAuthSession.mockRejectedValue(new Error("redis unavailable"));

    const response = await POST(request());

    expect(response.status).toBe(503);
    expect(response.headers.get("set-cookie")).toBeNull();
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "auth_registry_unavailable",
        message: "The learner session registry is temporarily unavailable.",
      },
    });
  });

  it("releases anonymous admission when auth-session creation fails", async () => {
    createAuthSession.mockRejectedValueOnce(new Error("redis unavailable"));

    const response = await POST(request());

    expect(response.status).toBe(503);
    expect(releaseAnonymousLearner).toHaveBeenCalledWith({
      learnerId: "lrn_3xV7USq8K9h2mN5p",
      networkId: "ipv4:127.0.0.1/32",
    });
  });


  it("does not issue a cookie when profile persistence fails", async () => {
    upsertProfile.mockRejectedValue(new Error("database unavailable"));

    const response = await POST(request());

    expect(response.status).toBe(500);
    expect(response.headers.get("set-cookie")).toBeNull();
    await expect(response.json()).resolves.toEqual({
      error: { code: "profile_persistence_failed", message: "H3 Max Realtime Education could not create the learner profile." },
    });
  });
});
