import type { SessionEvent } from "@axiom/protocol";
import { beforeEach, describe, expect, it } from "vitest";
import { SessionService, SessionServiceError, type SessionServiceDependencies } from "./service";
import type { ActiveLessonState } from "./schemas";
type FakeSessionStoreContract = SessionServiceDependencies["sessions"];


class FakeSessionStore implements FakeSessionStoreContract {
  readonly states = new Map<string, ActiveLessonState>();
  readonly transcripts = new Map<string, Array<{ turnId: string; role: "learner" | "assistant"; text: string; finalized: boolean; recordedAt: string }>>();
  readonly claimed = new Set<string>();
  readonly events = new Map<string, SessionEvent[]>();
  readonly committed = new Map<string, unknown>();
  readonly completedEffects = new Set<string>();
  readonly streamLeases = new Map<string, string>();
  readonly mutationKeys = new Map<string, Set<string>>();
  readonly createResponses = new Map<string, unknown>();
  readonly createMutationSessions = new Map<string, string>();
  readonly completedMutations = new Map<string, unknown>();
  readonly completedMutationSessions = new Map<string, string>();
  readonly attempts = new Map<string, { mutationId: string; attemptToken: string }>();
  private attemptSequence = 0;
  transcriptFailuresRemaining = 0;
  readFanoutCalls = 0;
  rateLimitCalls = 0;
  transcriptBatchCalls = 0;
  fanoutBatchCalls = 0;
  allowRequests = true;

  async setActiveState(id: string, state: ActiveLessonState) { this.states.set(id, structuredClone(state)); }
  async readCommittedMutation(scope: string, key: string) {
    return structuredClone(this.committed.get(`${scope}:${key}`) ?? null);
  }
  async createSessionIfAbsent(sessionId: string, mutationId: string, initialState: ActiveLessonState, response: unknown) {
    const completed = this.createResponses.get(mutationId);
    if (completed) return { status: "completed" as const, response: structuredClone(completed) };
    if (this.states.has(sessionId)) return { status: "conflict" as const };
    this.states.set(sessionId, structuredClone(initialState));
    this.createResponses.set(mutationId, structuredClone(response));
    this.createMutationSessions.set(mutationId, sessionId);
    return { status: "created" as const };
  }
  async reserveMutationAttempt(sessionId: string, expectedRevision: number, mutationId: string) {
    const completed = this.completedMutations.get(mutationId);
    if (completed) return { status: "completed" as const, response: structuredClone(completed) };
    const state = this.states.get(sessionId);
    if (state?.status === "ended") return { status: "terminal" as const };
    if (!state || state.revision !== expectedRevision) return { status: "stale" as const, currentRevision: state?.revision ?? 0 };
    const existing = this.attempts.get(sessionId);
    if (existing) {
      return existing.mutationId === mutationId
        ? { status: "in_progress" as const, retryAfterSeconds: 1 }
        : { status: "stale" as const, currentRevision: state.revision };
    }
    const attemptToken = `00000000-0000-4000-8001-${String(++this.attemptSequence).padStart(12, "0")}`;
    this.attempts.set(sessionId, { mutationId, attemptToken });
    return { status: "acquired" as const, attemptToken };
  }
  async releaseMutationAttempt(sessionId: string, mutationId: string, attemptToken: string) {
    const attempt = this.attempts.get(sessionId);
    if (!attempt || attempt.mutationId !== mutationId || attempt.attemptToken !== attemptToken) return false;
    this.attempts.delete(sessionId);
    return true;
  }
  async commitMutation(input: {
    scope: string;
    idempotencyKey: string;
    sessionId: string;
    expectedRevision: number | null;
    state: ActiveLessonState;
    response: unknown;
    attemptToken?: string;
  }) {
    const responseKey = `${input.scope}:${input.idempotencyKey}`;
    if (this.committed.has(responseKey)) return false;
    const current = this.states.get(input.sessionId);
    if (input.expectedRevision === null ? current !== undefined : current?.revision !== input.expectedRevision) return false;
    if (input.attemptToken) {
      const attempt = this.attempts.get(input.sessionId);
      if (!attempt || attempt.mutationId !== input.idempotencyKey || attempt.attemptToken !== input.attemptToken) return false;
    }
    this.states.set(input.sessionId, structuredClone(input.state));
    this.committed.set(responseKey, structuredClone(input.response));
    const sessionKeys = this.mutationKeys.get(input.sessionId) ?? new Set<string>();
    sessionKeys.add(responseKey);
    this.mutationKeys.set(input.sessionId, sessionKeys);
    if (input.attemptToken) {
      this.attempts.delete(input.sessionId);
      this.completedMutations.set(input.idempotencyKey, structuredClone(input.response));
      this.completedMutationSessions.set(input.idempotencyKey, input.sessionId);
    }
    return true;
  }
  async commitTerminalMutation(input: {
    scope: string;
    idempotencyKey: string;
    sessionId: string;
    expectedRevision: number;
    state: ActiveLessonState;
    response: unknown;
  }) {
    const current = this.states.get(input.sessionId);
    if (current?.revision !== input.expectedRevision) return false;
    for (const [mutationId, mutationSessionId] of this.createMutationSessions) {
      if (mutationSessionId !== input.sessionId) continue;
      this.createMutationSessions.delete(mutationId);
      this.createResponses.delete(mutationId);
    }
    for (const [mutationId, mutationSessionId] of this.completedMutationSessions) {
      if (mutationSessionId !== input.sessionId) continue;
      this.completedMutationSessions.delete(mutationId);
      this.completedMutations.delete(mutationId);
    }
    for (const key of this.mutationKeys.get(input.sessionId) ?? []) this.committed.delete(key);
    this.mutationKeys.delete(input.sessionId);
    this.completedEffects.clear();
    this.transcripts.delete(input.sessionId);
    this.events.delete(input.sessionId);
    this.streamLeases.delete(input.sessionId);
    return this.commitMutation(input);
  }
  async isMutationEffectComplete(scope: string, key: string, effectId: string) {
    return this.completedEffects.has(`${scope}:${key}:${effectId}`);
  }
  async markMutationEffectComplete(scope: string, key: string, effectId: string) {
    this.completedEffects.add(`${scope}:${key}:${effectId}`);
  }
  async getActiveState(id: string) { return structuredClone(this.states.get(id) ?? null); }
  async getSessionRevision(id: string) {
    return this.states.get(id)?.revision ?? null;
  }
  async appendTranscript(id: string, entry: { turnId: string; role: "learner" | "assistant"; text: string; finalized: boolean; recordedAt: string }) {
    if (this.transcriptFailuresRemaining > 0) {
      this.transcriptFailuresRemaining -= 1;
      throw new Error("transcript unavailable");
    }
    this.transcripts.set(id, [...(this.transcripts.get(id) ?? []), entry]);
  }
  async appendTranscriptOnce(id: string, _operationId: string, entry: { turnId: string; role: "learner" | "assistant"; text: string; finalized: boolean; recordedAt: string }) {
    await this.appendTranscript(id, entry);
  }
  async appendTranscriptsOnce(id: string, entries: readonly { operationId: string; entry: { turnId: string; role: "learner" | "assistant"; text: string; finalized: boolean; recordedAt: string } }[]) {
    this.transcriptBatchCalls += 1;
    for (const { entry } of entries) await this.appendTranscript(id, entry);
  }
  async readTranscript(id: string) { return structuredClone(this.transcripts.get(id) ?? []); }
  async deleteTranscript(id: string) { this.transcripts.delete(id); }
  async deleteActiveState(id: string) { this.states.delete(id); }
  async claimIdempotencyKey(scope: string, key: string) {
    const composite = `${scope}:${key}`;
    if (this.claimed.has(composite)) return false;
    this.claimed.add(composite);
    return true;
  }
  async consumeRateLimit() {
    this.rateLimitCalls += 1;
    return { allowed: this.allowRequests, remaining: this.allowRequests ? 9 : 0, resetAfterSeconds: 30 };
  }
  async publish(id: string, event: SessionEvent) { this.events.set(id, [...(this.events.get(id) ?? []), event]); }
  async publishOnce(id: string, _operationId: string, event: SessionEvent) { await this.publish(id, event); }
  async publishManyOnce(id: string, entries: readonly { operationId: string; event: SessionEvent }[]) {
    this.fanoutBatchCalls += 1;
    for (const { event } of entries) await this.publish(id, event);
  }
  async readFanout(id: string, cursor = 0, limit = 100) {
    this.readFanoutCalls += 1;
    const events = (this.events.get(id) ?? []).slice(cursor, cursor + limit);
    return { events, cursor: cursor + events.length };
  }
  async acquireEventStreamLease(sessionId: string, leaseId: string) {
    const current = this.streamLeases.get(sessionId);
    if (current && current !== leaseId) return false;
    this.streamLeases.set(sessionId, leaseId);
    return true;
  }
  async releaseEventStreamLease(sessionId: string, leaseId: string) {
    if (this.streamLeases.get(sessionId) !== leaseId) return false;
    this.streamLeases.delete(sessionId);
    return true;
  }
  async releaseRealtimeSession() { return true; }
}

const learner = { learnerId: "learner-1", ageBand: "13-15" as const };
let sessions: FakeSessionStore;
let recordedEvidence: unknown[];
let evidenceFailuresRemaining: number;
let cardInteractions: unknown[];
let mastery: Array<{ concept: string; confidence: number; evidenceCount: number }>;
let service: SessionService;
let dependencies: SessionServiceDependencies;

function tutorDraft(question: string) {
  const lower = question.toLocaleLowerCase();
  const concept = lower.includes("photo")
    ? "photosynthesis"
    : lower.includes("earthquake")
      ? "plate tectonics"
      : "orbital motion";
  const reply = concept === "photosynthesis"
    ? "Photosynthesis stores light energy in sugars."
    : concept === "plate tectonics"
      ? "Plate tectonics builds stress that is released in earthquakes."
      : "An orbit is continuous falling around a curved path.";
  const cards = {
    purpose: "branch",
    prompt: `How should we explore ${concept}?`,
    cards: [{
      title: `Model ${concept}`,
      description: `Explore a model of ${concept}.`,
      spokenAliases: ["model"],
      order: 0,
    }],
  };
  return {
    discipline: concept === "photosynthesis" ? "biology" : concept === "plate tectonics" ? "earth-science" : "physics",
    reply,
    toolCalls: [
      ...(lower.includes("stop")
        ? [{ name: "stop_visual", arguments: { reason: "topic_changed" } }]
        : lower.includes("show") || lower.includes("animate")
          ? [{
              name: "show_visual",
              arguments: {
                concept,
                teachingIntent: `Clarify ${concept}.`,
                visualDescription: `A changing model of ${concept}.`,
                durationSeconds: 5,
                continuityKey: concept.replace(/\s+/g, "-"),
              },
            }]
          : []),
      { name: "present_cards", arguments: cards },
      {
        name: "record_learning_evidence",
        arguments: {
          concept,
          evidence: `Learner reasoned about ${concept}.`,
          confidenceDelta: 0.05,
          misconception: null,
          preferenceSignals: {},
        },
      },
    ],
  };
}

beforeEach(() => {
  sessions = new FakeSessionStore();
  recordedEvidence = [];
  evidenceFailuresRemaining = 0;
  mastery = [];
  cardInteractions = [];
  dependencies = {
    sessions,
    companionProvider: {
      async generate(request) {
        return tutorDraft(request.question);
      },
    },
    memory: {
      async loadLearnerProfile(learnerId) {
        return {
          learnerId,
          mastery: structuredClone(mastery),
          misconceptions: [],
          preferences: { interests: [] },
          recentSummaries: [],
        };
      },
      async recordEvidence(learnerId, evidence) {
        if (evidenceFailuresRemaining > 0) {
          evidenceFailuresRemaining -= 1;
          throw new Error("evidence unavailable");
        }
        recordedEvidence.push({ learnerId, evidence });
        const prior = mastery.find((item) => item.concept === evidence.concept);
        if (prior) {
          prior.confidence = Math.min(1, Math.max(0, prior.confidence + evidence.confidenceDelta));
          prior.evidenceCount += 1;
        } else {
          mastery.push({
            concept: evidence.concept,
            confidence: Math.min(1, Math.max(0, 0.5 + evidence.confidenceDelta)),
            evidenceCount: 1,
          });
        }
      },
      async recordCardInteraction(interaction) { cardInteractions.push(interaction); },
    },
    closure: {
      async close(input) {
        await sessions.deleteTranscript(input.sessionId);
        await sessions.deleteActiveState(input.sessionId);
      },
    },
    now: () => new Date("2026-08-30T12:00:00.000Z"),
    randomId: (() => {
      let id = 0;
      return () => `00000000-0000-4000-8000-${String(++id).padStart(12, "0")}`;
    })(),
  };
  service = new SessionService(dependencies);
});

describe("SessionService", () => {
  it("creates a text-only session and persists temporary transcript plus compact evidence", async () => {
    const created = await service.create(learner, { question: "Show me why planets orbit?", idempotencyKey: "create-key-1" });

    expect(created.state).toBe("text_only");
    expect(created.initialTurn?.reply).toMatch(/continuous falling/i);
    expect(sessions.transcripts.get(created.sessionId)).toHaveLength(2);
    expect(recordedEvidence).toHaveLength(1);
    expect(sessions.transcriptBatchCalls).toBe(1);
    expect(sessions.fanoutBatchCalls).toBe(2);
    expect(created.initialTurn?.toolCalls).toContainEqual(expect.objectContaining({ name: "show_visual" }));
  });

  it("converts a typed show request into a revisioned visual event", async () => {
    const created = await service.create(learner, { idempotencyKey: "create-visual-key" });
    const result = await service.turn(learner, created.sessionId, {
      protocolVersion: 1,
      commandId: "10000000-0000-4000-8000-000000000010",
      revision: 1,
      text: "Show and animate why planets orbit.",
    });

    const visual = result.events.find((event) => event.type === "visual.start");
    expect(visual).toEqual(expect.objectContaining({
      protocolVersion: 1,
      type: "visual.start",
      revision: 1,
      visualOperationId: expect.any(String),
      spec: expect.objectContaining({ concept: "orbital motion", durationSeconds: 5 }),
    }));
    expect(sessions.events.get(created.sessionId)).toContainEqual(visual);
    expect(sessions.states.get(created.sessionId)?.visual?.visualOperationId).toBe(
      visual?.type === "visual.start" ? visual.visualOperationId : undefined,
    );
  });

  it("redirects an existing typed visual on a subsequent visual turn", async () => {
    const created = await service.create(learner, {
      question: "Show me how planets orbit.",
      idempotencyKey: "create-redirect-key",
    });
    const result = await service.turn(learner, created.sessionId, {
      protocolVersion: 1,
      commandId: "10000000-0000-4000-8000-000000000011",

      revision: 2,
      text: "Now animate how gravity changes motion.",
    });

    expect(result.events).toContainEqual(expect.objectContaining({
      protocolVersion: 1,
      type: "visual.redirect",
      revision: 2,
    }));
  });
  it("persists and emits a validated visual stop", async () => {
    const created = await service.create(learner, {
      question: "Show me how planets orbit.",
      idempotencyKey: "create-stop-visual-key",
    });

    const result = await service.turn(learner, created.sessionId, {
      protocolVersion: 1,
      commandId: "10000000-0000-4000-8000-000000000093",
      revision: 2,
      text: "Stop the visual and change topics.",
    });

    expect(result.events).toContainEqual({
      protocolVersion: 1,
      type: "visual.stop",
      revision: 2,
      reason: "topic_changed",
    });
    expect(sessions.states.get(created.sessionId)?.visual).toBeNull();
  });
  it("authorizes against the durable revision without reading fanout", async () => {
    const created = await service.create(learner, { idempotencyKey: "create-lightweight-auth-key" });
    sessions.readFanoutCalls = 0;

    await expect(service.authorizeActiveSession(learner, created.sessionId)).resolves.toEqual({ revision: 0 });
    expect(sessions.readFanoutCalls).toBe(0);
  });

  it("reads one bounded backfill page without consuming the recovery rate limit", async () => {
    const created = await service.create(learner, { idempotencyKey: "create-backfill-page-key" });
    sessions.rateLimitCalls = 0;
    sessions.readFanoutCalls = 0;

    await expect(service.readEventPage(learner, created.sessionId, 0)).resolves.toMatchObject({
      nextCursor: 1,
      events: [expect.objectContaining({ type: "session.status" })],
    });
    expect(sessions.rateLimitCalls).toBe(0);
    expect(sessions.readFanoutCalls).toBe(1);
  });

  it("quarantines an unknown effect version before draining later valid effects", async () => {
    const input = { idempotencyKey: "create-unknown-effect-key" };
    const created = await service.create(learner, input);
    const committedEntry = [...sessions.createResponses.entries()][0];
    if (!committedEntry) throw new Error("Expected committed create mutation");
    const [key, rawRecord] = committedEntry;
    const record = structuredClone(rawRecord) as { version: number; response: unknown; effects: unknown[] };
    record.effects = [
      { version: 99, id: "future:unknown", type: "future_effect", payload: "opaque" },
      {
        version: 1,
        id: "fanout:after-unknown",
        type: "fanout",
        sessionId: created.sessionId,
        event: { protocolVersion: 1, type: "session.status", state: "thinking" },
      },
      ...record.effects,
    ];
    sessions.createResponses.set(key, record);
    const eventCount = sessions.events.get(created.sessionId)?.length ?? 0;

    await expect(service.create(learner, input)).rejects.toThrow("Invalid committed mutation record");
    expect(sessions.events.get(created.sessionId)).toHaveLength(eventCount);
    expect([...sessions.completedEffects].some((effect) => effect.endsWith("fanout:after-unknown"))).toBe(false);
  });

  it("does not produce another turn for a retried mutation", async () => {
    const created = await service.create(learner, { idempotencyKey: "create-key-2" });
    const input = {
      protocolVersion: 1 as const,
      commandId: "10000000-0000-4000-8000-000000000001",
      revision: 1,
      text: "Explain photosynthesis",
    };
    const first = await service.turn(learner, created.sessionId, input);

    await expect(service.turn(learner, created.sessionId, input)).resolves.toEqual(first);
    expect(sessions.transcripts.get(created.sessionId)).toHaveLength(2);
  });

  it("returns the committed response when a command is retried", async () => {
    const created = await service.create(learner, { idempotencyKey: "create-retry-key" });
    const input = {
      protocolVersion: 1 as const,
      commandId: "10000000-0000-4000-8000-000000000012",
      revision: 1,
      text: "Explain photosynthesis",
    };
    const first = await service.turn(learner, created.sessionId, input);
    const retried = await service.turn(learner, created.sessionId, input);

    expect(retried).toEqual(first);
    expect(sessions.transcripts.get(created.sessionId)).toHaveLength(2);
  });

  it("retries pending post-CAS effects before replaying the stored result", async () => {
    const created = await service.create(learner, { idempotencyKey: "create-effects-retry-key" });

    const input = {
      protocolVersion: 1 as const,
      commandId: "10000000-0000-4000-8000-000000000099",
      revision: 1,
      text: "Explain photosynthesis",
    };
    sessions.transcriptFailuresRemaining = 1;

    await expect(service.turn(learner, created.sessionId, input)).rejects.toThrow("transcript unavailable");
    const replayed = await service.turn(learner, created.sessionId, input);

    expect(replayed.reply).toMatch(/photosynthesis/i);
    expect(sessions.transcripts.get(created.sessionId)).toHaveLength(2);
    expect(recordedEvidence).toHaveLength(1);
  });
  it("recovers durable cards, visuals, exploration, and cumulative mastery", async () => {
    const created = await service.create(learner, {
      question: "Show me why planets orbit.",
      idempotencyKey: "create-durable-state-key",
    });
    await service.turn(learner, created.sessionId, {
      protocolVersion: 1,
      commandId: "10000000-0000-4000-8000-000000000094",
      revision: 2,
      text: "Now compare this with photosynthesis.",
    });

    const recovered = await service.recover(learner, created.sessionId, 0);
    expect(recovered.state.cards?.revision).toBe(2);
    expect(recovered.state.visual).toMatchObject({
      visualOperationId: expect.any(String),
      spec: { concept: "orbital motion" },
    });
    expect(recovered.state.explorationEdges).toContainEqual({
      from: "orbital motion",
      to: "photosynthesis",
    });
    expect(recovered.state.mastery).toEqual(expect.arrayContaining([
      expect.objectContaining({ concept: "orbital motion", evidenceCount: 1 }),
      expect.objectContaining({ concept: "photosynthesis", evidenceCount: 1 }),
    ]));
  });

  it("returns stored create and close results for duplicate keys", async () => {
    const createInput = { idempotencyKey: "create-result-replay-key" };
    const firstCreate = await service.create(learner, createInput);
    await expect(service.create(learner, createInput)).resolves.toEqual(firstCreate);
    const closeInput = {
      protocolVersion: 1 as const,
      commandId: "10000000-0000-4000-8000-000000000098",
      revision: 1,
      reason: "complete" as const,
    };
    const firstClose = await service.close(learner, firstCreate.sessionId, closeInput);
    await expect(service.close(learner, firstCreate.sessionId, closeInput)).resolves.toEqual(firstClose);
  });

  it("keeps a closed session terminal while replaying the compact close result", async () => {
    const created = await service.create(learner, {
      question: "A raw learner question that must be purged",
      idempotencyKey: "create-terminal-key",
    });
    const closeInput = {
      protocolVersion: 1 as const,
      commandId: "10000000-0000-4000-8000-000000000096",
      revision: 2,
      reason: "complete" as const,
    };
    const closed = await service.close(learner, created.sessionId, closeInput);
    expect(JSON.stringify([
      ...sessions.committed.values(),
      ...sessions.createResponses.values(),
      ...sessions.completedMutations.values(),
    ])).not.toContain("raw learner question");
    expect(sessions.committed.size).toBe(1);

    await expect(service.turn(learner, created.sessionId, {
      protocolVersion: 1,
      commandId: "10000000-0000-4000-8000-000000000095",
      revision: 2,
      text: "Continue the closed lesson",
    })).rejects.toMatchObject({ status: 404, code: "session_not_found" });
    await expect(service.close(learner, created.sessionId, closeInput)).resolves.toEqual(closed);
    expect(sessions.states.has(created.sessionId)).toBe(false);
  });

  it("allows only one bounded event stream lease per session", async () => {
    const created = await service.create(learner, { idempotencyKey: "create-stream-lease-key" });
    const first = await service.openEventStream(learner, created.sessionId, 0, 55_000);

    await expect(service.openEventStream(learner, created.sessionId, 0, 55_000))
      .rejects.toMatchObject({ status: 409, code: "event_stream_active" });
    await first.release();
    const replacement = await service.openEventStream(learner, created.sessionId, first.initial.cursor, 55_000);
    await expect(replacement.read(first.initial.cursor)).resolves.toMatchObject({
      events: [],
      cursor: first.initial.cursor,
    });
    await replacement.release();
  });


  it("retries missing evidence without duplicating already completed transcript effects", async () => {
    const created = await service.create(learner, { idempotencyKey: "create-evidence-retry-key" });
    const input = {
      protocolVersion: 1 as const,
      commandId: "10000000-0000-4000-8000-000000000097",
      revision: 1,
      text: "Explain photosynthesis",
    };
    evidenceFailuresRemaining = 1;

    await expect(service.turn(learner, created.sessionId, input)).rejects.toThrow("evidence unavailable");
    await expect(service.turn(learner, created.sessionId, input)).resolves.toMatchObject({
      sessionId: created.sessionId,
    });

    expect(sessions.transcripts.get(created.sessionId)).toHaveLength(2);
    expect(recordedEvidence).toHaveLength(1);
  });
  it("does not consume a command id when its revision precondition fails", async () => {
    const created = await service.create(learner, { idempotencyKey: "create-precondition-key" });
    const commandId = "10000000-0000-4000-8000-000000000013";
    await expect(service.turn(learner, created.sessionId, {
      protocolVersion: 1,
      commandId,
      revision: 2,
      text: "Explain gravity",
    })).rejects.toMatchObject({ status: 409, code: "stale_revision" });

    await expect(service.turn(learner, created.sessionId, {
      protocolVersion: 1,
      commandId,
      revision: 1,
      text: "Explain gravity",
    })).resolves.toMatchObject({ sessionId: created.sessionId });
  });

  it("serializes concurrent turns so only one can commit a revision", async () => {
    const created = await service.create(learner, { idempotencyKey: "create-race-key" });
    const turns = await Promise.allSettled([
      service.turn(learner, created.sessionId, {
        protocolVersion: 1,
        commandId: "10000000-0000-4000-8000-000000000014",
        revision: 1,
        text: "Explain gravity",
      }),
      service.turn(learner, created.sessionId, {
        protocolVersion: 1,
        commandId: "10000000-0000-4000-8000-000000000015",
        revision: 1,
        text: "Explain orbital speed",
      }),
    ]);

    expect(turns.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(sessions.states.get(created.sessionId)?.revision).toBe(1);
    expect(sessions.transcripts.get(created.sessionId)).toHaveLength(2);
  });

  it("fences paid tutor work across service instances before provider spend", async () => {
    const created = await service.create(learner, { idempotencyKey: "create-cross-instance-race-key" });
    const providerStarted = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    let providerCalls = 0;
    dependencies.companionProvider = {
      async generate(request) {
        providerCalls += 1;
        providerStarted.resolve();
        await gate.promise;
        return tutorDraft(request.question);
      },
    };
    const firstService = new SessionService(dependencies);
    const secondService = new SessionService(dependencies);
    const first = firstService.turn(learner, created.sessionId, {
      protocolVersion: 1,
      commandId: "10000000-0000-4000-8000-000000000091",
      revision: 1,
      text: "Explain gravity",
    });
    await providerStarted.promise;

    await expect(secondService.turn(learner, created.sessionId, {
      protocolVersion: 1,
      commandId: "10000000-0000-4000-8000-000000000092",
      revision: 1,
      text: "Explain orbital speed",
    })).rejects.toMatchObject({ status: 409, code: "stale_revision" });
    expect(providerCalls).toBe(1);

    gate.resolve();
    await expect(first).resolves.toMatchObject({ sessionId: created.sessionId });
  });

  it("rejects stale or unknown cards and records a valid selection", async () => {
    const created = await service.create(learner, { question: "Explain gravity", idempotencyKey: "create-key-3" });
    const card = created.initialTurn!.cards.cards[0]!;

    await expect(service.selectCard(learner, created.sessionId, {
      protocolVersion: 1,
      commandId: "10000000-0000-4000-8000-000000000002",
      cardId: card.id,
      revision: 0,
    }))
      .rejects.toMatchObject({ status: 409, code: "stale_revision" });

    const result = await service.selectCard(learner, created.sessionId, {
      protocolVersion: 1,
      commandId: "10000000-0000-4000-8000-000000000003",
      cardId: card.id,
      revision: created.initialTurn!.cards.revision,
    });
    expect(result.reply).toBeTruthy();
    expect(cardInteractions).toHaveLength(1);
  });

  it("does not consume a close command id when its revision is stale", async () => {
    const created = await service.create(learner, { idempotencyKey: "create-close-precondition-key" });
    const commandId = "10000000-0000-4000-8000-000000000016";
    await expect(service.close(learner, created.sessionId, {
      protocolVersion: 1,
      commandId,
      revision: 2,
      reason: "complete",
    })).rejects.toMatchObject({ status: 409, code: "stale_revision" });

    await expect(service.close(learner, created.sessionId, {
      protocolVersion: 1,
      commandId,
      revision: 1,
      reason: "complete",
    })).resolves.toMatchObject({ deleted: true });
  });

  it("does not reveal a session belonging to another learner", async () => {
    const created = await service.create(learner, { idempotencyKey: "create-key-4" });

    await expect(service.recover({ learnerId: "learner-2", ageBand: "16-18" }, created.sessionId, 0))
      .rejects.toMatchObject({ status: 404, code: "session_not_found" });
  });

  it("enforces repository-backed rate limits", async () => {
    sessions.allowRequests = false;

    await expect(service.create(learner, { idempotencyKey: "create-key-5" })).rejects.toEqual(
      expect.objectContaining<Partial<SessionServiceError>>({ status: 429, code: "rate_limited", retryAfterSeconds: 30 }),
    );
  });

  it("closes into a compact summary and deletes raw transcript and active state", async () => {
    const created = await service.create(learner, { question: "How do earthquakes happen?", idempotencyKey: "create-key-6" });
    const closed = await service.close(learner, created.sessionId, {
      protocolVersion: 1,
      commandId: "10000000-0000-4000-8000-000000000004",
      revision: 2,
      reason: "complete",
    });

    expect(closed.deleted).toBe(true);
    expect(closed.summary).toMatch(/plate tectonics/i);
    expect(sessions.transcripts.has(created.sessionId)).toBe(false);
    expect(sessions.states.has(created.sessionId)).toBe(false);
  });
});
