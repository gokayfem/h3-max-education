import { afterEach, describe, expect, it, vi } from "vitest";
import {
  InMemoryLearningRepository,
  InMemoryRedis,
  RedisSessionStore,
  assertOperationalMetricSafe,
} from "./index.js";

const key = Buffer.alloc(32, 3).toString("base64");
const date = new Date("2026-08-30T10:00:00.000Z");

afterEach(() => vi.useRealTimers());

describe("InMemoryRedis", () => {
  it("models expiry, deletion, list ranges, and wrong types", async () => {
    vi.useFakeTimers();
    const redis = new InMemoryRedis();
    expect(await redis.set("key", "value", { ex: 1 })).toBe("OK");
    expect(await redis.set("key", "other", { nx: true })).toBeNull();
    expect(await redis.get("key")).toBe("value");
    expect(await redis.ttl("key")).toBe(1);
    await vi.advanceTimersByTimeAsync(1_001);
    expect(await redis.get("key")).toBeNull();
    expect(await redis.ttl("key")).toBe(-2);
    expect(await redis.expire("missing", 2)).toBe(0);
    await redis.set("persistent", "value");
    expect(await redis.ttl("persistent")).toBe(-1);
    expect(await redis.del("persistent", "missing")).toBe(1);
    await expect(redis.rpush("scalar", "x")).resolves.toBe(1);
    await expect(redis.get("scalar")).resolves.toEqual(["x"]);
    await expect(redis.set("wrong", "scalar")).resolves.toBe("OK");
    await expect(redis.rpush("wrong", "x")).rejects.toThrow("WRONGTYPE");
    await expect(redis.lrange("wrong", 0, -1)).rejects.toThrow("WRONGTYPE");
    await expect(redis.lrange("missing", 0, -1)).resolves.toEqual([]);
    await expect(redis.eval("unknown", [], [])).rejects.toThrow("requires a key");
    await expect(redis.eval("unknown", ["key"], [])).rejects.toThrow("Unsupported");
  });
});

describe("InMemoryLearningRepository", () => {
  it("covers profile, learning, preference, summary, and metadata behavior", async () => {
    const repository = new InMemoryLearningRepository();
    await expect(repository.getProfile("missing")).resolves.toBeNull();
    await repository.upsertProfile({ learnerId: "learner-1", displayName: "Ada", ageBand: "13-15", ageBandConfirmedAt: date });
    const created = await repository.getProfile("learner-1");
    await repository.upsertProfile({ learnerId: "learner-1", displayName: "Ada L.", ageBand: "16-18", ageBandConfirmedAt: date });
    const updated = await repository.getProfile("learner-1");
    expect(updated?.createdAt).toEqual(created?.createdAt);
    expect(updated?.displayName).toBe("Ada L.");

    await repository.recordEvidence("learner-1", { concept: "force", evidence: "prediction", confidenceDelta: 0.8, misconception: "constant force", preferenceSignals: { explanationMode: "visual", pace: "steady", challenge: "stretch", interests: ["physics"] } });
    const profile = await repository.recordEvidence("learner-1", { concept: "force", evidence: "correction", confidenceDelta: -2, misconception: "constant force" });
    expect(profile.mastery[0]).toMatchObject({ confidence: 0, evidenceCount: 2 });
    expect(profile.misconceptions[0]).toMatchObject({ evidenceCount: 2 });
    await repository.updatePreferences({ learnerId: "learner-1", explanationMode: "analogy", pace: "faster", challenge: "balanced" });
    await repository.addInterest("learner-1", "chemistry");
    await repository.addInterest("learner-1", "chemistry");
    expect((await repository.load("learner-1")).preferences.interests).toEqual(["chemistry", "physics"]);

    await repository.recordSessionSummary("learner-1", { sessionId: "domain-summary", summary: "Domain path", concepts: [], explorationEdges: [], completedAt: date });
    await repository.saveCompactSessionSummary({ sessionId: "session-1", userId: "learner-1", summary: "Summary", concepts: ["force"], explorationEdges: [{ from: "force", to: "motion" }], startedAt: date, endedAt: date });
    await expect(repository.saveCompactSessionSummary({ sessionId: "empty", userId: "learner-1", summary: " ", concepts: [], startedAt: date, endedAt: date })).rejects.toThrow();
    await repository.recordCardInteraction({ sessionId: "session-1", learnerId: "learner-1", cardId: "card", purpose: "check", action: "shown", occurredAt: date });
    await repository.recordVisualMetadata({ sessionId: "session-1", visualId: "visual", concept: "force", durationSeconds: 5, resolution: "480p", outcome: "completed", promptVersion: 1, createdAt: date });
    await repository.recordOperationalMetric({ name: "latency", value: 1, unit: "milliseconds", recordedAt: date });
    expect(repository.explorationEdges).toHaveLength(1);
    expect(repository.cardInteractions).toHaveLength(1);
    expect(repository.visualMetadata).toHaveLength(1);
    expect(repository.operationalMetrics).toHaveLength(1);
  });
});

describe("RedisSessionStore edge cases", () => {
  it("validates options, identifiers, state, transcripts, rate limits, and cursors", async () => {
    expect(() => new RedisSessionStore(new InMemoryRedis(), { transcriptEncryptionKey: "bad" })).toThrow();
    expect(() => new RedisSessionStore(new InMemoryRedis(), { transcriptEncryptionKey: key, activeStateTtlSeconds: 0 })).toThrow();
    const redis = new InMemoryRedis();
    const store = new RedisSessionStore(redis, { transcriptEncryptionKey: key, transcriptTtlSeconds: 999_999 });
    expect(store.transcriptTtlSeconds).toBe(86_400);
    await expect(store.setActiveState("bad id", { revision: 0, status: "active" })).rejects.toThrow("Invalid session");
    await expect(store.setActiveState("session", { revision: -1, status: "active" })).rejects.toThrow("revision");
    await expect(store.appendTranscript("session", { turnId: "", role: "learner", text: "x", finalized: true, recordedAt: date.toISOString() })).rejects.toThrow();
    await redis.rpush("axiom:session:session:transcript", "corrupt");
    await expect(store.readTranscript("session")).rejects.toThrow("Invalid encrypted");
    await expect(store.claimIdempotencyKey("session", "bad key!")).rejects.toThrow("Invalid idempotency");
    await expect(store.consumeRateLimit("user", { limit: 0, windowSeconds: 1 })).rejects.toThrow("limit");
    await expect(store.consumeRateLimit("user", { limit: 1, windowSeconds: 0 })).rejects.toThrow("window");
    await expect(store.readFanout("session", -1)).rejects.toThrow("cursor");
    await redis.set("axiom:session:invalid:state", "[]");
    await expect(store.getActiveState("invalid")).rejects.toThrow("Invalid active");
    await redis.set("axiom:session:invalid:state", '{"revision":-1,"status":"active"}');
    await expect(store.getActiveState("invalid")).rejects.toThrow("Invalid active");
    await store.deleteTranscript("missing");
    await store.deleteActiveState("missing");
  });

  it("rejects invalid protocol events and detects ciphertext tampering", async () => {
    const redis = new InMemoryRedis();
    const store = new RedisSessionStore(redis, { transcriptEncryptionKey: key });
    await expect(store.publish("session", { protocolVersion: 2, type: "session.status", state: "listening" } as never)).rejects.toThrow();
    await store.appendTranscript("session", { turnId: "turn", role: "assistant", text: "safe", finalized: false, interrupted: true, recordedAt: date.toISOString() });
    const values = await redis.lrange("axiom:session:session:transcript", 0, -1);
    const encrypted = String(values[0]);
    const parts = encrypted.split(".");
    parts[3] = `${parts[3]?.startsWith("A") ? "B" : "A"}${parts[3]?.slice(1) ?? ""}`;
    await redis.del("axiom:session:session:transcript");
    await redis.rpush("axiom:session:session:transcript", parts.join("."));
    await expect(store.readTranscript("session")).rejects.toThrow();
  });
});

describe("operational metric validation", () => {
  it("accepts safe dimensions and rejects invalid values and payload size", () => {
    expect(() => assertOperationalMetricSafe({ name: "visual.latency", value: 1, unit: "milliseconds", dimensions: { videoResolution: "480p" }, recordedAt: date })).not.toThrow();
    expect(() => assertOperationalMetricSafe({ name: "", value: 1, unit: "count", recordedAt: date })).toThrow("name");
    expect(() => assertOperationalMetricSafe({ name: "metric", value: Number.POSITIVE_INFINITY, unit: "count", recordedAt: date })).toThrow("finite");
    expect(() => assertOperationalMetricSafe({ name: "metric", value: 1, unit: "count", recordedAt: new Date("bad") })).toThrow("timestamp");
    expect(() => assertOperationalMetricSafe({ name: "metric", value: 1, unit: "count", dimensions: { region: "x".repeat(5_000) }, recordedAt: date })).toThrow("4096");
  });
});
