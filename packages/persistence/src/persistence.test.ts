import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  InMemoryLearningRepository,
  InMemoryRedis,
  PostgresLearningRepository,
  RedisSessionStore,
  SessionClosureService,
  createRedisSessionStore,
  decodeRetainedPayloadKey,
  decryptRetainedPayload,
  encryptRetainedPayload,
  LEARNING_CONTEXT_LIMITS,
  parsePersistenceEnvironment,
  type SessionSummaryInput,
  type SqlExecutor,
} from "./index";

const key = Buffer.alloc(32, 7).toString("base64");
afterEach(() => {
  vi.useRealTimers();
});

function summary(sessionId = "session-1"): SessionSummaryInput {
  return {
    sessionId,
    userId: "user-1",
    summary: "Compared inertia and net force.",
    concepts: ["inertia", "net force"],
    startedAt: new Date("2026-08-30T10:00:00.000Z"),
    endedAt: new Date("2026-08-30T10:12:00.000Z"),
  };
}

describe("RedisSessionStore", () => {
  it("encrypts transcript entries and restores them in order", async () => {
    const redis = new InMemoryRedis();
    const store = new RedisSessionStore(redis, { transcriptEncryptionKey: key });

    await store.appendTranscript("session-1", {
      turnId: "turn-1",
      role: "learner",
      text: "Why do objects keep moving?",
      finalized: true,
      recordedAt: "2026-08-30T10:01:00.000Z",
    });
    await store.appendTranscript("session-1", {
      turnId: "turn-2",
      role: "assistant",
      text: "That tendency is inertia.",
      finalized: true,
      recordedAt: "2026-08-30T10:01:02.000Z",
    });

    const raw = await redis.lrange("axiom:session:session-1:transcript", 0, -1);
    expect(raw.join(" ")).not.toContain("objects keep moving");
    await expect(store.readTranscript("session-1")).resolves.toMatchObject([
      { turnId: "turn-1", role: "learner" },
      { turnId: "turn-2", role: "assistant" },
    ]);
    expect(await redis.ttl("axiom:session:session-1:transcript")).toBeGreaterThan(0);
    expect(await redis.ttl("axiom:session:session-1:transcript")).toBeLessThanOrEqual(86_400);
  });

  it("supports active state, idempotency, rate limiting, and fan-out", async () => {
    const redis = new InMemoryRedis();
    const store = new RedisSessionStore(redis, { transcriptEncryptionKey: key });

    await store.setActiveState("session-1", { revision: 4, status: "active" });
    await expect(store.getActiveState("session-1")).resolves.toEqual({ revision: 4, status: "active" });
    await redis.set("axiom:session:session-1:revision", "7", { ex: 300 });
    await expect(store.getActiveState("session-1")).resolves.toEqual({ revision: 7, status: "active" });
    await expect(store.claimIdempotencyKey("session-1", "message-1")).resolves.toBe(true);
    await expect(store.claimIdempotencyKey("session-1", "message-1")).resolves.toBe(false);
    await expect(store.consumeRateLimit("user-1", { limit: 2, windowSeconds: 60 })).resolves.toMatchObject({ allowed: true, remaining: 1 });
    await expect(store.consumeRateLimit("user-1", { limit: 2, windowSeconds: 60 })).resolves.toMatchObject({ allowed: true, remaining: 0 });
    await expect(store.consumeRateLimit("user-1", { limit: 2, windowSeconds: 60 })).resolves.toMatchObject({ allowed: false, remaining: 0 });
    await store.publish("session-1", { protocolVersion: 1, type: "session.status", state: "listening" });
    expect(redis.published).toHaveLength(1);
    expect(redis.published[0]).toMatchObject({
      channel: "axiom:session:session-1:events",
      message: expect.stringMatching(/^v2\./),
    });
  });

  it("atomically compares revision, persists state, and caches the committed response", async () => {
    const redis = new InMemoryRedis();
    const store = new RedisSessionStore(redis, { transcriptEncryptionKey: key });
    await store.setActiveState("session-1", { revision: 4, status: "active" });
    const acquired = await store.reserveMutationAttempt("session-1", 4, "command-1");
    if (acquired.status !== "acquired") throw new Error("Expected mutation attempt");
    const mutation = {
      scope: "turn-scope",
      idempotencyKey: "command-1",
      sessionId: "session-1",
      expectedRevision: 4,
      state: { revision: 5, status: "active" },
      response: { sessionId: "session-1", revision: 5 },
      attemptToken: acquired.attemptToken,
    };

    await expect(store.commitMutation(mutation)).resolves.toBe(true);
    await expect(store.getActiveState("session-1")).resolves.toEqual(mutation.state);
    await expect(store.readCommittedMutation("session-1", "command-1")).resolves.toEqual(mutation.response);
    await expect(redis.get("axiom:session:session-1:mutation:command-1")).resolves.not.toContain("session-1");
    await expect(store.commitMutation(mutation)).resolves.toBe(false);
    await expect(store.commitMutation({
      ...mutation,
      idempotencyKey: "command-2",
      state: { revision: 6, status: "active" },
    })).resolves.toBe(false);
  });

  it("atomically charges duration, enforces daily and concurrent limits, and makes retries idempotent", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-30T10:00:00.000Z"));
    const redis = new InMemoryRedis();
    const store = new RedisSessionStore(redis, { transcriptEncryptionKey: key });
    const base = {
      learnerId: "learner-1",
      durationSeconds: 10 as const,
      dailyLimitSeconds: 30,
      maxConcurrent: 1,
      globalDailyLimitSeconds: 1_000,
      leaseSeconds: 60,
    };

    const first = await store.reserveVisualEntitlement({ ...base, sessionId: "session-1" });
    expect(first).toMatchObject({ status: "active", leaseExpiresInSeconds: 60, remainingSeconds: 15 });
    if (first.status !== "active") throw new Error("Expected an active reservation");
    await expect(store.reserveVisualEntitlement({ ...base, sessionId: "session-1" })).resolves.toMatchObject({
      status: "active",
      reservationId: first.reservationId,
      leaseExpiresInSeconds: 60,
      remainingSeconds: 15,
    });
    await expect(store.reserveVisualEntitlement({ ...base, sessionId: "session-2" })).resolves.toEqual({
      status: "concurrency_limit",
      remainingSeconds: 15,
    });

    await expect(store.commitVisualEntitlement("session-1", first.reservationId)).resolves.toBe(true);
    await expect(store.reserveVisualEntitlement({ ...base, sessionId: "session-1" })).resolves.toMatchObject({
      status: "active",
      reservationId: first.reservationId,
      remainingSeconds: 15,
    });
    const visualSession = createHash("sha256").update("session-1").digest("base64url");
    const leaseKey = `axiom:visual:lease:${visualSession}`;
    const rawLease = String(await redis.get(leaseKey));
    expect(rawLease).not.toContain("token");
    await expect(store.releaseVisualEntitlement(
      "learner-1",
      "session-1",
      first.reservationId,
      false,
      25,
    )).resolves.toEqual({ released: true, remainingSeconds: 10 });
    vi.advanceTimersByTime(61_000);

    const second = await store.reserveVisualEntitlement({
      ...base,
      sessionId: "session-2",
      durationSeconds: 15,
    });
    expect(second.status).toBe("active");
    if (second.status !== "active") throw new Error("Expected an active reservation");
    await store.releaseVisualEntitlement("learner-1", "session-2", second.reservationId);
    await expect(store.reserveVisualEntitlement({
      ...base,
      sessionId: "session-3",
      durationSeconds: 5,
    })).resolves.toEqual({ status: "daily_limit", remainingSeconds: 0 });
  });

  it("expires abandoned leases and rolls back charging only when provider minting fails", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-30T10:00:00.000Z"));
    const store = new RedisSessionStore(new InMemoryRedis(), { transcriptEncryptionKey: key });
    const request = {
      learnerId: "learner-1",
      sessionId: "session-1",
      durationSeconds: 5 as const,
      dailyLimitSeconds: 15,
      maxConcurrent: 1,
      globalDailyLimitSeconds: 1_000,
      leaseSeconds: 60,
    };
    const first = await store.reserveVisualEntitlement(request);
    if (first.status !== "active") throw new Error("Expected an active reservation");
    await expect(store.releaseVisualEntitlement(
      request.learnerId,
      request.sessionId,
      first.reservationId,
      true,
      request.dailyLimitSeconds,
    )).resolves.toEqual({ released: true, remainingSeconds: 15 });
    await expect(store.reserveVisualEntitlement({ ...request, sessionId: "session-2" })).resolves.toMatchObject({
      status: "active",
    });

    vi.advanceTimersByTime(61_000);
    await expect(store.reserveVisualEntitlement({
      ...request,
      sessionId: "session-3",
      dailyLimitSeconds: 30,
    })).resolves.toMatchObject({ status: "active" });
  });

  it("enforces a visual ceiling shared by fresh learner identifiers", async () => {
    const store = new RedisSessionStore(new InMemoryRedis(), { transcriptEncryptionKey: key });
    const request = {
      sessionId: "session-1",
      durationSeconds: 10 as const,
      dailyLimitSeconds: 120,
      globalDailyLimitSeconds: 15,
      maxConcurrent: 1,
      leaseSeconds: 180,
    };
    await expect(store.reserveVisualEntitlement({ ...request, learnerId: "learner-1" }))
      .resolves.toMatchObject({ status: "active" });
    await expect(store.reserveVisualEntitlement({ ...request, learnerId: "learner-2", sessionId: "session-2" }))
      .resolves.toEqual({ status: "global_limit", remainingSeconds: 120 });
  });

  it("encrypts transcript-bearing active state and retained fan-out while publishing live events", async () => {
    const redis = new InMemoryRedis();
    const store = new RedisSessionStore(redis, { transcriptEncryptionKey: key });
    await store.setActiveState("session-1", {
      revision: 1,
      status: "active",
      transcript: "Sensitive learner explanation",
    });
    await store.publish("session-1", {
      protocolVersion: 1,
      type: "transcript.final",
      turnId: "turn-1",
      text: "Sensitive learner explanation",
      interrupted: false,
    });

    expect(String(await redis.get("axiom:session:session-1:state"))).not.toContain("Sensitive learner explanation");
    expect((await redis.lrange("axiom:session:session-1:events", 0, -1)).join(" ")).not.toContain(
      "Sensitive learner explanation",
    );
    await expect(store.getActiveState("session-1")).resolves.toMatchObject({
      transcript: "Sensitive learner explanation",
    });
    await expect(store.readFanout("session-1")).resolves.toMatchObject({
      events: [expect.objectContaining({ text: "Sensitive learner explanation" })],
    });
    expect(redis.published[0]?.message).toMatch(/^v2\./);
    expect(redis.published[0]?.message).not.toContain("Sensitive learner explanation");
  });

  it("binds retained ciphertext to its canonical Redis record", () => {
    const encryptionKey = decodeRetainedPayloadKey(key);
    const ciphertext = encryptRetainedPayload("learner context", encryptionKey, "axiom:session:one:transcript");
    expect(decryptRetainedPayload(ciphertext, encryptionKey, "axiom:session:one:transcript"))
      .toBe("learner context");
    expect(() => decryptRetainedPayload(ciphertext, encryptionKey, "axiom:session:two:transcript"))
      .toThrow();
  });

  it("does not slide transcript or fanout retention on later appends", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-30T10:00:00.000Z"));
    const redis = new InMemoryRedis();
    const store = new RedisSessionStore(redis, {
      transcriptEncryptionKey: key,
      transcriptTtlSeconds: 100,
    });
    const transcript = {
      turnId: "turn-1",
      role: "assistant" as const,
      text: "Bounded",
      finalized: true,
      recordedAt: "2026-08-30T10:00:00.000Z",
    };
    const event = {
      protocolVersion: 1 as const,
      type: "session.status" as const,
      state: "text_only" as const,
    };
    await store.appendTranscript("bounded", transcript);
    await store.publish("bounded", event);
    vi.advanceTimersByTime(50_000);
    await store.appendTranscript("bounded", { ...transcript, turnId: "turn-2" });
    await store.publish("bounded", event);

    await expect(redis.ttl("axiom:session:bounded:transcript")).resolves.toBe(50);
    await expect(redis.ttl("axiom:session:bounded:events")).resolves.toBe(3_550);
  });

  it("deduplicates retained transcript and fanout effects by durable operation id", async () => {
    const redis = new InMemoryRedis();
    const store = new RedisSessionStore(redis, { transcriptEncryptionKey: key });
    const transcript = {
      turnId: "turn-once",
      role: "assistant" as const,
      text: "Stored once",
      finalized: true,
      recordedAt: "2026-08-30T10:01:00.000Z",
    };
    const event = {
      protocolVersion: 1 as const,
      type: "session.status" as const,
      state: "text_only" as const,
    };
    await store.appendTranscriptOnce("session-once", "operation:transcript", transcript);
    await store.appendTranscriptOnce("session-once", "operation:transcript", transcript);
    await store.publishOnce("session-once", "operation:fanout", event);
    await store.publishOnce("session-once", "operation:fanout", event);
    await store.appendTranscriptsOnce("session-once", [
      { operationId: "operation:batch-1", entry: { ...transcript, turnId: "turn-batch-1" } },
      { operationId: "operation:batch-2", entry: { ...transcript, turnId: "turn-batch-2" } },
    ]);
    await store.appendTranscriptsOnce("session-once", [
      { operationId: "operation:batch-1", entry: { ...transcript, turnId: "turn-batch-1" } },
      { operationId: "operation:batch-2", entry: { ...transcript, turnId: "turn-batch-2" } },
    ]);
    await store.publishManyOnce("session-once", [
      { operationId: "operation:event-batch-1", event },
      { operationId: "operation:event-batch-2", event },
    ]);
    await store.publishManyOnce("session-once", [
      { operationId: "operation:event-batch-1", event },
      { operationId: "operation:event-batch-2", event },
    ]);

    await expect(store.readTranscript("session-once")).resolves.toHaveLength(3);
    await expect(store.readFanout("session-once")).resolves.toMatchObject({ cursor: 3 });
  });

  it("keeps authentication sessions revocable and bounded", async () => {
    const store = new RedisSessionStore(new InMemoryRedis(), { transcriptEncryptionKey: key });
    const sessionId = "123e4567-e89b-42d3-a456-426614174000";
    await store.createAuthSession(sessionId, "lrn_abcdefghijklmnop", 60);
    await expect(store.getAuthSessionLearner(sessionId)).resolves.toBe("lrn_abcdefghijklmnop");
    await store.revokeAuthSession(sessionId);
    await expect(store.getAuthSessionLearner(sessionId)).resolves.toBeNull();
    await expect(store.createAuthSession(sessionId, "learner", 604_801)).rejects.toThrow("7 days");
  });

  it("atomically fences terminal sessions, purges raw payloads, and keeps compact replay", async () => {
    const redis = new InMemoryRedis();
    const store = new RedisSessionStore(redis, { transcriptEncryptionKey: key });
    const sessionId = "123e4567-e89b-42d3-a456-426614174000";
    const learnerId = "lrn_abcdefghijklmnop";
    const admission = await store.reserveRealtimeCall(learnerId, sessionId, "terminal-attempt");
    if (!admission.allowed) throw new Error("Expected realtime admission");
    await store.activateRealtimeCall(learnerId, sessionId, admission.leaseId, "rtc_terminal");
    await store.setActiveState(sessionId, { revision: 0, status: "active" });
    const visual = await store.reserveVisualEntitlement({
      learnerId,
      sessionId,
      durationSeconds: 15,
      dailyLimitSeconds: 120,
      globalDailyLimitSeconds: 1_000,
      maxConcurrent: 2,
    });
    if (visual.status !== "active") throw new Error("Expected active visual reservation");
    const mutationAttempt = await store.reserveMutationAttempt(sessionId, 0, "turn-1");
    if (mutationAttempt.status !== "acquired") throw new Error("Expected mutation attempt");
    await expect(store.getVisualDailyRemaining(learnerId, 120)).resolves.toBe(105);
    await store.commitMutation({
      scope: "turn-scope",
      idempotencyKey: "turn-1",
      sessionId,
      expectedRevision: 0,
      state: { revision: 1, status: "active" },
      response: { transcript: "raw response" },
      attemptToken: mutationAttempt.attemptToken,
    });
    await store.appendTranscript(sessionId, {
      turnId: "turn-1",
      role: "learner",
      text: "raw transcript",
      finalized: true,
      recordedAt: "2026-08-30T10:00:00.000Z",
    });

    await expect(store.commitTerminalMutation({
      scope: "close-scope",
      idempotencyKey: "close-1",
      sessionId,
      expectedRevision: 1,
      state: { revision: 2, status: "ended" },
      response: { summary: "compact" },
    })).resolves.toBe(true);
    await store.appendTranscript(sessionId, {
      turnId: "turn-late",
      role: "assistant",
      text: "must not return",
      finalized: true,
      recordedAt: "2026-08-30T10:01:00.000Z",
    });
    await store.publish(sessionId, {
      protocolVersion: 1,
      type: "session.status",
      state: "text_only",
    });

    await expect(store.readCommittedMutation("turn-scope", "turn-1")).resolves.toBeNull();
    await expect(store.readCommittedMutation("close-scope", "close-1")).resolves.toEqual({ summary: "compact" });
    await expect(store.readTranscript(sessionId)).resolves.toEqual([]);
    await expect(store.getActiveRealtimeCall(learnerId, sessionId, "rtc_terminal")).resolves.toBeUndefined();
    await expect(store.commitVisualEntitlement(sessionId, visual.reservationId)).resolves.toBe(false);
    await expect(store.getVisualDailyRemaining(learnerId, 120)).resolves.toBe(120);
    await expect(store.commitMutation({
      attemptToken: "00000000-0000-4000-8000-000000000000",
      scope: "turn-scope",
      idempotencyKey: "turn-after-close",
      sessionId,
      expectedRevision: 2,
      state: { revision: 3, status: "active" },
      response: {},
    })).resolves.toBe(false);
  });

  it("atomically reserves and compare-releases provider mutation attempts", async () => {
    const store = new RedisSessionStore(new InMemoryRedis(), { transcriptEncryptionKey: key });
    const sessionId = "223e4567-e89b-42d3-a456-426614174000";
    const initialState = { revision: 0, status: "active" } as const;
    await expect(store.createSessionIfAbsent(sessionId, "create-1", initialState, { sessionId }))
      .resolves.toEqual({ status: "created" });
    await expect(store.createSessionIfAbsent(sessionId, "create-1", initialState, { sessionId }))
      .resolves.toEqual({ status: "completed", response: { sessionId } });
    const acquired = await store.reserveMutationAttempt(sessionId, 0, "question-1");
    if (acquired.status !== "acquired") throw new Error("Expected mutation attempt");
    await expect(store.reserveMutationAttempt(sessionId, 0, "question-1"))
      .resolves.toMatchObject({ status: "in_progress", retryAfterSeconds: expect.any(Number) });
    await expect(store.releaseMutationAttempt(
      sessionId,
      "question-1",
      "00000000-0000-4000-8000-000000000000",
    )).resolves.toBe(false);
    await expect(store.releaseMutationAttempt(sessionId, "question-1", acquired.attemptToken)).resolves.toBe(true);
    await expect(store.reserveMutationAttempt(sessionId, 1, "question-2"))
      .resolves.toEqual({ status: "stale", currentRevision: 0 });
  });

  it("holds one distributed event stream lease per session", async () => {
    const store = new RedisSessionStore(new InMemoryRedis(), { transcriptEncryptionKey: key });
    const first = "123e4567-e89b-42d3-a456-426614174000";
    const second = "223e4567-e89b-42d3-a456-426614174000";
    await expect(store.acquireEventStreamLease("session", first, 30)).resolves.toBe(true);
    await expect(store.acquireEventStreamLease("session", second, 30)).resolves.toBe(false);
    await expect(store.releaseEventStreamLease("session", second)).resolves.toBe(false);
    await expect(store.releaseEventStreamLease("session", first)).resolves.toBe(true);
    await expect(store.acquireEventStreamLease("session", second, 30)).resolves.toBe(true);
  });

  it("persists repeated JSON object references that are not cycles", async () => {
    const store = new RedisSessionStore(new InMemoryRedis(), { transcriptEncryptionKey: key });
    const sharedSpec = {
      concept: "Orbital motion",
      durationSeconds: 5,
    };
    const state = {
      revision: 1,
      status: "text_only",
      visual: { spec: sharedSpec },
      lastEvents: [{ type: "visual.start", spec: sharedSpec }],
    };

    await expect(store.setActiveState("session-1", state as never)).resolves.toBeUndefined();
    await expect(store.getActiveState("session-1")).resolves.toEqual(state);
  });

  it("rejects raw media, cycles, and non-finite retained values", async () => {
    const store = new RedisSessionStore(new InMemoryRedis(), { transcriptEncryptionKey: key });
    await expect(store.setActiveState("session-1", {
      revision: 1,
      status: "active",
      audioPayload: "base64-media",
    })).rejects.toThrow("Raw media is not allowed");
    await expect(store.setActiveState("session-1", {
      revision: 1,
      status: "active",
      score: Number.NaN,
    } as never)).rejects.toThrow("non-finite");
    const cyclic: Record<string, unknown> = { revision: 1, status: "active" };
    cyclic.self = cyclic;
    await expect(store.setActiveState("session-1", cyclic as never)).rejects.toThrow("cycle");
    await expect(store.commitMutation({
      scope: "turn-scope",
      idempotencyKey: "non-finite",
      sessionId: "session-1",
      expectedRevision: 0,
      state: { revision: 1, status: "active" },
      response: { score: Number.POSITIVE_INFINITY },
      attemptToken: "00000000-0000-4000-8000-000000000000",
    })).rejects.toThrow("non-finite");
  });
});

describe("InMemoryLearningRepository", () => {
  it("hydrates cumulative bounded learning context without retaining transcripts", async () => {
    const repository = new InMemoryLearningRepository();
    await repository.recordEvidence("learner", {
      concept: "Gravity",
      evidence: "prediction",
      confidenceDelta: 0.1,
      misconception: "Heavier objects fall faster",
      preferenceSignals: { explanationMode: "visual", interests: ["orbits"] },
    });
    await repository.recordEvidence("learner", {
      concept: " gravity ",
      evidence: "correction",
      confidenceDelta: 0.1,
      misconception: "Heavier objects fall faster",
    });
    for (let index = 0; index < 60; index += 1) {
      await repository.recordCardInteraction({
        sessionId: `session-${index}`,
        learnerId: "learner",
        cardId: `card-${index}`,
        purpose: "check",
        action: "selected",
        occurredAt: new Date(1_000 + index),
      });
      await repository.recordVisualMetadata({
        sessionId: `session-${index}`,
        learnerId: "learner",
        visualId: `visual-${index}`,
        concept: "gravity",
        durationSeconds: 5,
        resolution: "480p",
        outcome: "completed",
        promptVersion: 1,
        createdAt: new Date(1_000 + index),
      });
    }
    const compact = {
      ...summary("bounded-summary"),
      userId: "learner",
      transcript: "raw transcript must be discarded",
    };
    await repository.saveCompactSessionSummary(compact);

    const hydrated = await repository.loadLearningContext("learner");
    expect(hydrated.mastery).toEqual([{ concept: "Gravity", confidence: 0.7, evidenceCount: 2 }]);
    expect(hydrated.misconceptions).toEqual([{
      concept: "Gravity",
      description: "Heavier objects fall faster",
      evidenceCount: 2,
    }]);
    expect(hydrated.preferences).toMatchObject({ explanationMode: "visual", interests: ["orbits"] });
    expect(hydrated.recentSummaries).toHaveLength(1);
    expect(hydrated.recentCardInteractions).toHaveLength(LEARNING_CONTEXT_LIMITS.cardInteractions);
    expect(hydrated.recentVisualMetadata).toHaveLength(LEARNING_CONTEXT_LIMITS.visualMetadata);
    expect(repository.sessionSummaries[0]).not.toHaveProperty("transcript");
  });
});

describe("SessionClosureService", () => {
  it("persists only the compact summary then deletes transcript and active state", async () => {
    const repository = new InMemoryLearningRepository();
    const redis = new InMemoryRedis();
    const sessions = new RedisSessionStore(redis, { transcriptEncryptionKey: key });
    await sessions.appendTranscript("session-1", {
      turnId: "turn-1",
      role: "learner",
      text: "A full transcript that must not enter PostgreSQL",
      finalized: true,
      recordedAt: "2026-08-30T10:01:00.000Z",
    });
    await sessions.setActiveState("session-1", { revision: 1, status: "active" });
    await sessions.publish("session-1", {
      protocolVersion: 1,
      type: "transcript.final",
      turnId: "turn-1",
      text: "A full transcript that must not survive normal close",
      interrupted: false,
    });

    await new SessionClosureService(repository, sessions).close(summary());

    await expect(sessions.readTranscript("session-1")).resolves.toEqual([]);
    await expect(sessions.getActiveState("session-1")).resolves.toBeNull();
    await expect(sessions.readFanout("session-1")).resolves.toEqual({ events: [], cursor: 0 });
    expect(repository.sessionSummaries).toEqual([{ ...summary(), explorationEdges: [] }]);
  });

  it("retains recovery data when compact-summary persistence fails", async () => {
    const repository = new InMemoryLearningRepository();
    repository.saveCompactSessionSummary = async () => {
      throw new Error("database unavailable");
    };
    const sessions = new RedisSessionStore(new InMemoryRedis(), { transcriptEncryptionKey: key });
    await sessions.appendTranscript("session-1", {
      turnId: "turn-1",
      role: "learner",
      text: "Keep me for a retry",
      finalized: true,
      recordedAt: "2026-08-30T10:01:00.000Z",
    });

    await expect(new SessionClosureService(repository, sessions).close(summary())).rejects.toThrow("database unavailable");
    await expect(sessions.readTranscript("session-1")).resolves.toHaveLength(1);
  });
});

describe("PostgresLearningRepository", () => {
  it("keeps untrusted values in query parameters", async () => {
    const sql: SqlExecutor & { calls: Array<{ text: string; parameters: readonly unknown[] }> } = {
      calls: [],
      async query<Row extends Record<string, unknown>>(text: string, parameters: readonly unknown[]): Promise<readonly Row[]> {
        this.calls.push({ text, parameters });
        return [];
      },
    };
    const repository = new PostgresLearningRepository(sql);
    const malicious = "inertia'); DROP TABLE learner_profiles; --";

    await repository.recordOperationalMetric({
      name: malicious,
      value: 1,
      unit: "count",
      recordedAt: new Date("2026-08-30T10:00:00.000Z"),
    });


    expect(sql.calls[0]?.text).not.toContain(malicious);
    expect(sql.calls[0]?.parameters).toContain(malicious);
  });

  it("hydrates all bounded durable learner context without transcript columns", async () => {
    const sql: SqlExecutor = {
      async query<Row extends Record<string, unknown>>(text: string): Promise<readonly Row[]> {
        let rows: Array<Record<string, unknown>> = [];
        if (text.includes("FROM concept_mastery")) rows = [{ concept: "gravity", confidence: 0.8, evidence_count: 3 }];
        else if (text.includes("FROM misconceptions")) rows = [{ concept: "gravity", description: "mass changes acceleration", evidence_count: 2 }];
        else if (text.includes("FROM learner_preferences")) rows = [{ explanation_mode: "visual", pace: "steady", challenge: null }];
        else if (text.includes("FROM topic_interests")) rows = [{ topic: "orbits" }];
        else if (text.includes("FROM session_summaries")) rows = [{
          session_id: "session-1",
          summary: "Compared falling objects.",
          concepts: ["gravity"],
          completed_at: "2026-08-30T10:00:00.000Z",
          exploration_edges: [{ from: "mass", to: "gravity" }],
        }];
        else if (text.includes("FROM card_interactions")) rows = [{
          session_id: "session-1",
          learner_id: "learner",
          card_id: "card-1",
          purpose: "check",
          action: "selected",
          concept: "gravity",
          occurred_at: "2026-08-30T09:59:00.000Z",
        }];
        else if (text.includes("FROM visual_metadata")) rows = [{
          session_id: "session-1",
          learner_id: "learner",
          visual_id: "visual-1",
          concept: "gravity",
          duration_seconds: 5,
          resolution: "480p",
          outcome: "completed",
          prompt_version: 1,
          latency_ms: 120,
          created_at: "2026-08-30T09:58:00.000Z",
        }];
        return rows as readonly Row[];
      },
    };

    const context = await new PostgresLearningRepository(sql).loadLearningContext("learner");
    expect(context).toMatchObject({
      mastery: [{ concept: "gravity", confidence: 0.8, evidenceCount: 3 }],
      misconceptions: [{ evidenceCount: 2 }],
      preferences: { explanationMode: "visual", interests: ["orbits"] },
      recentSummaries: [{ explorationEdges: [{ from: "mass", to: "gravity" }] }],
      recentCardInteractions: [{ cardId: "card-1" }],
      recentVisualMetadata: [{ visualId: "visual-1", latencyMs: 120 }],
    });
    expect(JSON.stringify(context)).not.toContain("transcript");
  });

  it("rejects sensitive operational metric dimensions", async () => {
    const repository = new InMemoryLearningRepository();
    await expect(repository.recordOperationalMetric({
      name: "gateway.latency",
      value: 12,
      unit: "milliseconds",
      dimensions: { promptSecret: "must-not-persist" },
      recordedAt: new Date("2026-08-30T10:00:00.000Z"),
    })).rejects.toThrow("Sensitive metric dimension");
  });
});

describe("environment validation", () => {
  it("rejects missing persistence secrets and non-HTTPS Upstash endpoints", () => {
    expect(() => parsePersistenceEnvironment({
      DATABASE_URL: "postgresql://user:pass@example.test/db",
      UPSTASH_REDIS_REST_URL: "http://redis.example.test",
      UPSTASH_REDIS_REST_TOKEN: "token",
      TRANSCRIPT_ENCRYPTION_KEY: key,
    })).toThrow();
    expect(() => parsePersistenceEnvironment({})).toThrow();
  });
  it("threads and bounds the active transcript retention setting", () => {
    const baseEnvironment = {
      DATABASE_URL: "postgresql://user:pass@example.test/db",
      UPSTASH_REDIS_REST_URL: "https://redis.example.test",
      UPSTASH_REDIS_REST_TOKEN: "token",
      TRANSCRIPT_ENCRYPTION_KEY: key,
    };
    expect(parsePersistenceEnvironment({
      ...baseEnvironment,
      ACTIVE_TRANSCRIPT_TTL_SECONDS: "3600",
    }).ACTIVE_TRANSCRIPT_TTL_SECONDS).toBe(3_600);
    const oversized = parsePersistenceEnvironment({
      ...baseEnvironment,
      ACTIVE_TRANSCRIPT_TTL_SECONDS: "86401",
    });
    expect(createRedisSessionStore(oversized).transcriptTtlSeconds).toBe(86_400);
  });
});
