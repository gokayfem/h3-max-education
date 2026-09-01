import { createHmac, timingSafeEqual } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthError, SessionPayload } from "./auth";
import * as auth from "./auth";

vi.mock("server-only", () => ({}));
const { getAuthSessionLearner, getProfile } = vi.hoisted(() => ({
  getAuthSessionLearner: vi.fn(),
  getProfile: vi.fn(),
}));
vi.mock("./session/runtime", () => ({
  getPersistenceServicesFromEnv: () => ({
    repository: { getProfile },
    sessions: { getAuthSessionLearner },
  }),
}));
const SECRET = "test-session-secret-with-at-least-32-characters";
const NOW = 1_800_000_000;

beforeEach(() => {
  getAuthSessionLearner.mockReset().mockResolvedValue("lrn_3xV7USq8K9h2mN5p");
  getProfile.mockReset().mockResolvedValue({
    learnerId: "lrn_3xV7USq8K9h2mN5p",
    displayName: "Maya",
    ageBand: "13-15",
  });
});
afterEach(() => {
  vi.unstubAllEnvs();
});


function validPayload(): SessionPayload {
  return {
    sid: "00000000-0000-4000-8000-000000000001",
    v: 1,
    learnerId: "lrn_3xV7USq8K9h2mN5p",
    displayName: "Maya",
    ageBand: "13-15",
  };
}

describe("opaque learner sessions", () => {
  it("resolves an opaque registry key to the server-side learner profile", async () => {
    const token = auth.createSessionToken();

    expect(token).toMatch(/^[0-9a-f-]{36}$/u);
    expect(token).not.toContain("Maya");
    expect(() => JSON.parse(Buffer.from(token, "base64url").toString("utf8"))).toThrow();
    await expect(auth.verifySessionToken(token)).resolves.toEqual({
      ...validPayload(),
      sid: token,
    });
    expect(getAuthSessionLearner).toHaveBeenCalledWith(token);
    expect(getProfile).toHaveBeenCalledWith(validPayload().learnerId);
  });

  it("resolves one registry cookie across the session endpoint and server page", async () => {
    const token = auth.createSessionToken();
    const registry: Record<string, string> = { [token]: validPayload().learnerId };
    getAuthSessionLearner.mockImplementation(async (sessionId: string) => registry[sessionId] ?? null);
    const cookie = `${auth.SESSION_COOKIE_NAME}=${token}`;
    const sessionEndpointRequest = new Request("https://axiom.test/api/auth/session", {
      headers: { cookie },
    });
    const serverPageRequest = new Request("https://axiom.test/learn", {
      headers: { cookie },
    });

    const expected = { ...validPayload(), sid: token };
    await expect(auth.getSession(sessionEndpointRequest)).resolves.toEqual(expected);
    await expect(auth.getSession(serverPageRequest)).resolves.toEqual(expected);
    expect(getAuthSessionLearner).toHaveBeenNthCalledWith(1, token);
    expect(getAuthSessionLearner).toHaveBeenNthCalledWith(2, token);
  });

  it("fails closed for malformed or modified opaque keys", async () => {
    const token = validPayload().sid;
    const modified = `${token.slice(0, -1)}2`;

    getAuthSessionLearner.mockResolvedValueOnce(null);
    await expect(auth.verifySessionToken(modified)).resolves.toBeNull();
    await expect(auth.verifySessionToken("not-a-session")).resolves.toBeNull();
  });

  it("fails closed when the registry entry has expired", async () => {
    getAuthSessionLearner.mockResolvedValueOnce(null);

    await expect(auth.verifySessionToken(validPayload().sid)).resolves.toBeNull();
    expect(getProfile).not.toHaveBeenCalled();
  });



  it("creates unrelated random learner ids without accepting email identity input", async () => {
    const first = await auth.createLearnerId();
    const second = await auth.createLearnerId();

    expect(first).toMatch(/^lrn_[A-Za-z0-9_-]{24}$/u);
    expect(second).toMatch(/^lrn_[A-Za-z0-9_-]{24}$/u);
    expect(first).not.toBe(second);
  });

  it("rejects a copied valid token after its registry entry is revoked or unknown", async () => {
    const token = validPayload().sid;
    getAuthSessionLearner.mockResolvedValue(null);

    await expect(auth.verifySessionToken(token)).resolves.toBeNull();
  });

  it("surfaces registry outages without misclassifying the cookie as invalid", async () => {
    const token = validPayload().sid;
    const outage = new Error("redis unavailable");
    getAuthSessionLearner.mockRejectedValue(outage);

    await expect(auth.verifySessionToken(token)).rejects.toMatchObject({
      name: "AuthRegistryUnavailable",
      code: "auth_registry_unavailable",
      status: 503,
      cause: outage,
    });
  });

  it("maps malformed request cookies to 401 and registry outages to 503", async () => {
    const invalidRequest = new Request("https://axiom.test/api/session", {
      headers: { cookie: `${auth.SESSION_COOKIE_NAME}=not-a-session` },
    });
    await expect(auth.getSession(invalidRequest)).rejects.toMatchObject({
      code: "authentication_required",
      status: 401,
    });
    const expiredToken = validPayload().sid;
    getAuthSessionLearner.mockResolvedValueOnce(null);
    const expiredRequest = new Request("https://axiom.test/api/session", {
      headers: { cookie: `${auth.SESSION_COOKIE_NAME}=${expiredToken}` },
    });
    await expect(auth.getSession(expiredRequest)).rejects.toMatchObject({
      code: "authentication_required",
      status: 401,
    });
    const token = validPayload().sid;
    getAuthSessionLearner.mockRejectedValue(new Error("redis unavailable"));
    const outageRequest = new Request("https://axiom.test/api/session", {
      headers: { cookie: `${auth.SESSION_COOKIE_NAME}=${token}` },
    });
    const error = await auth.getSession(outageRequest).catch((caught: unknown) => caught);
    const response = auth.authErrorResponse(error);

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "auth_registry_unavailable",
        message: "The learner session registry is temporarily unavailable.",
      },
    });
  });
});


describe("short-lived gateway credentials", () => {
  const GATEWAY_SECRET = "distinct-gateway-secret-with-at-least-32-characters";
  const payload: auth.GatewayTokenPayload = {
    v: 1,
    learnerId: "lrn_3xV7USq8K9h2mN5p",
    sessionId: "33333333-3333-4333-8333-333333333333",
    callId: "rtc_test-call-1234",
    exp: NOW + 60,
    nonce: "44444444-4444-4444-8444-444444444444",
  };

  it("signs the strict session-bound payload with the independent gateway secret", async () => {
    const token = await auth.signGatewayToken(payload, GATEWAY_SECRET, NOW);
    const [payloadSegment, signatureSegment] = token.split(".");
    const supplied = Buffer.from(signatureSegment, "base64url");
    const gatewaySignature = createHmac("sha256", GATEWAY_SECRET)
      .update(payloadSegment)
      .digest();
    const sessionSignature = createHmac("sha256", SECRET)
      .update(payloadSegment)
      .digest();

    expect(timingSafeEqual(supplied, gatewaySignature)).toBe(true);
    expect(timingSafeEqual(supplied, sessionSignature)).toBe(false);
    expect(JSON.parse(Buffer.from(payloadSegment, "base64url").toString("utf8"))).toEqual(payload);
  });

  it("refuses expired, overlong, or unbound gateway credentials", async () => {
    await expect(auth.signGatewayToken({ ...payload, exp: NOW }, GATEWAY_SECRET, NOW))
      .rejects.toThrow("invalid gateway token");
    await expect(auth.signGatewayToken({ ...payload, exp: NOW + 61 }, GATEWAY_SECRET, NOW))
      .rejects.toThrow("invalid gateway token");
    await expect(auth.signGatewayToken({
      ...payload,
      sessionId: "not-a-session",
    }, GATEWAY_SECRET, NOW)).rejects.toThrow("invalid gateway token");
    await expect(auth.signGatewayToken({
      ...payload,
      callId: "bad",
    }, GATEWAY_SECRET, NOW)).rejects.toThrow("invalid gateway token");
  });
});

describe("mutation origin validation", () => {
  it("accepts an exact same-origin mutation", () => {
    const request = new Request("https://axiom.test/api/auth/logout", {
      method: "POST",
      headers: { origin: "https://axiom.test" },
    });

    expect(() => auth.assertSameOrigin(request)).not.toThrow();
  });

  it("uses the public host when a framework canonicalizes the request URL", () => {
    const request = new Request("http://localhost:3100/api/auth/session", {
      method: "POST",
      headers: {
        host: "localhost:3100",
        origin: "http://127.0.0.1:3100",
        "x-forwarded-host": "127.0.0.1:3100",
        "x-forwarded-proto": "http",
      },
    });

    expect(() => auth.assertSameOrigin(request)).not.toThrow();
  });

  it("rejects missing, malformed, and cross-origin origins", () => {
    const requests = [
      new Request("https://axiom.test/api/auth/logout", { method: "POST" }),
      new Request("https://axiom.test/api/auth/logout", {
        method: "POST",
        headers: { origin: "not a url" },
      }),
      new Request("https://axiom.test/api/auth/logout", {
        method: "POST",
        headers: { origin: "https://attacker.test" },
      }),
    ];

    for (const request of requests) {
      expect(() => auth.assertSameOrigin(request)).toThrowError(auth.AuthError);
      try {
        auth.assertSameOrigin(request);
      } catch (error) {
        expect((error as AuthError).status).toBe(403);
      }
    }
  });
});

describe("session configuration", () => {
  it("does not depend on a shared cookie-signing secret", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("SESSION_SECRET", "");
    expect(() => auth.assertSessionConfiguration()).not.toThrow();

    vi.stubEnv("SESSION_SECRET", "short");
    expect(() => auth.assertSessionConfiguration()).not.toThrow();
  });
});

describe("cookie policy", () => {
  it("uses an HttpOnly, Strict, host-wide cookie", () => {
    expect(auth.sessionCookieOptions(false)).toMatchObject({
      httpOnly: true,
      sameSite: "strict",
      secure: false,
      path: "/",
      maxAge: auth.SESSION_TTL_SECONDS,
    });
    expect(auth.sessionCookieOptions(true).secure).toBe(true);
  });
});
