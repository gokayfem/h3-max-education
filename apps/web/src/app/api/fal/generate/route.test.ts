import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PERMANENT_VIDEO_STYLE } from "@axiom/domain";

const mocks = vi.hoisted(() => ({
  requireMutationSession: vi.fn(),
  getActiveState: vi.fn(),
  claimVisualEntitlement: vi.fn(),
  claimVisualIcePermit: vi.fn(),
  releaseVisualEntitlement: vi.fn(),
  getVisualDailyRemaining: vi.fn(),
  subscribe: vi.fn(),
}));

vi.mock("@/lib/server/auth", () => ({
  AuthError: class AuthError extends Error {},
  AuthRegistryUnavailable: class AuthRegistryUnavailable extends Error {},
  requireMutationSession: mocks.requireMutationSession,
  authErrorResponse: () =>
    Response.json({ error: { code: "internal_error" } }, { status: 500 }),
}));
vi.mock("@/lib/server/session/runtime", () => ({
  getPersistenceServicesFromEnv: () => ({
    sessions: {
      getActiveState: mocks.getActiveState,
      claimVisualIcePermit: mocks.claimVisualIcePermit,
      claimVisualEntitlement: mocks.claimVisualEntitlement,
      releaseVisualEntitlement: mocks.releaseVisualEntitlement,
      getVisualDailyRemaining: mocks.getVisualDailyRemaining,
    },
  }),
}));
vi.mock("@fal-ai/client", () => ({
  createFalClient: () => ({ subscribe: mocks.subscribe }),
}));

import { POST } from "./route";

const learner = { learnerId: "learner-1", ageBand: "16-18" };
const sessionId = "11111111-1111-4111-8111-111111111111";
const reservationId = "22222222-2222-4222-8222-222222222222";
const body = {
  sessionId,
  reservationId,
  durationSeconds: 5,
  prompt: `${PERMANENT_VIDEO_STYLE} Scientific subject: Heat increases molecular motion inside a sealed gas. Create a fresh, exactly 5-second, 16:9 scientific animation of only this subject. Keep the film text-free, centered, and fully illustrated.`,
};

function request(input: Record<string, unknown> = body): Request {
  return new Request("http://localhost/api/fal/generate", {
    method: "POST",
    headers: { origin: "http://localhost", "content-type": "application/json" },
    body: JSON.stringify(input),
  });
}

describe("POST /api/fal/generate", () => {
  beforeEach(() => {
    vi.stubEnv("FAL_KEY", "server-only-key");
    mocks.requireMutationSession.mockResolvedValue(learner);
    mocks.getActiveState.mockResolvedValue({
      learnerId: learner.learnerId,
      status: "text_only",
    });
    mocks.claimVisualIcePermit.mockResolvedValue(true);
    mocks.claimVisualEntitlement.mockResolvedValue(true);
    mocks.releaseVisualEntitlement.mockResolvedValue(undefined);
    mocks.getVisualDailyRemaining.mockResolvedValue(115);
    mocks.subscribe.mockResolvedValue({
      data: { video: { url: "https://v3.fal.media/files/science.mp4" } },
      requestId: "fal-request-1",
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it("sends one compact styled subject directly to fast H3 generation", async () => {
    const response = await POST(request());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      videoUrl: "https://v3.fal.media/files/science.mp4",
      remainingSeconds: 115,
      dailyLimitSeconds: 120,
    });
    expect(mocks.subscribe).toHaveBeenCalledOnce();
    expect(mocks.subscribe).toHaveBeenCalledWith(
      "minimax/h3-max/text-to-video",
      expect.objectContaining({
        input: {
          prompt: expect.any(String),
          sync_mode: false,
          resolution: "480P",
          duration: 5,
          aspect_ratio: "16:9",
          prompt_expansion_mode: "balanced",
          enable_safety_checker: true,
        },
      }),
    );

    const generation = mocks.subscribe.mock.calls[0]?.[1] as {
      input: { prompt: string };
    };
    expect(generation.input.prompt).toContain(
      "premium mixed 2D illustrated motion language",
    );
    expect(generation.input.prompt).toContain(body.prompt);
    expect(generation.input.prompt).toContain(
      "fresh, exactly 5-second, 16:9 scientific animation",
    );
    expect(generation.input.prompt).toContain("Keep the film text-free");
    expect(generation.input.prompt.length).toBeLessThan(2_000);
    expect(
      mocks.subscribe.mock.calls.some(([model]) => model === "openrouter/router"),
    ).toBe(false);
    expect(mocks.releaseVisualEntitlement).toHaveBeenCalledWith(
      learner.learnerId,
      sessionId,
      reservationId,
      false,
      120,
    );
  });

  it("rejects legacy context and oversized subjects before provider work", async () => {
    const legacyResponse = await POST(request({
      ...body,
      previousPrompt: "A previous generated prompt that should no longer be sent.",
    }));
    const oversizedResponse = await POST(request({
      ...body,
      prompt: `${PERMANENT_VIDEO_STYLE} ${"x".repeat(2_001)}`,
    }));

    expect(legacyResponse.status).toBe(400);
    expect(oversizedResponse.status).toBe(400);
    expect(mocks.subscribe).not.toHaveBeenCalled();
  });


  it("returns unavailable before storage work when queued generation is disabled", async () => {
    vi.stubEnv("FAL_KEY", "");

    const response = await POST(request());

    expect(response.status).toBe(503);
    expect(mocks.getActiveState).not.toHaveBeenCalled();
    expect(mocks.subscribe).not.toHaveBeenCalled();
  });

  it.each([
    ["missing state", null],
    ["another learner", { learnerId: "learner-2", status: "text_only" }],
    ["ended state", { learnerId: learner.learnerId, status: "ended" }],
  ])("rejects %s before claiming generation budget", async (_label, state) => {
    mocks.getActiveState.mockResolvedValueOnce(state);

    const response = await POST(request());

    expect(response.status).toBe(404);
    expect(mocks.claimVisualIcePermit).not.toHaveBeenCalled();
    expect(mocks.subscribe).not.toHaveBeenCalled();
  });

  it("denies generation when either queue permit or entitlement is unavailable", async () => {
    mocks.claimVisualIcePermit.mockResolvedValueOnce(false);
    const permitResponse = await POST(request());

    mocks.claimVisualEntitlement.mockResolvedValueOnce(false);
    const entitlementResponse = await POST(request());

    expect(permitResponse.status).toBe(403);
    expect(entitlementResponse.status).toBe(403);
    expect(mocks.subscribe).not.toHaveBeenCalled();
  });
  it("rolls back the reservation when generation fails", async () => {
    mocks.subscribe.mockRejectedValueOnce(new Error("provider unavailable"));

    const response = await POST(request());

    expect(response.status).toBe(502);
    expect(mocks.releaseVisualEntitlement).toHaveBeenCalledWith(
      learner.learnerId,
      sessionId,
      reservationId,
      true,
      120,
    );
  });
});
