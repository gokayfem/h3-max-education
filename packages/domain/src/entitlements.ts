export interface EntitlementPolicy { dailySeconds: number; maxConcurrentSessions: number }
export type EntitlementDecision =
  | { allowed: true; remainingSeconds: number }
  | { allowed: false; remainingSeconds: number; reason: "budget" | "concurrency" };

export interface Entitlements {
  reserve(learnerId: string, sessionId: string, seconds: number, now?: Date): Promise<EntitlementDecision>;
  release(learnerId: string, sessionId: string): void;
  remaining(learnerId: string, now?: Date): number;
}

interface LearnerUsage { day: string; usedSeconds: number; readonly activeSessions: Set<string> }

export class DailyVisualEntitlements implements Entitlements {
  private readonly usage = new Map<string, LearnerUsage>();

  constructor(private readonly policy: EntitlementPolicy) {
    if (!Number.isInteger(policy.dailySeconds) || policy.dailySeconds < 0) throw new Error("dailySeconds must be a non-negative integer");
    if (!Number.isInteger(policy.maxConcurrentSessions) || policy.maxConcurrentSessions < 1) throw new Error("maxConcurrentSessions must be a positive integer");
  }

  async reserve(learnerId: string, sessionId: string, seconds: number, now = new Date()): Promise<EntitlementDecision> {
    if (!learnerId || !sessionId) throw new Error("learnerId and sessionId are required");
    if (!Number.isInteger(seconds) || seconds <= 0) throw new Error("seconds must be a positive integer");
    const usage = this.getUsage(learnerId, now);
    const remainingSeconds = Math.max(0, this.policy.dailySeconds - usage.usedSeconds);
    const isExistingSession = usage.activeSessions.has(sessionId);
    if (!isExistingSession && usage.activeSessions.size >= this.policy.maxConcurrentSessions) {
      return { allowed: false, reason: "concurrency", remainingSeconds };
    }
    if (seconds > remainingSeconds) return { allowed: false, reason: "budget", remainingSeconds };
    usage.usedSeconds += seconds;
    usage.activeSessions.add(sessionId);
    return { allowed: true, remainingSeconds: remainingSeconds - seconds };
  }

  release(learnerId: string, sessionId: string): void { this.usage.get(learnerId)?.activeSessions.delete(sessionId); }

  remaining(learnerId: string, now = new Date()): number {
    const usage = this.getUsage(learnerId, now);
    return Math.max(0, this.policy.dailySeconds - usage.usedSeconds);
  }

  private getUsage(learnerId: string, now: Date): LearnerUsage {
    if (Number.isNaN(now.getTime())) throw new Error("now must be a valid date");
    const day = now.toISOString().slice(0, 10);
    const existing = this.usage.get(learnerId);
    if (!existing) {
      const created = { day, usedSeconds: 0, activeSessions: new Set<string>() };
      this.usage.set(learnerId, created);
      return created;
    }
    if (existing.day !== day) {
      existing.day = day;
      existing.usedSeconds = 0;
    }
    return existing;
  }
}
