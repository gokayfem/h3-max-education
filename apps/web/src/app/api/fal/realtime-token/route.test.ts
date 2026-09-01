import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireMutationSession: vi.fn(),
  getActiveState: vi.fn(),
  reserveRealtimeCall: vi.fn(),
  replaceRealtimeCall: vi.fn(),
  activateRealtimeCall: vi.fn(),
  releaseRealtimeCall: vi.fn(),
}));

vi.mock("@/lib/server/auth", () => ({
  requireMutationSession: mocks.requireMutationSession,
  authErrorResponse: () => Response.json({ error: { code: "internal_error" } }, { status: 500 }),
}));
vi.mock("@/lib/server/session/runtime", () => ({
  getPersistenceServicesFromEnv: () => ({
    sessions: {
      getActiveState: mocks.getActiveState,
      reserveRealtimeCall: mocks.reserveRealtimeCall,
      replaceRealtimeCall: mocks.replaceRealtimeCall,
      activateRealtimeCall: mocks.activateRealtimeCall,
      releaseRealtimeCall: mocks.releaseRealtimeCall,
    },
  }),
}));

import { POST } from "./route";

const sessionId = "11111111-1111-4111-8111-111111111111";
const attemptId = "22222222-2222-4222-8222-222222222222";
const leaseId = "33333333-3333-4333-8333-333333333333";
const learner = { learnerId: "lrn_abcdefghijklmnop", ageBand: "16-18" };
const activeState = {
  revision: 0,
  status: "text_only",
  learnerId: learner.learnerId,
  startedAt: "2026-08-31T00:00:00.000Z",
  updatedAt: "2026-08-31T00:00:00.000Z",
  turnCount: 0,
  concepts: [],
  explorationEdges: [],
  mastery: [],
  cards: null,
  visual: null,
  lastEvents: [],
};

function request(reconnect = false): Request {
  return new Request("http://localhost/api/fal/realtime-token", {
    method: "POST",
    headers: { origin: "http://localhost", "content-type": "application/json" },
    body: JSON.stringify({ sessionId, attemptId, reconnect }),
  });
}

describe("POST /api/fal/realtime-token", () => {
  beforeEach(() => {
    vi.stubEnv("FAL_KEY", "server-only-key");
    mocks.requireMutationSession.mockResolvedValue(learner);
    mocks.getActiveState.mockResolvedValue(activeState);
    mocks.reserveRealtimeCall.mockResolvedValue({ allowed: true, leaseId });
    mocks.replaceRealtimeCall.mockResolvedValue({ allowed: true, leaseId });
    mocks.activateRealtimeCall.mockResolvedValue(true);
    mocks.releaseRealtimeCall.mockResolvedValue(true);
    vi.stubGlobal("fetch", vi.fn(async () => Response.json("fal-short-lived-token")));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("mints an authenticated token restricted to Grok Voice", async () => {
    const response = await POST(request());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ token: "fal-short-lived-token", expiresInSeconds: 120 });
    expect(fetch).toHaveBeenCalledWith(
      "https://rest.fal.ai/tokens/realtime",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: "Key server-only-key" }),
        body: JSON.stringify({ app: "xai/grok-voice/realtime", duration: 120 }),
      }),
    );
    expect(mocks.activateRealtimeCall).toHaveBeenCalledWith(
      learner.learnerId,
      sessionId,
      leaseId,
      `rtc_fal_${leaseId.replaceAll("-", "")}`,
    );
    expect(mocks.requireMutationSession).toHaveBeenCalledWith(expect.any(Request));
    expect(mocks.reserveRealtimeCall).toHaveBeenCalledWith(
      learner.learnerId,
      sessionId,
      attemptId,
    );
  });

  it("releases admission when fal token minting fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "unavailable" }, { status: 503 })));

    const response = await POST(request());

    expect(response.status).toBe(503);
    expect(mocks.releaseRealtimeCall).toHaveBeenCalledWith(learner.learnerId, leaseId);
  });

  it("releases admission when activation fails", async () => {
    mocks.activateRealtimeCall.mockResolvedValue(false);

    const response = await POST(request());

    expect(response.status).toBe(503);
    expect(mocks.releaseRealtimeCall).toHaveBeenCalledWith(learner.learnerId, leaseId);
  });

  it("does not mint a token when bounded realtime admission is full", async () => {
    mocks.reserveRealtimeCall.mockResolvedValue({
      allowed: false,
      reason: "realtime_capacity",
      retryAfterSeconds: 15,
    });

    const response = await POST(request());

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("15");
    expect(fetch).not.toHaveBeenCalled();
    expect(mocks.activateRealtimeCall).not.toHaveBeenCalled();
  });

  it("uses replacement admission for reconnects", async () => {
    const response = await POST(request(true));

    expect(response.status).toBe(200);
    expect(mocks.replaceRealtimeCall).toHaveBeenCalledWith(learner.learnerId, sessionId, attemptId);
    expect(mocks.reserveRealtimeCall).not.toHaveBeenCalled();
  });
});
