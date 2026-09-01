import type { SessionEvent } from "@axiom/protocol";
import { decodeRetainedPayloadKey, decryptRetainedPayload, encryptRetainedPayload } from "@axiom/persistence";
import { beforeEach, describe, expect, it, vi } from "vitest";

const redisState = vi.hoisted(() => ({
  instances: [] as Array<{
    status: string;
    handlers: Record<string, (...args: string[]) => void>;
    connect: ReturnType<typeof vi.fn>;
    psubscribe: ReturnType<typeof vi.fn>;
    publish: ReturnType<typeof vi.fn>;
    set: ReturnType<typeof vi.fn>;
    xadd: ReturnType<typeof vi.fn>;
    get: ReturnType<typeof vi.fn>;
    incr: ReturnType<typeof vi.fn>;
    expire: ReturnType<typeof vi.fn>;
    del: ReturnType<typeof vi.fn>;
    eval: ReturnType<typeof vi.fn>;
    decr: ReturnType<typeof vi.fn>;
    rpush: ReturnType<typeof vi.fn>;
    lrange: ReturnType<typeof vi.fn>;
    lrem: ReturnType<typeof vi.fn>;
    llen: ReturnType<typeof vi.fn>;
    quit: ReturnType<typeof vi.fn>;
    duplicate: () => unknown;
    on: (event: string, callback: (...args: string[]) => void) => void;
  }>
}));

const neonState = vi.hoisted(() => ({
  query: vi.fn()
}));

vi.mock("@neondatabase/serverless", () => ({
  neon: vi.fn(() => ({ query: neonState.query }))
}));

vi.mock("ioredis", () => {
  class RedisMock {
    status = "ready";
    handlers: Record<string, (...args: string[]) => void> = {};
    connect = vi.fn(async () => undefined);
    psubscribe = vi.fn(async () => 1);
    xadd = vi.fn(async () => "1-0");
    publish = vi.fn(async () => 1);
    set = vi.fn(async () => "OK");
    get = vi.fn(async () => null);
    incr = vi.fn(async () => 1);
    expire = vi.fn(async () => 1);
    del = vi.fn(async () => 1);
    eval = vi.fn(async () => 1);
    decr = vi.fn(async () => 0);
    rpush = vi.fn(async () => 1);
    lrange = vi.fn(async () => []);
    lrem = vi.fn(async () => 1);
    llen = vi.fn(async () => 0);
    quit = vi.fn(async () => "OK");
    constructor() { redisState.instances.push(this); }
    duplicate(): RedisMock { return new RedisMock(); }
    on(event: string, callback: (...args: string[]) => void): void { this.handlers[event] = callback; }
  }
  return { default: RedisMock };
});

import {
  InMemoryGatewayDurableSink,
  NeonGatewayDurableSink,
  normalizeSocketNetworkIdentity,
  SessionEventBus
} from "./event-bus.js";
import type { SafeLogger } from "./logger.js";

const logger = { write: vi.fn() } as unknown as SafeLogger;
const STATUS: SessionEvent = { protocolVersion: 1, type: "session.status", state: "listening" };
const ENCRYPTION_KEY = Buffer.alloc(32, 19).toString("base64");
const SESSION_STATE = {
  eventRevision: 3,
  lastCommandRevision: 2,
  canvas: {
    revision: 1,
    cards: [],
    cardPrompt: null,
    visual: {
      status: "idle" as const,
      spec: null,
      visualOperationId: null,
      isDimmed: false,
      lastFrameUrl: null
    }
  }
};

beforeEach(() => {
  redisState.instances.length = 0;
  vi.clearAllMocks();
  neonState.query.mockReset();
});

describe("SessionEventBus", () => {
  it("delivers locally and uses deterministic in-memory durability/state without Redis", async () => {
    const sink = {
      writeLearningEvidence: vi.fn(async () => undefined),
      writeSessionSummary: vi.fn(async () => undefined),
      writeCardInteraction: vi.fn(async () => undefined),
      writeVisualMetadata: vi.fn(async () => undefined)
    };
    const bus = new SessionEventBus(undefined, logger, sink);
    const received: SessionEvent[] = [];
    const unsubscribe = bus.subscribe("session", "learner", (event) => received.push(event));
    await bus.connect();
    await bus.bindSessionOwner("session", "learner");
    await bus.publish("session", "learner", STATUS);

    expect(received).toEqual([STATUS]);
    expect(await bus.claimCommand("session", "command")).toBe(true);
    expect(await bus.writeDurableEvent("session_summary", "summary:session", "session", "learner", {})).toBe(true);
    expect(sink.writeSessionSummary).toHaveBeenCalledOnce();
    unsubscribe();
    await bus.publish("session", "learner", STATUS);
    expect(received).toHaveLength(1);
    await bus.close();
  });

  it("connects Redis fanout, rejects malformed remote events, and persists idempotency/state", async () => {
    const sink = {
      writeLearningEvidence: vi.fn(async () => undefined),
      writeSessionSummary: vi.fn(async () => undefined),
      writeCardInteraction: vi.fn(async () => undefined),
      writeVisualMetadata: vi.fn(async () => undefined)
    };
    const bus = new SessionEventBus("redis://localhost:6379", logger, sink, {
      transcriptEncryptionKey: ENCRYPTION_KEY
    });
    const received: SessionEvent[] = [];
    bus.subscribe("session", "learner", (event) => received.push(event));
    await bus.connect();
    const publisher = redisState.instances[0]!;
    const receiver = redisState.instances[1]!;
    await bus.bindSessionOwner("session", "learner");

    await bus.publish("session", "learner", STATUS);
    expect(publisher.eval.mock.calls.at(-1)?.[0]).toContain("session-event-fanout");
    const channel = "axiom:session:session:events";
    receiver.handlers.pmessage?.(
      "axiom:session:*:events",
      channel,
      encryptRetainedPayload(
        JSON.stringify({ origin: "remote", learnerId: "learner", event: STATUS }),
        decodeRetainedPayloadKey(ENCRYPTION_KEY),
        `gateway-event-pubsub|session|${channel}`
      )
    );
    receiver.handlers.pmessage?.("axiom:session:*:events", channel, "not-json");
    expect(received).toHaveLength(2);
    expect(await bus.claimCommand("session", "command")).toBe(true);
    publisher.set.mockResolvedValueOnce(null);
    expect(await bus.claimCommand("session", "duplicate")).toBe(false);
    expect(await bus.nextEventRevision("session", 0)).toBe(1);
    expect(publisher.incr).toHaveBeenCalledWith("axiom:session-revision:session");
    expect(await bus.writeDurableEvent("learning_evidence", "tool:session:one", "session", "learner", { concept: "light" })).toBe(true);
    expect(sink.writeLearningEvidence).toHaveBeenCalledOnce();
    await bus.close();
    expect(receiver.quit).toHaveBeenCalledOnce();
  });

  it("reports durable writes as failed and never acknowledges them when the database rejects", async () => {
    const sink = {
      writeLearningEvidence: vi.fn(async () => { throw new Error("database unavailable"); }),
      writeSessionSummary: vi.fn(async () => undefined),
      writeCardInteraction: vi.fn(async () => undefined),
      writeVisualMetadata: vi.fn(async () => undefined)
    };
    const bus = new SessionEventBus(undefined, logger, sink);
    await bus.connect();

    await expect(bus.writeDurableEvent("learning_evidence", "tool:session:one", "session", "learner", { concept: "light" })).resolves.toBe(false);
    expect(logger.write).toHaveBeenCalledWith(
      "warn",
      "Durable database write failed",
      expect.objectContaining({ provider: "gateway" })
    );
    await bus.close();
  });
  it("fails readiness when the required PostgreSQL schema probe fails", async () => {
    const sink = {
      probeReadiness: vi.fn(async () => false),
      writeLearningEvidence: vi.fn(async () => undefined),
      writeSessionSummary: vi.fn(async () => undefined),
      writeCardInteraction: vi.fn(async () => undefined),
      writeVisualMetadata: vi.fn(async () => undefined)
    };
    const bus = new SessionEventBus(undefined, logger, sink);
    await bus.connect();
    expect(bus.readiness()).toEqual({ redis: true, database: false, durableOutbox: true });
    expect(bus.isReady()).toBe(false);
    await bus.close();
  });

  it("retains failed durable writes encrypted in Redis and marks the outbox unhealthy", async () => {
    const sink = {
      probeReadiness: vi.fn(async () => true),
      writeLearningEvidence: vi.fn(async () => { throw new Error("database unavailable"); }),
      writeSessionSummary: vi.fn(async () => undefined),
      writeCardInteraction: vi.fn(async () => undefined),
      writeVisualMetadata: vi.fn(async () => undefined)
    };
    const bus = new SessionEventBus("rediss://localhost:6379", logger, sink, {
      transcriptEncryptionKey: ENCRYPTION_KEY
    });
    await bus.connect();
    const publisher = redisState.instances[0]!;
    await expect(bus.writeDurableEvent(
      "learning_evidence",
      "tool:session:one",
      "session",
      "learner",
      { concept: "light" }
    )).resolves.toBe(true);
    const retained = String(publisher.rpush.mock.calls[0]?.[1]);
    expect(retained).toMatch(/^v2\./);
    expect(retained).not.toContain("light");
    expect(bus.readiness().durableOutbox).toBe(false);
    await bus.close();
  });

  it("replays completed command events without accepting the operation twice", async () => {
    const bus = new SessionEventBus(undefined, logger);
    await bus.connect();
    const started = await bus.beginCommandOperation("session", "command", 1, 0);
    expect(started).toMatchObject({ state: "accepted" });
    if (started.state !== "accepted") throw new Error("Expected accepted command");
    await expect(bus.completeCommandOperation("session", "command", started.attemptToken, [STATUS])).resolves.toBe(true);
    await expect(bus.beginCommandOperation("session", "command", 1, 1))
      .resolves.toEqual({ state: "completed", events: [STATUS] });
    await bus.close();
  });

  it("writes each durable event idempotency key only once", async () => {
    const sink = new InMemoryGatewayDurableSink();
    const bus = new SessionEventBus(undefined, logger, sink);

    await bus.writeDurableEvent("learning_evidence", "tool:session:one", "session", "learner", { concept: "light" });
    await bus.writeDurableEvent("learning_evidence", "tool:session:one", "session", "learner", { concept: "light" });

    expect(sink.learningEvidence).toHaveLength(1);
  });

  it("fails closed without Redis when production guarantees are required", async () => {
    const bus = new SessionEventBus(undefined, logger, undefined, { requireRedis: true });

    expect(bus.isReady()).toBe(false);
    await expect(bus.connect()).rejects.toThrow("Redis is required");
    await expect(bus.claimCommand("session", "command")).rejects.toThrow("Redis idempotency unavailable");
  });

  it("caps active sessions and paid commands per learner in local development", async () => {
    const bus = new SessionEventBus(undefined, logger, undefined, {
      maxActiveSessionsPerLearner: 1,
      maxPaidCommandsPerLearner: 1
    });

    await expect(bus.bindSessionOwner("session-one", "learner")).resolves.toMatchObject({ learnerId: "learner" });
    await expect(bus.bindSessionOwner("session-two", "learner")).resolves.toBeUndefined();
    await expect(bus.reservePaidCommand("learner")).resolves.toBe(true);
    await expect(bus.reservePaidCommand("learner")).resolves.toBe(false);
  });
  it("atomically caps live sockets and releases permits without leaking denied attempts", async () => {
    const bus = new SessionEventBus(undefined, logger, undefined, {
      maxSocketsPerSession: 2,
      maxSocketsPerLearner: 3,
      maxSocketsPerNetwork: 4
    });
    const first = await bus.reserveSocketPermit("session-one", "learner-one", "203.0.113.10");
    const second = await bus.reserveSocketPermit("session-one", "learner-one", "203.0.113.10");
    expect(first).toBeDefined();
    expect(second).toBeDefined();

    await expect(bus.reserveSocketPermit("session-one", "learner-one", "203.0.113.10")).resolves.toBeUndefined();
    await expect(bus.reserveSocketPermit("session-one", "learner-one", "203.0.113.10")).resolves.toBeUndefined();

    await bus.releaseSocketPermit(first!);
    const replacement = await bus.reserveSocketPermit("session-one", "learner-one", "203.0.113.10");
    expect(replacement).toBeDefined();
    const learnerThird = await bus.reserveSocketPermit("session-two", "learner-one", "203.0.113.10");
    expect(learnerThird).toBeDefined();
    await expect(bus.reserveSocketPermit("session-three", "learner-one", "203.0.113.10")).resolves.toBeUndefined();

    const networkFourth = await bus.reserveSocketPermit("session-four", "learner-two", "203.0.113.10");
    expect(networkFourth).toBeDefined();
    await expect(bus.reserveSocketPermit("session-five", "learner-three", "203.0.113.10")).resolves.toBeUndefined();

    await Promise.all([second!, replacement!, learnerThird!, networkFourth!].map((permit) =>
      bus.releaseSocketPermit(permit)
    ));
    await expect(bus.reserveSocketPermit("session-five", "learner-three", "203.0.113.10")).resolves.toBeDefined();
    await bus.close();
  });

  it("groups trusted IPv6 connection identities by /64 for network fairness", async () => {
    expect(normalizeSocketNetworkIdentity("2001:0db8:1234:5678::1"))
      .toBe(normalizeSocketNetworkIdentity("2001:db8:1234:5678:ffff::9"));
    expect(normalizeSocketNetworkIdentity("::ffff:192.0.2.10")).toBe("192.0.2.10");
    const bus = new SessionEventBus(undefined, logger, undefined, {
      maxSocketsPerSession: 2,
      maxSocketsPerLearner: 2,
      maxSocketsPerNetwork: 1
    });
    await expect(bus.reserveSocketPermit(
      "session-one",
      "learner-one",
      "2001:db8:1234:5678::1"
    )).resolves.toBeDefined();
    await expect(bus.reserveSocketPermit(
      "session-two",
      "learner-two",
      "2001:db8:1234:5678::2"
    )).resolves.toBeUndefined();
    await bus.close();
  });

  it("persists, hydrates, and clears local recovery state without regressing revisions", async () => {
    const bus = new SessionEventBus(undefined, logger);

    await bus.persistSessionState("session", SESSION_STATE);
    await bus.persistSessionState("session", {
      ...SESSION_STATE,
      eventRevision: 2,
      lastCommandRevision: 1
    });
    expect(await bus.hydrateSessionState("session")).toEqual(SESSION_STATE);
    expect(await bus.nextEventRevision("session", 0)).toBe(4);

    await bus.appendTranscript("session", "command-one:learner", { role: "learner", text: "Why?" });
    await bus.appendTranscript("session", "command-one:assistant", { role: "tutor", text: "Because." });
    await bus.appendTranscript("session", "command-one:assistant", { role: "tutor", text: "Because." });
    expect(await bus.hydrateTranscript("session")).toEqual([
      { role: "learner", text: "Why?" },
      { role: "tutor", text: "Because." }
    ]);

    await bus.clearSessionState("session");
    expect(await bus.hydrateSessionState("session")).toBeUndefined();
    expect(await bus.hydrateTranscript("session")).toEqual([]);
    await bus.close();
  });

  it("encrypts Redis recovery state and transcripts and rejects corrupt persisted state", async () => {
    const bus = new SessionEventBus("rediss://localhost:6379", logger, undefined, {
      transcriptEncryptionKey: ENCRYPTION_KEY,
      activeTranscriptTtlSeconds: 123
    });
    const publisher = redisState.instances[0]!;
    await bus.connect();
    await bus.persistSessionState("session", SESSION_STATE);

    const encryptedState = String(publisher.eval.mock.calls.at(-1)?.[6]);
    expect(encryptedState).toMatch(/^v2\./);
    expect(JSON.parse(decryptRetainedPayload(
      encryptedState,
      decodeRetainedPayloadKey(ENCRYPTION_KEY),
      "gateway-state|session|axiom:session-state:session"
    ))).toEqual(SESSION_STATE);

    publisher.get.mockResolvedValueOnce(encryptedState);
    expect(await bus.hydrateSessionState("session")).toEqual(SESSION_STATE);
    publisher.get.mockResolvedValueOnce("corrupt");
    expect(await bus.hydrateSessionState("session")).toBeUndefined();
    expect(logger.write).toHaveBeenCalledWith(
      "warn",
      "Rejected invalid persisted session state",
      { provider: "redis", recoverable: true }
    );

    await bus.appendTranscript("session", "command-one:learner", { role: "learner", text: "secret" });
    const encryptedTranscript = String(publisher.eval.mock.calls.at(-1)?.[5]);
    expect(encryptedTranscript).not.toContain("secret");
    expect(publisher.eval.mock.calls.at(-1)?.[0]).toContain("transcript-append-once-terminal-fenced");
    publisher.lrange.mockResolvedValueOnce([encryptedTranscript]);
    expect(await bus.hydrateTranscript("session")).toEqual([{ role: "learner", text: "secret" }]);

    await bus.clearSessionState("session");
    expect(publisher.del).toHaveBeenCalledWith(
      "axiom:session-state:session",
      "axiom:session-revision:session",
      "axiom:session-transcript:session"
    );
    await bus.close();
  });

  it("fences command completion with the accepted attempt token", async () => {
    const bus = new SessionEventBus(undefined, logger);
    expect(await bus.beginCommandOperation("session", "first", 2, 0)).toEqual({ state: "stale" });
    const started = await bus.beginCommandOperation("session", "first", 1, 0);
    expect(started).toMatchObject({ state: "accepted" });
    if (started.state !== "accepted") throw new Error("Expected accepted command");
    expect(await bus.beginCommandOperation("session", "first", 1, 0)).toEqual({ state: "pending" });
    expect(await bus.completeCommandOperation("session", "first", "stale-attempt", [STATUS])).toBe(false);
    expect(await bus.completeCommandOperation("session", "first", started.attemptToken, [STATUS])).toBe(true);
    expect(await bus.beginCommandOperation("session", "first", 1, 1)).toEqual({
      state: "completed",
      events: [STATUS]
    });
    await bus.close();
  });

  it("replays encrypted Redis command results and compare-completes attempts", async () => {
    const bus = new SessionEventBus("redis://localhost:6379", logger, undefined, {
      transcriptEncryptionKey: ENCRYPTION_KEY
    });
    const publisher = redisState.instances[0]!;
    await bus.connect();
    const resultKey = "axiom:command-operation:session:done:result";
    const encryptedEvents = encryptRetainedPayload(
      JSON.stringify([STATUS]),
      decodeRetainedPayloadKey(ENCRYPTION_KEY),
      `command-result|session|${resultKey}`
    );
    publisher.get.mockResolvedValueOnce(null).mockResolvedValueOnce(encryptedEvents);
    publisher.eval.mockResolvedValueOnce(3);
    expect(await bus.beginCommandOperation("session", "done", 1, 0)).toEqual({
      state: "completed",
      events: [STATUS]
    });

    publisher.get.mockResolvedValueOnce(null);
    publisher.eval.mockResolvedValueOnce(1);
    const accepted = await bus.beginCommandOperation("session", "next", 1, 0);
    expect(accepted).toMatchObject({ state: "accepted" });
    if (accepted.state !== "accepted") throw new Error("Expected accepted command");
    publisher.eval.mockResolvedValueOnce(1);
    await expect(bus.completeCommandOperation("session", "next", accepted.attemptToken, [STATUS], 60)).resolves.toBe(true);
    const completionPayload = String(publisher.eval.mock.calls.at(-1)?.[6]);
    expect(JSON.parse(decryptRetainedPayload(
      completionPayload,
      decodeRetainedPayloadKey(ENCRYPTION_KEY),
      "command-result|session|axiom:command-operation:session:next:result"
    ))).toEqual([STATUS]);
    await bus.close();
  });

  it("compare-refreshes and compare-releases gateway instance ownership", async () => {
    const local = new SessionEventBus(undefined, logger, undefined, {
      maxActiveSessionsPerLearner: 2,
      maxPaidCommandsPerLearner: 1
    });
    const lease = await local.bindSessionOwner("session", "learner", "call-one");
    expect(lease).toMatchObject({ sessionId: "session", learnerId: "learner", callId: "call-one" });
    if (!lease) throw new Error("Expected owner lease");
    expect(await local.bindSessionOwner("session", "attacker")).toBeUndefined();
    expect(await local.refreshSessionOwner(lease, "call-two")).toBe(true);
    expect(await local.reservePaidCommand("learner", "operation")).toBe(true);
    expect(await local.reservePaidCommand("learner", "operation")).toBe(true);
    expect(await local.reservePaidCommand("learner", "another")).toBe(false);
    expect(await local.releaseSessionOwner({ ...lease, gatewayInstanceToken: "stale" })).toBe(false);
    expect(await local.refreshSessionOwner(lease)).toBe(true);
    expect(await local.releaseSessionOwner(lease)).toBe(true);
    await local.close();

    const redis = new SessionEventBus("redis://localhost:6379", logger, undefined, {
      transcriptEncryptionKey: ENCRYPTION_KEY
    });
    const publisher = redisState.instances[0]!;
    await redis.connect();
    publisher.eval.mockResolvedValueOnce(1);
    const redisLease = await redis.bindSessionOwner("session", "learner", "call-one");
    expect(redisLease).toMatchObject({ sessionId: "session", learnerId: "learner" });
    if (!redisLease) throw new Error("Expected Redis owner lease");
    publisher.eval.mockResolvedValueOnce(0);
    expect(await redis.refreshSessionOwner({ ...redisLease, gatewayInstanceToken: "old-instance" })).toBe(false);
    publisher.eval.mockResolvedValueOnce(0);
    expect(await redis.releaseSessionOwner({ ...redisLease, gatewayInstanceToken: "old-instance" })).toBe(false);
    await redis.close();
  });
  it("does not duplicate a transcript effect after owner loss and takeover", async () => {
    const bus = new SessionEventBus(undefined, logger);
    const firstOwner = await bus.bindSessionOwner("session", "learner", "call-one");
    if (!firstOwner) throw new Error("Expected first owner");
    await bus.appendTranscript("session", "command-one:assistant", { role: "tutor", text: "Stable reply" });
    await bus.releaseSessionOwner(firstOwner);
    const replacement = await bus.bindSessionOwner("session", "learner", "call-one");
    if (!replacement) throw new Error("Expected replacement owner");
    await bus.appendTranscript("session", "command-one:assistant", { role: "tutor", text: "Stable reply" });
    expect(await bus.hydrateTranscript("session")).toEqual([{ role: "tutor", text: "Stable reply" }]);
    await bus.close();
  });

  it("atomically claims a live unexpired gateway ticket in the persistence namespace", async () => {
    const bus = new SessionEventBus("redis://localhost:6379", logger, undefined, {
      transcriptEncryptionKey: ENCRYPTION_KEY
    });
    const publisher = redisState.instances[0]!;
    await bus.connect();
    publisher.eval.mockResolvedValueOnce(1);
    await expect(bus.claimGatewayTicket({
      nonce: "abcdefghijklmnop",
      learnerId: "lrn_abcdefghijklmnop",
      sessionId: "33333333-3333-4333-8333-333333333333",
      callId: "rtc_12345678",
      expiresAtUnixSeconds: 1_060
    }, 1_000)).resolves.toBe(true);
    const claim = publisher.eval.mock.calls.at(-1);
    expect(claim?.[0]).toContain("axiom-gateway-ticket-claim");
    expect(claim?.[4]).toMatch(/^axiom:gateway:ticket-nonce:/);
    await expect(bus.claimGatewayTicket({
      nonce: "abcdefghijklmnop",
      learnerId: "lrn_abcdefghijklmnop",
      sessionId: "33333333-3333-4333-8333-333333333333",
      callId: "rtc_12345678",
      expiresAtUnixSeconds: 1_000
    }, 1_000)).resolves.toBe(false);
    await bus.close();
  });


  it("drains encrypted durable outbox entries and reports drain failures", async () => {
    const sink = {
      probeReadiness: vi.fn(async () => true),
      writeLearningEvidence: vi.fn(async () => undefined),
      writeSessionSummary: vi.fn(async () => undefined),
      writeCardInteraction: vi.fn(async () => undefined),
      writeVisualMetadata: vi.fn(async () => undefined)
    };
    const envelope = {
      version: 1 as const,
      kind: "session_summary" as const,
      eventId: "summary:session",
      sessionId: "session",
      learnerId: "learner",
      payload: { summary: "Completed" }
    };
    const retained = encryptRetainedPayload(
      JSON.stringify(envelope),
      decodeRetainedPayloadKey(ENCRYPTION_KEY),
      "gateway-outbox|axiom:gateway-durable-outbox"
    );
    const poison = encryptRetainedPayload(
      JSON.stringify({ version: 1, kind: "unknown", eventId: "poison" }),
      decodeRetainedPayloadKey(ENCRYPTION_KEY),
      "gateway-outbox|axiom:gateway-durable-outbox"
    );
    const bus = new SessionEventBus("redis://localhost:6379", logger, sink, {
      transcriptEncryptionKey: ENCRYPTION_KEY
    });
    const publisher = redisState.instances[0]!;
    publisher.lrange.mockResolvedValueOnce([poison, retained]);
    publisher.llen.mockResolvedValueOnce(0);
    await bus.connect();
    expect(sink.writeSessionSummary).toHaveBeenCalledWith(
      "summary:session",
      "session",
      "learner",
      { summary: "Completed" }
    );
    expect(publisher.lrem).toHaveBeenCalledWith("axiom:gateway-durable-outbox", 1, retained);
    expect(publisher.rpush).toHaveBeenCalledWith("axiom:gateway-durable-dead-letter", poison);
    expect(bus.readiness().durableOutbox).toBe(false);
    await bus.close();

    const failing = new SessionEventBus("redis://localhost:6379", logger, sink, {
      transcriptEncryptionKey: ENCRYPTION_KEY
    });
    const failingPublisher = redisState.instances[2]!;
    failingPublisher.lrange.mockRejectedValueOnce(new Error("Redis unavailable"));
    await failing.connect();
    expect(failing.readiness().durableOutbox).toBe(false);
    await failing.close();
  });

  it("returns false when retaining a failed durable write also fails", async () => {
    const sink = {
      writeLearningEvidence: vi.fn(async () => { throw new Error("database unavailable"); }),
      writeSessionSummary: vi.fn(async () => undefined),
      writeCardInteraction: vi.fn(async () => undefined),
      writeVisualMetadata: vi.fn(async () => undefined)
    };
    const bus = new SessionEventBus("redis://localhost:6379", logger, sink, {
      transcriptEncryptionKey: ENCRYPTION_KEY
    });
    const publisher = redisState.instances[0]!;
    await bus.connect();
    publisher.rpush.mockRejectedValueOnce(new Error("Redis unavailable"));

    expect(await bus.writeDurableEvent(
      "learning_evidence",
      "evidence",
      "session",
      "learner",
      { concept: "light" }
    )).toBe(false);
    expect(bus.readiness().durableOutbox).toBe(false);
    await bus.close();
  });

  it("requires encryption for Redis and fails readiness when the database probe throws", async () => {
    expect(() => new SessionEventBus("redis://localhost:6379", logger)).toThrow(
      "TRANSCRIPT_ENCRYPTION_KEY is required with Redis"
    );
    const sink = {
      probeReadiness: vi.fn(async () => { throw new Error("database unavailable"); }),
      writeLearningEvidence: vi.fn(async () => undefined),
      writeSessionSummary: vi.fn(async () => undefined),
      writeCardInteraction: vi.fn(async () => undefined),
      writeVisualMetadata: vi.fn(async () => undefined)
    };
    const bus = new SessionEventBus(undefined, logger, sink);
    await bus.connect();
    expect(bus.readiness().database).toBe(false);
    await bus.close();
  });


  it("persists validated learner progress and bounded summaries through Neon", async () => {
    const sink = new NeonGatewayDurableSink("postgres://gateway");
    neonState.query
      .mockResolvedValueOnce([{ durable_events_ready: true }])
      .mockResolvedValueOnce([{
        mastery: [
          { concept: "refraction", confidence: 0.875, evidenceCount: 3 },
          { concept: "reflection", confidence: 0.5, evidenceCount: 1 }
        ],
        misconceptions: [{ concept: "reflection", description: "Rays bend at a mirror", evidenceCount: 2 }],
        age_band: "13-15",
        explanation_mode: "visual",
        pace: "steady",
        challenge: "balanced",
        interests: ["optics"],
        recent_summaries: ["Compared reflection and refraction."]
      }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    expect(await sink.probeReadiness()).toBe(true);
    expect(neonState.query.mock.calls[0]?.[0]).toContain("required_columns");
    expect(neonState.query.mock.calls[0]?.[0]).toContain("gateway_durable_events_session_idx");
    expect(neonState.query.mock.calls[0]?.[0]).toContain("operational_metrics");
    expect(neonState.query.mock.calls[0]?.[0]).toContain("0004_session_mutation_effects.sql");
    expect(neonState.query.mock.calls[0]?.[0]).toContain("0005_learning_context_retention_indexes.sql");
    expect(await sink.loadLearnerContext("learner")).toEqual(expect.objectContaining({
      mastery: [
        { concept: "refraction", confidence: 0.875, evidenceCount: 3 },
        { concept: "reflection", confidence: 0.5, evidenceCount: 1 }
      ],
      misconceptions: [{ concept: "reflection", description: "Rays bend at a mirror", evidenceCount: 2 }],
      ageBand: "13-15",
      explanationMode: "visual",
      interests: ["optics"],
      recentSummaries: ["Compared reflection and refraction."]
    }));

    await sink.writeLearningEvidence("evidence", "session", "learner", {
      concept: "refraction",
      evidence: "Learner predicted the ray direction",
      confidenceDelta: 0.2,
      misconception: null,
      preferenceSignals: {
        explanationMode: "visual",
        pace: "steady",
        challenge: "balanced",
        interests: ["optics"]
      }
    });
    const evidenceParameters = neonState.query.mock.calls[2]?.[1];
    expect(evidenceParameters).toEqual([
      "learner",
      "refraction",
      0.2,
      "Learner predicted the ray direction",
      null,
      "visual",
      "steady",
      "balanced",
      ["optics"],
      "evidence",
      "session"
    ]);

    await sink.writeSessionSummary("summary", "session", "learner", {
      reason: "complete",
      summary: "  Learner mastered refraction.  ",
      concepts: [" refraction ", "reflection"],
      explorationEdges: [{ from: "reflection", to: "refraction", relation: "compare" }],
      startedAt: "2026-08-31T10:00:00.000Z",
      endedAt: "2026-08-31T10:10:00.000Z",
      startedRegion: "us-east-1"
    });
    expect(neonState.query.mock.calls[4]?.[1]).toEqual([
      "session",
      "learner",
      "Learner mastered refraction.",
      ["refraction", "reflection"],
      new Date("2026-08-31T10:00:00.000Z"),
      new Date("2026-08-31T10:10:00.000Z"),
      "summary",
      JSON.stringify([{ from: "reflection", to: "refraction", relation: "compare" }])
    ]);
    await sink.writeCardInteraction("card:selected", {
      sessionId: "session",
      learnerId: "learner",
      cardId: "card-one",
      purpose: "compare",
      action: "selected",
      concept: "refraction",
      occurredAt: new Date("2026-08-31T10:05:00.000Z")
    });
    expect(neonState.query.mock.calls[5]?.[0]).toContain("card_interactions");

    await sink.writeVisualMetadata("visual:one", {
      sessionId: "session",
      learnerId: "learner",
      visualId: "visual-one",
      concept: "refraction",
      durationSeconds: 5,
      resolution: "768p",
      outcome: "completed",
      promptVersion: 2,
      latencyMs: 450,
      createdAt: new Date("2026-08-31T10:06:00.000Z")
    });
    expect(neonState.query.mock.calls[6]?.[0]).toContain("visual_metadata");
  });

  it("returns a complete empty learner context when Neon has no retained profile fields", async () => {
    const sink = new NeonGatewayDurableSink("postgres://gateway");
    neonState.query.mockResolvedValueOnce([{}]);

    expect(await sink.loadLearnerContext("learner")).toEqual({
      mastery: [],
      misconceptions: [],
      interests: [],
      recentSummaries: [],
      instructionLines: [],
    });
  });

  it("keeps in-memory session summaries idempotent and provides empty learner context", async () => {
    const sink = new InMemoryGatewayDurableSink();
    expect(await sink.probeReadiness()).toBe(true);
    expect(await sink.loadLearnerContext("learner")).toEqual({
      mastery: [],
      misconceptions: [],
      interests: [],
      recentSummaries: [],
      instructionLines: []
    });

    await sink.writeSessionSummary("summary", "session", "learner", { summary: "Complete" });
    await sink.writeSessionSummary("summary", "session", "learner", { summary: "Duplicate" });
    expect(sink.sessionSummaries).toEqual([
      { sessionId: "session", learnerId: "learner", summary: "Complete" }
    ]);
  });

});
