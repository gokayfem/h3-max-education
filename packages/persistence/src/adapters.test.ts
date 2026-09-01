import { beforeEach, describe, expect, it, vi } from "vitest";

const serviceMocks = vi.hoisted(() => {
  const redis = {
    get: vi.fn(async () => null),
    set: vi.fn(async () => "OK"),
    del: vi.fn(async () => 1),
    expire: vi.fn(async () => 1),
    ttl: vi.fn(async () => 30),
    rpush: vi.fn(async () => 1),
    lrange: vi.fn(async () => []),
    publish: vi.fn(async () => 0),
    eval: vi.fn(async () => [1, 30]),
  };
  return {
    neonQuery: vi.fn(async (): Promise<Record<string, unknown>[]> => []),
    redis,
  };
});

vi.mock("@neondatabase/serverless", () => ({
  neon: vi.fn(() => ({ query: serviceMocks.neonQuery })),
  Client: class {},
}));
vi.mock("@upstash/redis", () => ({
  Redis: class { constructor() { return serviceMocks.redis; } },
}));

import {
  NeonSqlExecutor,
  UpstashRedisCommands,
  createPersistenceFromEnv,
  createPostgresLearningRepository,
  createRedisSessionStore,
  PostgresLearningRepository,
  RedisSessionStore,
  type SqlExecutor,
} from "./index.js";

const encryptionKey = Buffer.alloc(32, 9).toString("base64");
const environment = {
  DATABASE_URL: "postgresql://user:pass@example.test/db",
  UPSTASH_REDIS_REST_URL: "https://redis.example.test",
  UPSTASH_REDIS_REST_TOKEN: "token",
  TRANSCRIPT_ENCRYPTION_KEY: encryptionKey,
};

beforeEach(() => vi.clearAllMocks());

describe("service client adapters", () => {
  it("forwards parameterized Neon and every Redis command shape", async () => {
    serviceMocks.neonQuery.mockResolvedValueOnce([{ answer: 42 }]);
    await expect(new NeonSqlExecutor(environment.DATABASE_URL).query("SELECT $1 AS answer", [42])).resolves.toEqual([{ answer: 42 }]);
    expect(serviceMocks.neonQuery).toHaveBeenCalledWith("SELECT $1 AS answer", [42]);

    const redis = new UpstashRedisCommands(environment.UPSTASH_REDIS_REST_URL, environment.UPSTASH_REDIS_REST_TOKEN);
    await redis.get("key");
    await redis.set("key", "value");
    await redis.set("key", "value", { ex: 10 });
    await redis.set("key", "value", { nx: true });
    await redis.set("key", "value", { nx: true, ex: 10 });
    await redis.del("a", "b");
    await redis.expire("key", 10);
    await redis.ttl("key");
    await redis.rpush("list", "a", "b");
    await redis.lrange("list", 0, -1);
    await redis.publish("channel", "message");
    await redis.eval("return ARGV", ["key"], [1, "two"]);
    expect(serviceMocks.redis.set).toHaveBeenCalledTimes(4);
    expect(serviceMocks.redis.eval).toHaveBeenCalledWith("return ARGV", ["key"], ["1", "two"]);
  });

  it("constructs validated factories", () => {
    expect(createPostgresLearningRepository(environment.DATABASE_URL)).toBeInstanceOf(PostgresLearningRepository);
    expect(createRedisSessionStore(environment)).toBeInstanceOf(RedisSessionStore);
    const services = createPersistenceFromEnv(environment);
    expect(services.repository).toBeInstanceOf(PostgresLearningRepository);
    expect(services.sessions).toBeInstanceOf(RedisSessionStore);
    expect(services.closure).toBeDefined();
    expect(() => createPostgresLearningRepository("https://not-postgres.test")).toThrow();
    expect(() => createRedisSessionStore({ ...environment, TRANSCRIPT_ENCRYPTION_KEY: "bad" })).toThrow();
  });
});

class RepositorySql implements SqlExecutor {
  readonly calls: Array<{ text: string; parameters: readonly unknown[] }> = [];

  async query<Row extends Record<string, unknown>>(text: string, parameters: readonly unknown[]): Promise<readonly Row[]> {
    this.calls.push({ text, parameters });
    if (text.includes("FROM concept_mastery")) return [{ concept: "force", confidence: "0.7", evidence_count: "2" }] as unknown as Row[];
    if (text.includes("FROM misconceptions")) return [{ concept: "force", description: "motion requires force", evidence_count: "1" }] as unknown as Row[];
    if (text.includes("FROM learner_preferences")) return [{ explanation_mode: "visual", pace: "steady", challenge: "balanced" }] as unknown as Row[];
    if (text.includes("FROM topic_interests")) return [{ topic: "physics" }] as unknown as Row[];
    if (text.includes("FROM session_summaries")) return [{
      session_id: "session-1",
      summary: "Learned force.",
      concepts: ["force"],
      completed_at: "2026-08-30T10:00:00.000Z",
      exploration_edges: [{ from: "force", to: "acceleration" }],
    }] as unknown as Row[];
    if (text.includes("FROM learner_profiles")) return [{
      learner_id: "learner-1",
      display_name: "Ada",
      age_band: "13-15",
      age_band_confirmed_at: "2026-08-01T00:00:00.000Z",
      created_at: "2026-08-01T00:00:00.000Z",
      updated_at: "2026-08-02T00:00:00.000Z",
    }] as unknown as Row[];
    return [];
  }
}

describe("PostgresLearningRepository", () => {
  it("maps compact memory and profile rows", async () => {
    const repository = new PostgresLearningRepository(new RepositorySql());
    await expect(repository.load("learner-1")).resolves.toMatchObject({
      learnerId: "learner-1",
      mastery: [{ concept: "force", confidence: 0.7, evidenceCount: 2 }],
      misconceptions: [{ evidenceCount: 1 }],
      preferences: { explanationMode: "visual", interests: ["physics"] },
      recentSummaries: [{ sessionId: "session-1" }],
    });
    await expect(repository.getProfile("learner-1")).resolves.toMatchObject({ displayName: "Ada", ageBand: "13-15" });
    const emptySql: SqlExecutor = { async query<Row>() { return [] as Row[]; } };
    await expect(new PostgresLearningRepository(emptySql).getProfile("missing")).resolves.toBeNull();
  });

  it("executes every write using values as parameters", async () => {
    const sql = new RepositorySql();
    const repository = new PostgresLearningRepository(sql);
    const date = new Date("2026-08-30T10:00:00.000Z");
    await repository.upsertProfile({ learnerId: "learner-1", displayName: "Ada", ageBand: "13-15", ageBandConfirmedAt: date });
    await repository.updatePreferences({ learnerId: "learner-1", explanationMode: "visual", pace: "steady", challenge: "balanced" });
    await repository.addInterest("learner-1", "physics", 2);
    await repository.recordEvidence("learner-1", {
      concept: "force",
      evidence: "predicted acceleration",
      confidenceDelta: 0.2,
      misconception: "motion requires force",
      preferenceSignals: { explanationMode: "visual", interests: ["physics"] },
    });
    await repository.recordSessionSummary("learner-1", {
      sessionId: "session-1", summary: "Force and acceleration", concepts: ["force"],
      explorationEdges: [{ from: "force", to: "acceleration" }], completedAt: date,
    });
    await repository.saveCompactSessionSummary({
      sessionId: "session-2", userId: "learner-1", summary: `  ${"x".repeat(2_100)}  `,
      concepts: Array.from({ length: 25 }, (_, index) => `c${index}`),
      explorationEdges: Array.from({ length: 30 }, (_, index) => ({ from: `a${index}`, to: `b${index}` })),
      startedAt: date, endedAt: date,
    });
    await repository.recordExplorationEdges("session-1", [{ from: "force", to: "acceleration", relation: "causes" }]);
    await repository.recordCardInteraction({ sessionId: "session-1", learnerId: "learner-1", cardId: "card-1", purpose: "predict", action: "selected", occurredAt: date });
    await repository.recordVisualMetadata({ sessionId: "session-1", learnerId: "learner-1", visualId: "visual-1", concept: "force", durationSeconds: 5, resolution: "480p", outcome: "completed", promptVersion: 1, latencyMs: 120, createdAt: date });
    await repository.recordOperationalMetric({ sessionId: "session-1", learnerId: "learner-1", name: "latency", value: 12, unit: "milliseconds", dimensions: { region: "iad" }, recordedAt: date });
    expect(sql.calls.length).toBeGreaterThan(0);
    expect(sql.calls.every((call) => Array.isArray(call.parameters))).toBe(true);
    const compactCall = sql.calls.find((call) => call.text.includes("WITH summary") && call.parameters[0] === "session-2");
    expect(String(compactCall?.parameters[2])).toHaveLength(2_000);
    expect(compactCall?.parameters[3]).toHaveLength(20);
    expect(JSON.parse(String(compactCall?.parameters[6]))).toHaveLength(24);
    await expect(repository.saveCompactSessionSummary({ sessionId: "bad", userId: "learner-1", summary: " ", concepts: [], startedAt: date, endedAt: date })).rejects.toThrow("summary is required");
  });
});
