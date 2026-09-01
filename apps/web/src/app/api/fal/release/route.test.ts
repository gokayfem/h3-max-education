import { AuthError } from "@/lib/server/auth";
import type * as AuthModule from "@/lib/server/auth";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { requireMutationSession, getActiveState, releaseVisualEntitlement } = vi.hoisted(() => ({
  requireMutationSession: vi.fn(),
  getActiveState: vi.fn(),
  releaseVisualEntitlement: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/server/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof AuthModule>()),
  requireMutationSession,
}));
vi.mock("@/lib/server/session/runtime", () => ({
  getPersistenceServicesFromEnv: () => ({ sessions: { getActiveState, releaseVisualEntitlement } }),
}));

import { POST } from "./route";

const SESSION_ID = "00000000-0000-4000-8000-000000000081";
const RESERVATION_ID = "00000000-0000-4000-8000-000000000082";
const learner = { learnerId: "lrn_1234567890abcdef", ageBand: "13-15" };
const activeState = {
  revision: 3,
  status: "text_only",
  learnerId: learner.learnerId,
  startedAt: "2026-08-31T12:00:00.000Z",
  updatedAt: "2026-08-31T12:00:00.000Z",
  turnCount: 0,
  concepts: [],
  explorationEdges: [],
  mastery: [],
  cards: null,
  visual: null,
  lastEvents: [],
};
function request(body: unknown): Request {
  return new Request("http://localhost/api/fal/release", {
    method: "POST",
    headers: { origin: "http://localhost", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
const body = { sessionId: SESSION_ID, reservationId: RESERVATION_ID };

describe("POST /api/fal/release", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    requireMutationSession.mockReset().mockResolvedValue(learner);
    getActiveState.mockReset().mockResolvedValue(activeState);
    releaseVisualEntitlement.mockReset().mockResolvedValue({ remainingSeconds: 110 });
  });
  afterEach(() => vi.unstubAllEnvs());

  it("releases only the authenticated learner's bound reservation and returns its budget", async () => {
    vi.stubEnv("DAILY_VIDEO_SECONDS", "150");
    const response = await POST(request(body));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store, private");
    await expect(response.json()).resolves.toEqual({ remainingSeconds: 110, dailyLimitSeconds: 150 });
    expect(releaseVisualEntitlement).toHaveBeenCalledWith(
      learner.learnerId,
      SESSION_ID,
      RESERVATION_ID,
      false,
      150,
    );
  });

  it("requires mutation authorization before release", async () => {
    requireMutationSession.mockRejectedValueOnce(new AuthError(403, "invalid_origin", "Forbidden."));
    expect((await POST(request(body))).status).toBe(403);
    expect(releaseVisualEntitlement).not.toHaveBeenCalled();
  });

  it("does not release a reservation for another learner", async () => {
    getActiveState.mockResolvedValueOnce({ ...activeState, learnerId: "lrn_other_123456789" });
    expect((await POST(request(body))).status).toBe(404);
    expect(releaseVisualEntitlement).not.toHaveBeenCalled();
  });

  it.each([
    [{ ...body, reservationId: "bad" }],
    [{ ...body, extra: true }],
  ])("rejects invalid release boundaries", async (invalidBody) => {
    expect((await POST(request(invalidBody))).status).toBe(400);
    expect(releaseVisualEntitlement).not.toHaveBeenCalled();
  });

  it("bounds chunked release bodies before registry work", async () => {
    const stream = new ReadableStream<string>({
      start(controller) {
        controller.enqueue("x".repeat(17_000));
        controller.close();
      },
    }).pipeThrough(new TextEncoderStream());
    const oversized = new Request("http://localhost/api/fal/release", {
      method: "POST",
      headers: { origin: "http://localhost", "content-type": "application/json" },
      body: stream,
      duplex: "half",
    } as RequestInit & { duplex: "half" });

    const response = await POST(oversized);
    expect(response.status).toBe(413);
    expect(releaseVisualEntitlement).not.toHaveBeenCalled();
  });

  it("fails closed on invalid budget configuration before releasing", async () => {
    vi.stubEnv("DAILY_VIDEO_SECONDS", "0");
    const response = await POST(request(body));
    expect(response.status).toBe(502);
    expect(releaseVisualEntitlement).not.toHaveBeenCalled();
  });

  it("fails closed on a real registry outage", async () => {
    releaseVisualEntitlement.mockRejectedValueOnce(new Error("redis secret"));
    const response = await POST(request(body));
    expect(response.status).toBe(502);
    await expect(response.text()).resolves.not.toContain("redis secret");
  });
});
