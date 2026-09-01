import { describe, expect, it } from "vitest";
import { DailyVisualEntitlements } from "./entitlements";

describe("DailyVisualEntitlements", () => {
  it("allows visual time within daily and concurrency limits", async () => {
    const entitlements = new DailyVisualEntitlements({ dailySeconds: 30, maxConcurrentSessions: 1 });
    expect(await entitlements.reserve("learner-1", "session-a", 15, new Date("2026-08-30T10:00:00Z"))).toEqual({ allowed: true, remainingSeconds: 15 });
    expect(await entitlements.reserve("learner-1", "session-a", 10, new Date("2026-08-30T10:01:00Z"))).toEqual({ allowed: true, remainingSeconds: 5 });
  });

  it("denies over-budget and concurrent visual sessions", async () => {
    const entitlements = new DailyVisualEntitlements({ dailySeconds: 10, maxConcurrentSessions: 1 });
    await entitlements.reserve("learner-1", "session-a", 5, new Date("2026-08-30T10:00:00Z"));
    await expect(entitlements.reserve("learner-1", "session-b", 5, new Date("2026-08-30T10:00:01Z"))).resolves.toMatchObject({ allowed: false, reason: "concurrency" });
    entitlements.release("learner-1", "session-a");
    await expect(entitlements.reserve("learner-1", "session-b", 10, new Date("2026-08-30T10:00:02Z"))).resolves.toMatchObject({ allowed: false, reason: "budget" });
  });

  it("resets the budget on the next UTC day", async () => {
    const entitlements = new DailyVisualEntitlements({ dailySeconds: 5, maxConcurrentSessions: 1 });
    await entitlements.reserve("learner-1", "session-a", 5, new Date("2026-08-30T23:59:00Z"));
    entitlements.release("learner-1", "session-a");
    expect((await entitlements.reserve("learner-1", "session-b", 5, new Date("2026-08-31T00:01:00Z"))).allowed).toBe(true);
  });

  it("keeps learners isolated and never charges a denied reservation", async () => {
    const entitlements = new DailyVisualEntitlements({ dailySeconds: 10, maxConcurrentSessions: 1 });
    await entitlements.reserve("learner-1", "session-a", 5, new Date("2026-08-30T10:00:00Z"));
    const denied = await entitlements.reserve("learner-1", "session-b", 5, new Date("2026-08-30T10:00:01Z"));
    expect(denied).toEqual({ allowed: false, reason: "concurrency", remainingSeconds: 5 });
    expect(entitlements.remaining("learner-1", new Date("2026-08-30T10:00:02Z"))).toBe(5);
    await expect(entitlements.reserve("learner-2", "session-b", 10, new Date("2026-08-30T10:00:02Z"))).resolves.toMatchObject({ allowed: true });
  });

  it("rejects invalid policies and reservation durations", async () => {
    expect(() => new DailyVisualEntitlements({ dailySeconds: -1, maxConcurrentSessions: 1 })).toThrow();
    expect(() => new DailyVisualEntitlements({ dailySeconds: 10, maxConcurrentSessions: 0 })).toThrow();
    const entitlements = new DailyVisualEntitlements({ dailySeconds: 10, maxConcurrentSessions: 1 });
    await expect(entitlements.reserve("learner", "session", 0)).rejects.toThrow("positive integer");
    await expect(entitlements.reserve("", "session", 5)).rejects.toThrow("learnerId and sessionId");
    expect(() => entitlements.remaining("learner", new Date("invalid"))).toThrow("valid date");
  });
});
