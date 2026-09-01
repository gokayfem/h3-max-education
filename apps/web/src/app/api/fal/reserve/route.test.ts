import { AuthError } from "@/lib/server/auth";
import type * as AuthModule from "@/lib/server/auth";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  requireMutationSession,
  requireSession,
  getActiveState,
  getVisualDailyRemaining,
  reserveVisualEntitlement,
  commitVisualEntitlement,
  releaseVisualEntitlement,
} = vi.hoisted(() => ({
  requireMutationSession: vi.fn(),
  requireSession: vi.fn(),
  getActiveState: vi.fn(),
  getVisualDailyRemaining: vi.fn(),
  reserveVisualEntitlement: vi.fn(),
  commitVisualEntitlement: vi.fn(),
  releaseVisualEntitlement: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/server/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof AuthModule>()),
  requireMutationSession,
  requireSession,
}));
vi.mock("@/lib/server/session/runtime", () => ({
  getPersistenceServicesFromEnv: () => ({
    sessions: {
      getActiveState,
      getVisualDailyRemaining,
      reserveVisualEntitlement,
      commitVisualEntitlement,
      releaseVisualEntitlement,
    },
  }),
}));

import { GET, POST } from "./route";

const SESSION_ID = "00000000-0000-4000-8000-000000000061";
const RESERVATION_ID = "00000000-0000-4000-8000-000000000062";
const learner = { learnerId: "lrn_1234567890abcdef", ageBand: "13-15" };
const activeState = {
  revision: 2,
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
  return new Request("http://localhost/api/fal/reserve", {
    method: "POST",
    headers: { origin: "http://localhost", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
const body = { sessionId: SESSION_ID, durationSeconds: 5 };

describe("/api/fal/reserve", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.stubEnv("FAL_KEY", "server-only-key");
    requireMutationSession.mockReset().mockResolvedValue(learner);
    requireSession.mockReset().mockResolvedValue(learner);
    getActiveState.mockReset().mockResolvedValue(activeState);
    getVisualDailyRemaining.mockReset().mockResolvedValue(95);
    reserveVisualEntitlement.mockReset().mockResolvedValue({
      status: "reserved",
      reservationId: RESERVATION_ID,
      leaseExpiresInSeconds: 180,
      remainingSeconds: 30,
    });
    commitVisualEntitlement.mockReset().mockResolvedValue(true);
    releaseVisualEntitlement.mockReset().mockResolvedValue(undefined);
  });
  afterEach(() => vi.unstubAllEnvs());

  it("atomically binds the requested learner/session/duration and configured quotas", async () => {
    vi.stubEnv("DAILY_VIDEO_SECONDS", "45");
    vi.stubEnv("MAX_CONCURRENT_VISUALS", "2");
    vi.stubEnv("GLOBAL_DAILY_VIDEO_SECONDS", "900");

    const response = await POST(request(body));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store, private");
    await expect(response.json()).resolves.toEqual({
      reservationId: RESERVATION_ID,
      expiresInSeconds: 180,
      remainingSeconds: 30,
      dailyLimitSeconds: 45,
    });
    expect(reserveVisualEntitlement).toHaveBeenCalledWith({
      learnerId: learner.learnerId,
      sessionId: SESSION_ID,
      durationSeconds: 5,
      dailyLimitSeconds: 45,
      maxConcurrent: 2,
      globalDailyLimitSeconds: 900,
      leaseSeconds: 180,
    });
    expect(commitVisualEntitlement).toHaveBeenCalledWith(SESSION_ID, RESERVATION_ID);
  });

  it("replays an active reservation without committing or charging again", async () => {
    reserveVisualEntitlement.mockResolvedValueOnce({
      status: "active",
      reservationId: RESERVATION_ID,
      leaseExpiresInSeconds: 73,
      remainingSeconds: 110,
    });
    const response = await POST(request(body));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      reservationId: RESERVATION_ID,
      expiresInSeconds: 73,
      remainingSeconds: 110,
      dailyLimitSeconds: 120,
    });
    expect(commitVisualEntitlement).not.toHaveBeenCalled();
  });

  it.each([
    ["daily_limit", 429],
    ["global_limit", 429],
    ["concurrency_limit", 429],
    ["conflict", 409],
  ])("surfaces quota boundary %s without activation", async (status, expectedStatus) => {
    reserveVisualEntitlement.mockResolvedValueOnce({ status, remainingSeconds: 0 });
    const response = await POST(request(body));
    expect(response.status).toBe(expectedStatus);
    await expect(response.json()).resolves.toMatchObject({
      remainingSeconds: 0,
      dailyLimitSeconds: 120,
    });
    expect(commitVisualEntitlement).not.toHaveBeenCalled();
  });

  it("returns retry guidance while the same reservation is pending", async () => {
    reserveVisualEntitlement.mockResolvedValueOnce({
      status: "pending",
      retryAfterSeconds: 4,
      remainingSeconds: 100,
    });
    const response = await POST(request(body));
    expect(response.status).toBe(409);
    expect(response.headers.get("retry-after")).toBe("4");
    await expect(response.json()).resolves.toMatchObject({
      remainingSeconds: 100,
      dailyLimitSeconds: 120,
    });
  });

  it("requires authorization and owned active state before reserving", async () => {
    requireMutationSession.mockRejectedValueOnce(new AuthError(401, "authentication_required", "Sign in."));
    expect((await POST(request(body))).status).toBe(401);
    expect(reserveVisualEntitlement).not.toHaveBeenCalled();

    requireMutationSession.mockResolvedValueOnce(learner);
    getActiveState.mockResolvedValueOnce({ ...activeState, learnerId: "lrn_other_123456789" });
    expect((await POST(request(body))).status).toBe(404);
    expect(reserveVisualEntitlement).not.toHaveBeenCalled();
  });

  it("rejects invalid duration and chunked oversized bodies", async () => {
    expect((await POST(request({ ...body, durationSeconds: 7 }))).status).toBe(400);
    const stream = new ReadableStream<string>({
      start(controller) {
        controller.enqueue("x".repeat(17_000));
        controller.close();
      },
    }).pipeThrough(new TextEncoderStream());
    const oversized = new Request("http://localhost/api/fal/reserve", {
      method: "POST",
      headers: { origin: "http://localhost", "content-type": "application/json" },
      body: stream,
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    expect((await POST(oversized)).status).toBe(413);
    expect(reserveVisualEntitlement).not.toHaveBeenCalled();
  });

  it("rolls back a reservation whose activation fence is lost", async () => {
    commitVisualEntitlement.mockResolvedValueOnce(false);
    const response = await POST(request(body));
    expect(response.status).toBe(502);
    expect(releaseVisualEntitlement).toHaveBeenCalledWith(
      learner.learnerId,
      SESSION_ID,
      RESERVATION_ID,
      true,
      120,
    );
  });

  it("reports the authenticated learner's current allowance without mutation", async () => {
    vi.stubEnv("DAILY_VIDEO_SECONDS", "150");
    const response = await GET(new Request(
      `http://localhost/api/fal/reserve?sessionId=${SESSION_ID}`,
    ));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store, private");
    await expect(response.json()).resolves.toEqual({
      remainingSeconds: 95,
      dailyLimitSeconds: 150,
    });
    expect(getVisualDailyRemaining).toHaveBeenCalledWith(learner.learnerId, 150);
    expect(reserveVisualEntitlement).not.toHaveBeenCalled();
  });

  it("authorizes and validates allowance lookup before reading the budget registry", async () => {
    requireSession.mockRejectedValueOnce(new AuthError(401, "authentication_required", "Sign in."));
    expect((await GET(new Request(
      `http://localhost/api/fal/reserve?sessionId=${SESSION_ID}`,
    ))).status).toBe(401);

    requireSession.mockResolvedValueOnce(learner);
    expect((await GET(new Request(
      "http://localhost/api/fal/reserve?sessionId=bad",
    ))).status).toBe(400);
    expect(getVisualDailyRemaining).not.toHaveBeenCalled();
  });

  it("fails closed when allowance lookup storage is unavailable", async () => {
    getVisualDailyRemaining.mockRejectedValueOnce(new Error("redis allowance secret"));
    const response = await GET(new Request(
      `http://localhost/api/fal/reserve?sessionId=${SESSION_ID}`,
    ));
    expect(response.status).toBe(502);
    await expect(response.text()).resolves.not.toContain("redis allowance secret");
  });

  it("fails closed on a real registry outage without exposing credentials", async () => {
    reserveVisualEntitlement.mockRejectedValueOnce(new Error("redis://secret"));
    const response = await POST(request(body));
    expect(response.status).toBe(502);
    await expect(response.text()).resolves.not.toContain("redis://secret");
  });
});
