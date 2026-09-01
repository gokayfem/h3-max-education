import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SESSION_COOKIE_NAME } from "@/lib/server/auth";
import { SessionServiceError } from "@/lib/server/session/service";
import {
  buildTutorInstructions,
  TUTOR_TOOL_DEFINITIONS,
  tutorToolCallSchema,
} from "@axiom/protocol";

const REALTIME_ATTEMPT_ID = "22222222-2222-4222-8222-222222222222";

const {
  authorizeActiveSession,
  recover,
  readFanout,
  getAuthSessionLearner,
  getProfile,
  reserveRealtimeCall,
  replaceRealtimeCall,
  releaseRealtimeCall,
  releaseRealtimeSession,
  activateRealtimeCall,
  getActiveRealtimeCall,
} = vi.hoisted(() => ({
  authorizeActiveSession: vi.fn(),
  recover: vi.fn(),
  readFanout: vi.fn(),
  getAuthSessionLearner: vi.fn(),
  getProfile: vi.fn(),
  reserveRealtimeCall: vi.fn(),
  replaceRealtimeCall: vi.fn(),
  releaseRealtimeCall: vi.fn(),
  releaseRealtimeSession: vi.fn(),
  activateRealtimeCall: vi.fn(),
  getActiveRealtimeCall: vi.fn(),
}));
vi.mock("@/lib/server/session/runtime", () => ({
  createSessionServiceFromEnv: () => ({ authorizeActiveSession, recover }),
  getPersistenceServicesFromEnv: () => ({
    repository: { getProfile },
    sessions: {
      getAuthSessionLearner,
      reserveRealtimeCall,
      replaceRealtimeCall,
      releaseRealtimeCall,
      releaseRealtimeSession,
      activateRealtimeCall,
      getActiveRealtimeCall,
      readFanout,
    },
  }),
}));
import { POST, proxyRealtimeCall } from "./route";


beforeEach(() => {
  vi.clearAllMocks();
  authorizeActiveSession.mockResolvedValue({ revision: 0 });
  recover.mockRejectedValue(new Error("Realtime route must not recover session state"));
  readFanout.mockRejectedValue(new Error("Realtime route must not read fanout"));
  getAuthSessionLearner.mockResolvedValue("lrn_abcdefghijklmnop");
  getProfile.mockResolvedValue({
    learnerId: "lrn_abcdefghijklmnop",
    displayName: "Test Learner",
    ageBand: "13-15",
  });
  reserveRealtimeCall.mockResolvedValue({
    allowed: true,
    leaseId: "44444444-4444-4444-8444-444444444444",
  });
  replaceRealtimeCall.mockResolvedValue({
    allowed: true,
    leaseId: "55555555-5555-4555-8555-555555555555",
  });
  releaseRealtimeCall.mockResolvedValue(undefined);
  releaseRealtimeSession.mockResolvedValue(true);
  activateRealtimeCall.mockResolvedValue(true);
  getActiveRealtimeCall.mockResolvedValue({ commandRevision: 7 });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

async function authenticatedRequest(
  headers: Record<string, string>,
  body = "v=0\r\n",
  includeAttemptId = true,
) {
  const token = "11111111-1111-4111-8111-111111111111";
  return new Request("http://localhost/api/openai/realtime", {
    method: "POST",
    headers: {
      origin: "http://localhost",
      cookie: `${SESSION_COOKIE_NAME}=${token}`,
      "content-type": "application/sdp",
      "x-axiom-session-id": "33333333-3333-4333-8333-333333333333",
      ...(includeAttemptId ? { "x-axiom-realtime-attempt": REALTIME_ATTEMPT_ID } : {}),
      ...headers
    },
    body
  });
}

describe("POST /api/openai/realtime", () => {
  it("authenticates and returns the recoverable typed response when OpenAI is not configured", async () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    const response = await POST(await authenticatedRequest({}));

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      mode: "text",
      recoverable: true,
      code: "OPENAI_NOT_CONFIGURED",
    });
  });

  it.each([
    {
      name: "wrong content type",
      headers: { "content-type": "application/json" },
      body: "v=0\r\n",
      status: 415,
    },
    {
      name: "invalid session id",
      headers: { "x-axiom-session-id": "not-a-uuid" },
      body: "v=0\r\n",
      status: 400,
    },
    {
      name: "oversized declared body",
      headers: { "content-length": "100001" },
      body: "v=0\r\n",
      status: 413,
    },
    {
      name: "malformed SDP",
      headers: {},
      body: "not-sdp",
      status: 400,
    },
  ])("rejects $name", async ({ headers, body, status }) => {
    const response = await POST(
      await authenticatedRequest(headers as Record<string, string>, body),
    );
    expect(response.status).toBe(status);
  });

  it.each([
    ["missing", {}, false],
    ["malformed", { "x-axiom-realtime-attempt": "not-a-uuid" }, true],
  ])("rejects a $name realtime attempt id before admission", async (_name, headers, includeAttemptId) => {
    const response = await POST(
      await authenticatedRequest(headers as Record<string, string>, "v=0\r\n", includeAttemptId),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: "invalid_realtime_attempt" },
    });
    expect(reserveRealtimeCall).not.toHaveBeenCalled();
  });

  it.each([
    ["without a Content-Length (chunked semantics)", {}],
    ["with a lying smaller Content-Length", { "content-length": "6" }],
  ])("rejects an oversized actual SDP body $name", async (_name, headers) => {
    const response = await POST(
      await authenticatedRequest(headers as Record<string, string>, `v=0\r\n${"x".repeat(100_000)}`),
    );

    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({
      error: { code: "request_too_large" },
    });
  });

  it("rejects cross-origin mutation attempts before reading SDP", async () => {
    const request = await authenticatedRequest({ origin: "https://attacker.example" });
    const response = await POST(request);
    expect(response.status).toBe(403);
  });

  it("rejects missing ownership before reserving or contacting the provider", async () => {
    vi.stubEnv("OPENAI_API_KEY", "provider-key");
    authorizeActiveSession.mockRejectedValueOnce(
      new SessionServiceError(404, "session_not_found", "The session was not found."),
    );
    const providerFetch = vi.spyOn(globalThis, "fetch");

    const response = await POST(await authenticatedRequest({}));

    expect(response.status).toBe(404);
    expect(reserveRealtimeCall).not.toHaveBeenCalled();
    expect(providerFetch).not.toHaveBeenCalled();
  });

  it("fails closed before provider fanout when the session registry is unavailable", async () => {
    vi.stubEnv("OPENAI_API_KEY", "provider-key");
    authorizeActiveSession.mockRejectedValueOnce(new Error("redis://credential"));
    const providerFetch = vi.spyOn(globalThis, "fetch");
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = await POST(await authenticatedRequest({}));
    expect(response.status).toBe(500);
    await expect(response.text()).resolves.not.toContain("redis://credential");
    expect(reserveRealtimeCall).not.toHaveBeenCalled();
    expect(providerFetch).not.toHaveBeenCalled();
  });

  it("enforces learner admission before provider calls", async () => {
    vi.stubEnv("OPENAI_API_KEY", "provider-key");
    reserveRealtimeCall.mockResolvedValueOnce({
      allowed: false,
      reason: "concurrency_limit",
      retryAfterSeconds: 17,
    });
    const providerFetch = vi.spyOn(globalThis, "fetch");

    const response = await POST(await authenticatedRequest({}));

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("17");
    expect(providerFetch).not.toHaveBeenCalled();
    expect(releaseRealtimeCall).not.toHaveBeenCalled();
  });

  it("releases the admission lease when provider negotiation fails", async () => {
    vi.stubEnv("OPENAI_API_KEY", "provider-key");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("provider busy", { status: 503 }),
    );

    const response = await POST(await authenticatedRequest({}));

    expect(response.status).toBe(503);
    expect(releaseRealtimeCall).toHaveBeenCalledWith(
      "lrn_abcdefghijklmnop",
      "44444444-4444-4444-8444-444444444444",
    );
  });

  it.each(["returns false", "throws", "succeeds without an active ticket mapping"])(
    "releases realtime session and admission lease when activation $s",
    async (outcome) => {
      vi.stubEnv("OPENAI_API_KEY", "provider-key");
      if (outcome === "throws") {
        activateRealtimeCall.mockRejectedValueOnce(new Error("registry unavailable"));
      } else if (outcome === "returns false") {
        activateRealtimeCall.mockResolvedValueOnce(false);
      } else {
        getActiveRealtimeCall.mockResolvedValueOnce(undefined);
      }
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response("answer", {
          status: 201,
          headers: { location: "https://api.openai.com/v1/realtime/calls/rtc_activation-failed-1234" },
        }),
      );

      const response = await POST(await authenticatedRequest({}));

      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({
        mode: "text",
        recoverable: true,
        code: "REALTIME_ACTIVATION_FAILED",
      });
      expect(releaseRealtimeSession).toHaveBeenCalledWith(
        "33333333-3333-4333-8333-333333333333",
      );
      expect(releaseRealtimeCall).toHaveBeenCalledWith(
        "lrn_abcdefghijklmnop",
        "44444444-4444-4444-8444-444444444444",
      );
    },
  );

  it("keeps a successful provider lease active through the application session lifecycle", async () => {
    vi.stubEnv("OPENAI_API_KEY", "provider-key");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("answer", {
        status: 201,
        headers: { location: "https://api.openai.com/v1/realtime/calls/rtc_active-call-1234" },
      }),
    );

    const response = await POST(await authenticatedRequest({}));

    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store, private");
    expect(response.headers.get("x-axiom-gateway-ticket")).toMatch(
      /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u,
    );
    expect(response.headers.get("x-axiom-command-revision")).toBe("7");
    expect(reserveRealtimeCall).toHaveBeenCalledWith(
      "lrn_abcdefghijklmnop",
      "33333333-3333-4333-8333-333333333333",
      REALTIME_ATTEMPT_ID,
    );
    expect(activateRealtimeCall).toHaveBeenCalledWith(
      "lrn_abcdefghijklmnop",
      "33333333-3333-4333-8333-333333333333",
      "44444444-4444-4444-8444-444444444444",
      "rtc_active-call-1234",
    );
    expect(releaseRealtimeCall).not.toHaveBeenCalled();
    expect(releaseRealtimeSession).not.toHaveBeenCalled();
    expect(authorizeActiveSession).toHaveBeenCalledWith(
      expect.objectContaining({ learnerId: "lrn_abcdefghijklmnop" }),
      "33333333-3333-4333-8333-333333333333",
    );
    expect(recover).not.toHaveBeenCalled();
    expect(readFanout).not.toHaveBeenCalled();
  });

  it("atomically replaces the active lease for an authorized reconnect", async () => {
    vi.stubEnv("OPENAI_API_KEY", "provider-key");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("answer", {
        status: 201,
        headers: { location: "https://api.openai.com/v1/realtime/calls/rtc_reconnected-call-1234" },
      }),
    );

    const response = await POST(
      await authenticatedRequest({ "x-axiom-realtime-reconnect": "1" }),
    );

    expect(response.status).toBe(201);
    expect(replaceRealtimeCall).toHaveBeenCalledWith(
      "lrn_abcdefghijklmnop",
      "33333333-3333-4333-8333-333333333333",
      REALTIME_ATTEMPT_ID,
    );
    expect(reserveRealtimeCall).not.toHaveBeenCalled();
    expect(activateRealtimeCall).toHaveBeenCalledWith(
      "lrn_abcdefghijklmnop",
      "33333333-3333-4333-8333-333333333333",
      "55555555-5555-4555-8555-555555555555",
      "rtc_reconnected-call-1234",
    );
  });

  it("denies replacing an active call from a different authorized session", async () => {
    vi.stubEnv("OPENAI_API_KEY", "provider-key");
    replaceRealtimeCall.mockResolvedValueOnce({
      allowed: false,
      reason: "concurrency_limit",
      retryAfterSeconds: 30,
    });
    const providerFetch = vi.spyOn(globalThis, "fetch");

    const response = await POST(await authenticatedRequest({
      "x-axiom-session-id": "55555555-5555-4555-8555-555555555555",
      "x-axiom-realtime-reconnect": "1",
    }));

    expect(response.status).toBe(429);
    expect(replaceRealtimeCall).toHaveBeenCalledWith(
      "lrn_abcdefghijklmnop",
      "55555555-5555-4555-8555-555555555555",
      REALTIME_ATTEMPT_ID,
    );
    expect(providerFetch).not.toHaveBeenCalled();
  });

  it("denies reconnect after the session becomes terminal", async () => {
    vi.stubEnv("OPENAI_API_KEY", "provider-key");
    authorizeActiveSession.mockRejectedValueOnce(
      new SessionServiceError(409, "session_ended", "Reconnect denied."),
    );

    const response = await POST(
      await authenticatedRequest({ "x-axiom-realtime-reconnect": "1" }),
    );

    expect(response.status).toBe(409);
    expect(replaceRealtimeCall).not.toHaveBeenCalled();
  });

  it("releases the replacement lease when reconnect provider negotiation fails", async () => {
    vi.stubEnv("OPENAI_API_KEY", "provider-key");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("provider busy", { status: 503 }),
    );

    const response = await POST(
      await authenticatedRequest({ "x-axiom-realtime-reconnect": "1" }),
    );

    expect(response.status).toBe(503);
    expect(releaseRealtimeCall).toHaveBeenCalledWith(
      "lrn_abcdefghijklmnop",
      "55555555-5555-4555-8555-555555555555",
    );
  });

  it("rejects any reconnect marker other than the bounded value", async () => {
    const response = await POST(
      await authenticatedRequest({ "x-axiom-realtime-reconnect": "true" }),
    );

    expect(response.status).toBe(400);
    expect(replaceRealtimeCall).not.toHaveBeenCalled();
    expect(reserveRealtimeCall).not.toHaveBeenCalled();
  });
});

describe("proxyRealtimeCall", () => {
  it("returns a recoverable typed mode without contacting OpenAI when the key is absent", async () => {
    const fetchImplementation = vi.fn();

    const response = await proxyRealtimeCall({
      sdp: "v=0\r\n",
      learnerId: "lrn_private_identifier",
      apiKey: undefined,
      fetchImplementation
    });

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ mode: "text", recoverable: true, code: "OPENAI_NOT_CONFIGURED" });
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "network failure",
      fetchImplementation: vi.fn(async () => { throw new Error("offline"); }),
      code: "OPENAI_UNAVAILABLE"
    },
    {
      name: "provider rejection",
      fetchImplementation: vi.fn(async () => new Response("rejected", { status: 429 })),
      code: "OPENAI_NEGOTIATION_FAILED"
    },
    {
      name: "missing call id",
      fetchImplementation: vi.fn(async () => new Response("answer", { status: 201 })),
      code: "OPENAI_CALL_ID_MISSING"
    }
  ])("returns typed mode on $name", async ({ fetchImplementation, code }) => {
    const response = await proxyRealtimeCall({
      sdp: "v=0\r\n",
      learnerId: "lrn_private_identifier",
      apiKey: "server-secret-key",
      model: "gpt-realtime-test",
      fetchImplementation
    });

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ mode: "text", recoverable: true, code });
  });

  it("uses multipart unified calls and a stable privacy-safe safety identifier", async () => {
    const requests: Array<{ headers: Headers; body: FormData }> = [];
    const fetchImplementation = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      requests.push({ headers: new Headers(init?.headers), body: init?.body as FormData });
      return new Response("answer-sdp", {
        status: 201,
        headers: { "content-type": "application/sdp", location: "/v1/realtime/calls/rtc_test-call-1234" }
      });
    });
    const input = {
      sdp: "v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\n",
      learnerId: "lrn_private_identifier",
      ageBand: "13-15" as const,
      apiKey: "server-secret-key",
      fetchImplementation
    };

    const first = await proxyRealtimeCall(input);
    await proxyRealtimeCall(input);

    expect(await first.text()).toBe("answer-sdp");
    expect(first.headers.get("x-axiom-openai-call-id")).toBe("rtc_test-call-1234");
    expect(requests[0]?.body.get("sdp")).toBe(input.sdp);
    expect(requests[0]?.body.get("session")).toEqual(expect.any(String));
    expect(requests[0]?.headers.get("authorization")).toBe("Bearer server-secret-key");
    const safetyIdentifiers = requests.map(({ headers }) => headers.get("openai-safety-identifier"));
    expect(safetyIdentifiers[0]).toBe(safetyIdentifiers[1]);
    expect(requests[0]?.headers.get("openai-beta")).toBeNull();
    const realtimeSession = JSON.parse(String(requests[0]?.body.get("session"))) as {
      instructions: string;
      output_modalities: string[];
      audio: { output: { voice: string } };
      tools: unknown;
    };
    expect(realtimeSession.instructions).toBe(
      buildTutorInstructions("Authenticated learner age band: 13-15."),
    );
    expect(realtimeSession.instructions).toContain("Age adaptation and pedagogy:");
    expect(realtimeSession.instructions).toContain("Safety:");
    expect(realtimeSession.instructions).toContain("Conversation and tool rules:");
    expect(realtimeSession.instructions).toContain("Learner memory:");
    expect(realtimeSession.output_modalities).toEqual(["audio"]);
    expect(realtimeSession.audio.output).toEqual({ voice: "marin" });
    expect(realtimeSession.tools).toEqual(TUTOR_TOOL_DEFINITIONS);
    expect(safetyIdentifiers[0]).not.toContain(input.learnerId);
  });

  it.each([
    ["show_visual", {
      concept: "orbital motion",
      teachingIntent: "Connect tangential velocity to a curved path.",
      visualDescription: "A moving body and its velocity vector orbit a central body.",
      continuityKey: "orbit"
    }],
    ["present_cards", {
      purpose: "predict",
      prompt: "What happens next?",
      cards: [{ title: "Faster", description: "Its speed increases." }]
    }],
    ["record_learning_evidence", {
      concept: "orbital motion",
      evidence: "The learner correctly predicted the direction of acceleration.",
      confidenceDelta: 0.2
    }],
    ["stop_visual", { reason: "complete" }]
  ])("advertises a %s payload accepted by runtime validation", (name, arguments_) => {
    const advertisedTool = TUTOR_TOOL_DEFINITIONS.find((tool) => tool.name === name);
    expect(advertisedTool).toBeDefined();
    expect(tutorToolCallSchema.safeParse({ name, arguments: arguments_ }).success).toBe(true);
  });

  it("advertises nonblank patterns for every free-text tool field and no model card ids", () => {
    const advertisedSchemas = JSON.stringify(TUTOR_TOOL_DEFINITIONS);
    expect(advertisedSchemas.match(/"pattern":"\\\\S"/gu)).toHaveLength(12);
    const presentCards = TUTOR_TOOL_DEFINITIONS.find((tool) => tool.name === "present_cards");
    const presentCardsSchema = JSON.stringify(presentCards?.parameters);
    expect(presentCardsSchema).not.toContain("\"id\"");
  });
});
