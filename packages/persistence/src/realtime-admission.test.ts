import { describe, expect, it } from "vitest";
import { InMemoryRedis, RedisSessionStore } from "./index";

const ENCRYPTION_KEY = Buffer.alloc(32, 23).toString("base64");
const LEARNER_ID = "lrn_abcdefghijklmnop";
const SESSION_ID = "10000000-0000-4000-8000-000000000001";
let attemptSequence = 0;
const newAttemptId = () => `attempt-${attemptSequence += 1}`;

class AtomicRealtimeRedis extends InMemoryRedis {}

const realtimeStore = (redis = new AtomicRealtimeRedis()) => ({
  redis,
  store: new RedisSessionStore(redis, { transcriptEncryptionKey: ENCRYPTION_KEY }),
});


describe("Redis anonymous admission", () => {
  it("shares network and global ceilings across newly generated learner ids", async () => {
    const store = new RedisSessionStore(new InMemoryRedis(), {
      transcriptEncryptionKey: ENCRYPTION_KEY,
    });
    const limits = { networkId: "203.0.113.9", globalLimit: 10, networkLimit: 1, windowSeconds: 3_600 };
    await expect(store.admitAnonymousLearner({ ...limits, learnerId: LEARNER_ID }))
      .resolves.toEqual({ allowed: true });
    await expect(store.admitAnonymousLearner({ ...limits, learnerId: "lrn_qrstuvwxyzABCDEF" }))
      .resolves.toMatchObject({ allowed: false, reason: "network_limit" });
  });

  it("enforces the production-wide ceiling across different networks", async () => {
    const store = new RedisSessionStore(new InMemoryRedis(), {
      transcriptEncryptionKey: ENCRYPTION_KEY,
    });
    const limits = { globalLimit: 1, networkLimit: 10, windowSeconds: 3_600 };
    await store.admitAnonymousLearner({ ...limits, learnerId: LEARNER_ID, networkId: "203.0.113.9" });
    await expect(store.admitAnonymousLearner({
      ...limits,
      learnerId: "lrn_qrstuvwxyzABCDEF",
      networkId: "203.0.113.10",
    })).resolves.toMatchObject({ allowed: false, reason: "global_limit" });
  });

  it("releases a learner admission once and only for its bound network", async () => {
    const redis = new InMemoryRedis();
    const store = new RedisSessionStore(redis, { transcriptEncryptionKey: ENCRYPTION_KEY });
    const limits = { globalLimit: 1, networkLimit: 1, windowSeconds: 3_600 };
    await store.admitAnonymousLearner({ ...limits, learnerId: LEARNER_ID, networkId: "203.0.113.9" });

    await store.releaseAnonymousLearner({ learnerId: LEARNER_ID, networkId: "203.0.113.10" });
    await expect(store.admitAnonymousLearner({
      ...limits,
      learnerId: "lrn_qrstuvwxyzABCDEF",
      networkId: "203.0.113.10",
    })).resolves.toMatchObject({ allowed: false, reason: "global_limit" });

    await store.releaseAnonymousLearner({ learnerId: LEARNER_ID, networkId: "203.0.113.9" });
    await store.releaseAnonymousLearner({ learnerId: LEARNER_ID, networkId: "203.0.113.9" });
    await expect(store.admitAnonymousLearner({
      ...limits,
      learnerId: "lrn_qrstuvwxyzABCDEF",
      networkId: "203.0.113.10",
    })).resolves.toEqual({ allowed: true });
  });
});

describe("Redis realtime call admission", () => {
  it("allows one negotiation per learner and releases only the owning lease", async () => {
    const { store } = realtimeStore();

    const first = await store.reserveRealtimeCall(LEARNER_ID, SESSION_ID, newAttemptId());
    expect(first).toMatchObject({ allowed: true, leaseId: expect.any(String) });
    await expect(store.reserveRealtimeCall(LEARNER_ID, "10000000-0000-4000-8000-000000000002", newAttemptId())).resolves.toMatchObject({
      allowed: false,
      reason: "concurrency_limit",
    });
    if (!first.allowed) throw new Error("Expected a realtime admission lease");
    await expect(store.releaseRealtimeCall(
      LEARNER_ID,
      "55555555-5555-4555-8555-555555555555",
    )).resolves.toBe(false);
    await expect(store.releaseRealtimeCall(LEARNER_ID, first.leaseId)).resolves.toBe(true);
    await expect(store.reserveRealtimeCall(LEARNER_ID, "10000000-0000-4000-8000-000000000003", newAttemptId())).resolves.toMatchObject({
      allowed: true,
    });
  });
  it("atomically replaces only an active call for the same learner and session", async () => {
    const { store } = realtimeStore();
    const first = await store.reserveRealtimeCall(LEARNER_ID, SESSION_ID, "replace-initial");
    if (!first.allowed) throw new Error("Expected initial admission");
    await store.activateRealtimeCall(LEARNER_ID, SESSION_ID, first.leaseId, "rtc_replace-initial");

    const replacement = await store.replaceRealtimeCall(LEARNER_ID, SESSION_ID, "replace-stable");
    expect(replacement).toMatchObject({ allowed: true, leaseId: expect.any(String) });
    await expect(store.replaceRealtimeCall(LEARNER_ID, SESSION_ID, "replace-stable"))
      .resolves.toEqual(replacement);
    await expect(store.replaceRealtimeCall(
      LEARNER_ID,
      "10000000-0000-4000-8000-000000000002",
      "replace-other-session",
    )).resolves.toMatchObject({ allowed: false, reason: "concurrency_limit" });
  });


  it("atomically returns the active call command revision", async () => {
    const { store } = realtimeStore();
    const admission = await store.reserveRealtimeCall(LEARNER_ID, SESSION_ID, newAttemptId());
    if (!admission.allowed) throw new Error("Expected a realtime admission lease");
    const callId = "rtc_active-call";
    await store.activateRealtimeCall(LEARNER_ID, SESSION_ID, admission.leaseId, callId);
    await store.setActiveState(SESSION_ID, { revision: 7, status: "active" });

    await expect(store.getActiveRealtimeCall(LEARNER_ID, SESSION_ID, callId))
      .resolves.toEqual({ commandRevision: 7 });
    await expect(store.getActiveRealtimeCall(LEARNER_ID, SESSION_ID, "rtc_other-call"))
      .resolves.toBeUndefined();
    await store.releaseRealtimeCall(LEARNER_ID, admission.leaseId);
    await expect(store.getActiveRealtimeCall(LEARNER_ID, SESSION_ID, callId))
      .resolves.toBeUndefined();
  });

  it("claims one live gateway ticket nonce against the exact active call", async () => {
    const { store } = realtimeStore();
    const admission = await store.reserveRealtimeCall(LEARNER_ID, SESSION_ID, newAttemptId());
    if (!admission.allowed) throw new Error("Expected a realtime admission lease");
    const callId = "rtc_ticket-call";
    await store.activateRealtimeCall(LEARNER_ID, SESSION_ID, admission.leaseId, callId);
    const claim = {
      nonce: "nonce_abcdefghijklmnop",
      learnerId: LEARNER_ID,
      sessionId: SESSION_ID,
      callId,
      expiresAtUnixSeconds: 1_800,
    };

    await expect(store.claimGatewayTicket(claim, 1_700)).resolves.toBe(true);
    await expect(store.claimGatewayTicket(claim, 1_700)).resolves.toBe(false);
    await expect(store.claimGatewayTicket({ ...claim, nonce: "nonce_qrstuvwxyzABCDEF", callId: "rtc_wrong" }, 1_700))
      .resolves.toBe(false);
    await expect(store.claimGatewayTicket({ ...claim, nonce: "nonce_expiredABCDEFGH" }, 1_800))
      .resolves.toBe(false);
  });

  it("enforces the fixed per-learner attempt budget", async () => {
    const { store } = realtimeStore();

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const admission = await store.reserveRealtimeCall(
        LEARNER_ID,
        `10000000-0000-4000-8000-${String(attempt + 10).padStart(12, "0")}`,
        newAttemptId(),
      );
      if (admission.allowed) {
        await store.releaseRealtimeCall(LEARNER_ID, admission.leaseId);
      }
    }

    await expect(store.reserveRealtimeCall(LEARNER_ID, "10000000-0000-4000-8000-000000000099", newAttemptId())).resolves.toMatchObject({
      allowed: false,
      reason: "rate_limit",
      retryAfterSeconds: expect.any(Number),
    });
  });
  it("replays one stable attempt without charging twice and fences terminal sessions before counters", async () => {
    const { redis, store } = realtimeStore();
    const attemptId = "stable-lost-response";
    const first = await store.reserveRealtimeCall(LEARNER_ID, SESSION_ID, attemptId);
    if (!first.allowed) throw new Error("Expected a realtime admission lease");

    await expect(store.reserveRealtimeCall(LEARNER_ID, SESSION_ID, attemptId))
      .resolves.toEqual(first);
    await redis.set(`axiom:session:${SESSION_ID}:terminal`, "1", { ex: 300 });
    await expect(store.reserveRealtimeCall(LEARNER_ID, SESSION_ID, "after-terminal"))
      .resolves.toMatchObject({ allowed: false, reason: "terminal" });
  });


  it("holds an activated lease until the application session closes", async () => {
    const { store } = realtimeStore();
    const admission = await store.reserveRealtimeCall(LEARNER_ID, SESSION_ID, newAttemptId());
    if (!admission.allowed) throw new Error("Expected a realtime admission lease");
    await expect(store.activateRealtimeCall(
      LEARNER_ID,
      SESSION_ID,
      admission.leaseId,
      "rtc_provider-call-1234",
    )).resolves.toBe(true);
    await expect(store.isRealtimeCallActive(
      LEARNER_ID,
      SESSION_ID,
      "rtc_provider-call-1234",
    )).resolves.toBe(true);
    await expect(store.isRealtimeCallActive(
      LEARNER_ID,
      SESSION_ID,
      "rtc_wrong-call",
    )).resolves.toBe(false);
    await expect(store.reserveRealtimeCall(
      LEARNER_ID,
      "10000000-0000-4000-8000-000000000004",
      newAttemptId(),
    )).resolves.toMatchObject({ allowed: false, reason: "concurrency_limit" });
    await expect(store.releaseRealtimeSession(SESSION_ID)).resolves.toBe(true);
    await expect(store.reserveRealtimeCall(
      LEARNER_ID,
      "10000000-0000-4000-8000-000000000005",
      newAttemptId(),
    )).resolves.toMatchObject({ allowed: true });
  });
});
