import { createHmac, timingSafeEqual } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SESSION_COOKIE_NAME } from "@/lib/server/auth";

const { getActiveRealtimeCall, getAuthSessionLearner, getProfile } = vi.hoisted(() => ({
  getActiveRealtimeCall: vi.fn(),
  getAuthSessionLearner: vi.fn(),
  getProfile: vi.fn(),
}));
vi.mock("@/lib/server/session/runtime", () => ({
  getPersistenceServicesFromEnv: () => ({
    repository: { getProfile },
    sessions: { getActiveRealtimeCall, getAuthSessionLearner },
  }),
}));

import { POST } from "./route";

const URL = "https://science.example/api/gateway-token";
const SESSION_ID = "33333333-3333-4333-8333-333333333333";
const OTHER_SESSION_ID = "55555555-5555-4555-8555-555555555555";
const SESSION_SECRET = "web-session-secret-that-is-at-least-32-characters";
const GATEWAY_SECRET = "distinct-gateway-secret-at-least-32-characters";
const CALL_ID = "rtc_test-call-1234";

async function cookie(): Promise<string> {
  return `${SESSION_COOKIE_NAME}=11111111-1111-4111-8111-111111111111`;
}

async function request(
  sessionId = SESSION_ID,
  origin = "https://science.example",
  callId = CALL_ID,
): Promise<Request> {
  return new Request(URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin,
      cookie: await cookie(),
    },
    body: JSON.stringify({ sessionId, callId }),
  });
}

describe("POST /api/gateway-token", () => {
  beforeEach(() => {
    vi.stubEnv("SESSION_SECRET", SESSION_SECRET);
    getAuthSessionLearner.mockResolvedValue("lrn_abcdefghijklmnop");
    getProfile.mockResolvedValue({
      learnerId: "lrn_abcdefghijklmnop",
      displayName: "Ada",
      ageBand: "16-18",
    });
    vi.stubEnv("GATEWAY_AUTH_SECRET", GATEWAY_SECRET);
    getActiveRealtimeCall.mockImplementation(
      async (learnerId: string, sessionId: string, callId: string) => (
        learnerId === "lrn_abcdefghijklmnop"
        && sessionId === SESSION_ID
        && callId === CALL_ID
          ? { commandRevision: 7 }
          : undefined
      ),
    );
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it("requires an authenticated same-origin mutation", async () => {
    const unauthenticated = new Request(URL, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://science.example" },
      body: JSON.stringify({ sessionId: SESSION_ID }),
    });

    expect((await POST(unauthenticated)).status).toBe(401);
    expect((await POST(await request(SESSION_ID, "https://attacker.example"))).status).toBe(403);
    expect(getActiveRealtimeCall).not.toHaveBeenCalled();
  });

  it("rejects a call identity that cannot be an activated provider call", async () => {
    const response = await POST(await request(SESSION_ID, "https://science.example", "call_unbound"));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "invalid_request" },
    });
    expect(getActiveRealtimeCall).not.toHaveBeenCalled();
  });

  it("mints distinct sixty-second tickets bound to the learner and active session", async () => {
    const issuedAfterSeconds = Math.floor(Date.now() / 1_000) + 60;
    const first = await POST(await request());
    const second = await POST(await request());
    const firstBody = await first.json() as { token: string; commandRevision: number };
    const secondBody = await second.json() as { token: string; commandRevision: number };

    expect(first.status).toBe(200);
    expect(first.headers.get("cache-control")).toBe("no-store, private");
    expect(firstBody.commandRevision).toBe(7);
    expect(firstBody.token).not.toBe(secondBody.token);
    expect(firstBody.token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u);
    const [payloadSegment, signatureSegment] = firstBody.token.split(".");
    const supplied = Buffer.from(signatureSegment, "base64url");
    const gatewaySignature = createHmac("sha256", GATEWAY_SECRET)
      .update(payloadSegment)
      .digest();
    const sessionSignature = createHmac("sha256", SESSION_SECRET)
      .update(payloadSegment)
      .digest();
    const payload = JSON.parse(
      Buffer.from(payloadSegment, "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    expect(timingSafeEqual(supplied, gatewaySignature)).toBe(true);
    expect(timingSafeEqual(supplied, sessionSignature)).toBe(false);
    expect(payload).toMatchObject({
      v: 1,
      learnerId: "lrn_abcdefghijklmnop",
      sessionId: SESSION_ID,
      callId: CALL_ID,
      exp: expect.any(Number),
      nonce: expect.any(String),
    });
    expect(payload.exp).toBeGreaterThanOrEqual(issuedAfterSeconds);
    expect(payload.exp).toBeLessThanOrEqual(Math.floor(Date.now() / 1_000) + 60);
    const secondPayload = JSON.parse(
      Buffer.from(secondBody.token.split(".")[0]!, "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    expect(secondPayload.nonce).not.toBe(payload.nonce);
    expect(Object.keys(payload).sort()).toEqual([
      "callId", "exp", "learnerId", "nonce", "sessionId", "v",
    ]);
    expect(getActiveRealtimeCall).toHaveBeenCalledTimes(2);
    expect(getActiveRealtimeCall).toHaveBeenCalledWith(
      "lrn_abcdefghijklmnop",
      SESSION_ID,
      CALL_ID,
    );
  });

  it("continues the shared durable command revision across typed, voice, and reload handoffs", async () => {
    getActiveRealtimeCall
      .mockResolvedValueOnce({ commandRevision: 11 })
      .mockResolvedValueOnce({ commandRevision: 14 })
      .mockResolvedValueOnce({ commandRevision: 18 });

    const typedToVoice = await POST(await request());
    const voiceToTyped = await POST(await request());
    const reloaded = await POST(await request());

    await expect(typedToVoice.json()).resolves.toMatchObject({ commandRevision: 11 });
    await expect(voiceToTyped.json()).resolves.toMatchObject({ commandRevision: 14 });
    await expect(reloaded.json()).resolves.toMatchObject({ commandRevision: 18 });
    expect(getActiveRealtimeCall).toHaveBeenCalledTimes(3);
  });

  it.each([
    ["missing mapping", SESSION_ID, CALL_ID],
    ["stale mapping", SESSION_ID, CALL_ID],
    ["terminal session with delayed call release", SESSION_ID, CALL_ID],
    ["mismatched provider call", SESSION_ID, "rtc_other-call-5678"],
    ["mapping for another session", OTHER_SESSION_ID, CALL_ID],
  ])("does not mint for a %s", async (_boundary, sessionId, callId) => {
    getActiveRealtimeCall.mockResolvedValueOnce(undefined);

    const response = await POST(await request(sessionId, "https://science.example", callId));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "realtime_call_not_active",
        message: "The realtime call is not active for this session.",
      },
    });
    expect(getActiveRealtimeCall).toHaveBeenCalledWith(
      "lrn_abcdefghijklmnop",
      sessionId,
      callId,
    );
  });

  it("does not mint for a session the learner does not own", async () => {
    getActiveRealtimeCall.mockResolvedValueOnce(undefined);

    const response = await POST(await request(OTHER_SESSION_ID));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "realtime_call_not_active" },
    });
    expect(getActiveRealtimeCall).toHaveBeenCalledWith(
      "lrn_abcdefghijklmnop",
      OTHER_SESSION_ID,
      CALL_ID,
    );
  });

  it("bounds a chunked token request before ownership lookup", async () => {
    const base = await request();
    const stream = new ReadableStream<string>({
      start(controller) {
        controller.enqueue("x".repeat(17_000));
        controller.close();
      },
    }).pipeThrough(new TextEncoderStream());
    const chunked = new Request(base.url, {
      method: "POST",
      headers: base.headers,
      body: stream,
      duplex: "half",
    } as RequestInit & { duplex: "half" });

    const response = await POST(chunked);
    expect(response.status).toBe(413);
    expect(getActiveRealtimeCall).not.toHaveBeenCalled();
  });

  it("fails closed without fanout when the ownership registry is unavailable", async () => {
    getActiveRealtimeCall.mockRejectedValueOnce(new Error("redis://credential"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = await POST(await request());
    expect(response.status).toBe(500);
    await expect(response.text()).resolves.not.toContain("redis://credential");
    expect(getActiveRealtimeCall).toHaveBeenCalledOnce();
  });
});
