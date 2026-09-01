import { createHash, randomUUID } from "node:crypto";
import type { LearnerProfile, LearningEvidence } from "@axiom/domain";
import {
  cardPurposeSchema,
  recordLearningEvidenceArgumentsSchema,
  sessionEventSchema,
  type CardPurpose,
  type SessionEvent,
} from "@axiom/protocol";
import {
  CompanionProviderUnavailableError,
  createCompanionTurn,
  type CompanionTutorProvider,
} from "./companion";
import {
  activeLessonStateSchema,
  closeSessionResponseSchema,
  createSessionResponseSchema,
  sessionTurnResponseSchema,
  type ActiveLessonState,
  type CardInput,
  type CloseInput,
  type CloseSessionResponse,
  type CreateSessionInput,
  type CreateSessionResponse,
  type SessionTurnResponse,
  type TurnInput,
} from "./schemas";
import { z } from "zod";

export interface LessonLearner {
  learnerId: string;
  ageBand: "13-15" | "16-18";
}

const transcriptEntrySchema = z.strictObject({
  turnId: z.string().min(1).max(200),
  role: z.enum(["learner", "assistant"]),
  text: z.string().max(10_000),
  finalized: z.boolean(),
  interrupted: z.boolean().optional(),
  recordedAt: z.string().datetime(),
});
type TranscriptEntry = z.infer<typeof transcriptEntrySchema>;

const mutationEffectSchema = z.discriminatedUnion("type", [
  z.strictObject({
    version: z.literal(1),
    id: z.string().min(1).max(100),
    type: z.literal("transcript"),
    sessionId: z.string().min(1).max(200),
    entry: transcriptEntrySchema,
  }),
  z.strictObject({
    version: z.literal(1),
    id: z.string().min(1).max(100),
    type: z.literal("evidence"),
    learnerId: z.string().min(1).max(200),
    evidence: recordLearningEvidenceArgumentsSchema,
  }),
  z.strictObject({
    version: z.literal(1),
    id: z.string().min(1).max(100),
    type: z.literal("fanout"),
    sessionId: z.string().min(1).max(200),
    event: sessionEventSchema,
  }),
  z.strictObject({
    version: z.literal(1),
    id: z.string().min(1).max(100),
    type: z.literal("card"),
    interaction: z.strictObject({
      sessionId: z.string().min(1).max(200),
      learnerId: z.string().min(1).max(200),
      cardId: z.string().min(1).max(80),
      purpose: cardPurposeSchema,
      action: z.literal("selected"),
      concept: z.string().min(1).max(160).optional(),
      occurredAt: z.string().datetime(),
    }),
  }),
  z.strictObject({
    version: z.literal(1),
    id: z.string().min(1).max(100),
    type: z.literal("closure"),
    input: z.strictObject({
      sessionId: z.string().min(1).max(200),
      userId: z.string().min(1).max(200),
      summary: z.string().min(1).max(2_000),
      concepts: z.array(z.string().min(1).max(160)).max(40),
      explorationEdges: z.array(z.strictObject({
        from: z.string().min(1).max(160),
        to: z.string().min(1).max(160),
        relation: z.string().min(1).max(160).optional(),
      })).max(24),
      startedAt: z.string().datetime(),
      endedAt: z.string().datetime(),
    }),
  }),
]);
type SessionMutationEffect = z.infer<typeof mutationEffectSchema>;

const sessionMutationRecordSchema = z.strictObject({
  version: z.literal(1),
  response: z.unknown(),
  effects: z.array(mutationEffectSchema).max(32),
});
export type SessionMutationRecord = z.infer<typeof sessionMutationRecordSchema>;

export interface ActiveSessionAuthorization {
  revision: number;
}
interface PreparedSessionMutation<T> {
  state: ActiveLessonState;
  response: T;
  effects: SessionMutationEffect[];
}


export interface SessionEventPage {
  events: SessionEvent[];
  cursor: number;
}
export interface SessionEventBackfillPage {
  events: SessionEvent[];
  nextCursor: number;
}


export interface SessionEventStreamLease {
  initial: {
    sessionId: string;
    state: ActiveLessonState;
    events: SessionEvent[];
    cursor: number;
  };
  read(cursor: number): Promise<SessionEventPage>;
  release(): Promise<void>;
}
export type SessionCreateResult =
  | { status: "created" }
  | { status: "completed"; response: unknown }
  | { status: "conflict" };

export type MutationAttemptReservation =
  | { status: "acquired"; attemptToken: string }
  | { status: "in_progress"; retryAfterSeconds: number }
  | { status: "completed"; response: unknown }
  | { status: "stale"; currentRevision: number }
  | { status: "terminal" };


export interface SessionServiceDependencies {
  sessions: {
    setActiveState(sessionId: string, state: ActiveLessonState): Promise<void>;
    getActiveState(sessionId: string): Promise<ActiveLessonState | null>;
    readCommittedMutation(scope: string, idempotencyKey: string): Promise<unknown | null>;
    getSessionRevision(sessionId: string): Promise<number | null>;
    createSessionIfAbsent(sessionId: string, mutationId: string, initialState: ActiveLessonState, response: unknown): Promise<SessionCreateResult>;
    reserveMutationAttempt(sessionId: string, expectedRevision: number, mutationId: string): Promise<MutationAttemptReservation>;
    releaseMutationAttempt(sessionId: string, mutationId: string, attemptToken: string): Promise<boolean>;
    isMutationEffectComplete(scope: string, idempotencyKey: string, effectId: string): Promise<boolean>;
    markMutationEffectComplete(scope: string, idempotencyKey: string, effectId: string): Promise<void>;
    deleteActiveState(sessionId: string): Promise<void>;
    commitMutation(input: { scope: string; idempotencyKey: string; sessionId: string; expectedRevision: number; state: ActiveLessonState; response: unknown; attemptToken: string }): Promise<boolean>;
    commitTerminalMutation(input: { scope: string; idempotencyKey: string; sessionId: string; expectedRevision: number; state: ActiveLessonState; response: unknown }): Promise<boolean>;
    appendTranscriptOnce(sessionId: string, operationId: string, entry: TranscriptEntry): Promise<void>;
    readTranscript(sessionId: string): Promise<TranscriptEntry[]>;
    deleteTranscript(sessionId: string): Promise<void>;
    appendTranscriptsOnce(sessionId: string, entries: readonly { operationId: string; entry: TranscriptEntry }[]): Promise<void>;
    publishManyOnce(sessionId: string, entries: readonly { operationId: string; event: SessionEvent }[]): Promise<void>;
    claimIdempotencyKey(scope: string, idempotencyKey: string): Promise<boolean>;
    consumeRateLimit(subject: string, policy: { limit: number; windowSeconds: number }): Promise<{ allowed: boolean; remaining: number; resetAfterSeconds: number }>;
    publishOnce(sessionId: string, operationId: string, event: SessionEvent): Promise<void>;
    readFanout(sessionId: string, cursor?: number, limit?: number): Promise<{ events: SessionEvent[]; cursor: number }>;
    acquireEventStreamLease(sessionId: string, leaseId: string, ttlSeconds: number): Promise<boolean>;
    releaseEventStreamLease(sessionId: string, leaseId: string): Promise<boolean>;
    releaseRealtimeSession(sessionId: string): Promise<boolean>;
  };
  memory: {
    recordEvidence(learnerId: string, evidence: LearningEvidence, operationId?: string): Promise<unknown>;
    loadLearnerProfile(learnerId: string): Promise<LearnerProfile>;
    recordCardInteraction(input: { sessionId: string; learnerId: string; cardId: string; purpose: CardPurpose; action: "selected"; concept?: string; occurredAt: Date }, operationId?: string): Promise<void>;
  };
  closure: {
    close(input: { sessionId: string; userId: string; summary: string; concepts: readonly string[]; explorationEdges?: readonly { from: string; to: string; relation?: string }[]; startedAt: Date; endedAt: Date }): Promise<void>;
  };
  now?: () => Date;
  randomId?: () => string;
  companionProvider?: CompanionTutorProvider;
}

export class SessionServiceError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly retryAfterSeconds?: number) {
    super(message);
    this.name = "SessionServiceError";
  }
}

const CREATE_RATE_LIMIT = { limit: 10, windowSeconds: 60 } as const;
const MUTATION_RATE_LIMIT = { limit: 30, windowSeconds: 60 } as const;
const READ_RATE_LIMIT = { limit: 60, windowSeconds: 60 } as const;

function opaqueScope(prefix: string, value: string): string {
  return `${prefix}-${createHash("sha256").update(value).digest("base64url")}`;
}

function stableSessionId(value: string): string {
  const hex = createHash("sha256").update(value).digest("hex").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20)}`;
}

function mutationRecord(value: unknown): SessionMutationRecord {
  const parsed = sessionMutationRecordSchema.safeParse(value);
  if (!parsed.success) throw new Error("Invalid committed mutation record", { cause: parsed.error });
  return parsed.data;
}

function createMutationRecord(response: unknown, effects: readonly SessionMutationEffect[]): SessionMutationRecord {
  const detachedResponse: unknown = JSON.parse(JSON.stringify(response));
  return sessionMutationRecordSchema.parse({ version: 1, response: detachedResponse, effects });
}

export class SessionService {
  private readonly now: () => Date;
  private readonly randomId: () => string;
  private readonly mutationTails = new Map<string, Promise<void>>();
  private readonly eventStreamLeases = new Map<string, { token: string; expiresAt: number }>();

  constructor(private readonly dependencies: SessionServiceDependencies) {
    this.now = dependencies.now ?? (() => new Date());
    this.randomId = dependencies.randomId ?? randomUUID;
  }
  async create(learner: LessonLearner, input: CreateSessionInput): Promise<CreateSessionResponse> {
    await this.enforceRateLimit(opaqueScope("learner", learner.learnerId), CREATE_RATE_LIMIT);
    const scope = opaqueScope("create", learner.learnerId);
    const createMutationId = opaqueScope("create-mutation", `${learner.learnerId}:${input.idempotencyKey}`);
    const proposedSessionId = stableSessionId(`${learner.learnerId}:${input.idempotencyKey}`);
    const now = this.now().toISOString();
    const initialEvent: SessionEvent = { protocolVersion: 1, type: "session.status", state: "text_only", detail: "Voice is optional; type any science question to begin." };
    const learnerProfile = await this.dependencies.memory.loadLearnerProfile(learner.learnerId);
    const proposedState: ActiveLessonState = {
      revision: 0,
      status: "text_only",
      learnerId: learner.learnerId,
      startedAt: now,
      updatedAt: now,
      turnCount: 0,
      concepts: [],
      explorationEdges: [],
      mastery: learnerProfile.mastery.slice(-50),
      cards: null,
      visual: null,
      lastEvents: [initialEvent],
    };
    const initialEffect: SessionMutationEffect = { version: 1, id: "fanout:initial", type: "fanout", sessionId: proposedSessionId, event: initialEvent };
    const proposedResponse: CreateSessionResponse = { sessionId: proposedSessionId, state: "text_only", events: [initialEvent] };
    const proposedRecord = createMutationRecord(proposedResponse, [initialEffect]);
    const creation = await this.dependencies.sessions.createSessionIfAbsent(
      proposedSessionId,
      createMutationId,
      proposedState,
      proposedRecord,
    );
    if (creation.status === "conflict") {
      throw new SessionServiceError(409, "duplicate_request", "This request conflicts with an existing lesson.");
    }
    const response = creation.status === "completed"
      ? await this.replay(scope, input.idempotencyKey, creation.response, createSessionResponseSchema)
      : proposedResponse;
    if (creation.status === "created") {
      await this.drainEffects(scope, input.idempotencyKey, proposedRecord.effects);
    }
    if (!input.question) return response;

    const sessionState = creation.status === "created"
      ? proposedState
      : await this.authorizedState(learner, response.sessionId);
    const questionMutationId = opaqueScope("initial-question", `${learner.learnerId}:${input.idempotencyKey}`);
    response.initialTurn = await this.withProviderAttempt(
      response.sessionId,
      0,
      questionMutationId,
      opaqueScope("initial-turn", `${learner.learnerId}:${response.sessionId}`),
      questionMutationId,
      sessionTurnResponseSchema,
      async () => this.prepareTurn(
        learner,
        response.sessionId,
        sessionState,
        input.question!,
        learnerProfile,
        questionMutationId,
        1,
      ),
    );
    return response;
  }

  async turn(learner: LessonLearner, sessionId: string, input: TurnInput): Promise<SessionTurnResponse> {
    return this.serializeMutation(sessionId, async () => {
      const scope = opaqueScope("turn", `${learner.learnerId}:${sessionId}`);
      const state = await this.authorizedState(learner, sessionId);
      await this.enforceRateLimit(opaqueScope("turn", learner.learnerId), MUTATION_RATE_LIMIT);
      return this.withProviderAttempt(
        sessionId,
        input.revision - 1,
        input.commandId,
        scope,
        input.commandId,
        sessionTurnResponseSchema,
        async () => this.prepareTurn(
          learner,
          sessionId,
          state,
          input.text,
          await this.dependencies.memory.loadLearnerProfile(learner.learnerId),
          input.commandId,
          input.revision,
        ),
      );
    });
  }

  async selectCard(learner: LessonLearner, sessionId: string, input: CardInput): Promise<SessionTurnResponse> {
    return this.serializeMutation(sessionId, async () => {
      const scope = opaqueScope("card", `${learner.learnerId}:${sessionId}`);
      const state = await this.authorizedState(learner, sessionId);
      await this.enforceRateLimit(opaqueScope("card", learner.learnerId), MUTATION_RATE_LIMIT);
      if (!state.cards || input.revision !== state.cards.revision) throw new SessionServiceError(409, "stale_revision", "That choice belongs to an older branch. Choose from the current cards.");
      const card = state.cards.cards.find((candidate) => candidate.id === input.cardId);
      if (!card) throw new SessionServiceError(400, "unknown_card", "The selected card is not in the current branch.");
      return this.withProviderAttempt(
        sessionId,
        state.revision,
        input.commandId,
        scope,
        input.commandId,
        sessionTurnResponseSchema,
        async () => {
          const prepared = await this.prepareTurn(
            learner,
            sessionId,
            state,
            `Explore this choice: ${card.title}. ${card.description}`,
            await this.dependencies.memory.loadLearnerProfile(learner.learnerId),
            input.commandId,
          );
          const concept = state.concepts.at(-1);
          prepared.effects.push({
            version: 1,
            id: "card:selected",
            type: "card",
            interaction: { sessionId, learnerId: learner.learnerId, cardId: card.id, purpose: state.cards!.purpose, action: "selected", ...(concept ? { concept } : {}), occurredAt: this.now().toISOString() },
          });
          return prepared;
        },
      );
    });
  }

  async recover(learner: LessonLearner, sessionId: string, cursor: number) {
    const [state, learnerProfile] = await Promise.all([
      this.authorizedState(learner, sessionId),
      this.dependencies.memory.loadLearnerProfile(learner.learnerId),
    ]);
    await this.enforceRateLimit(opaqueScope("read", learner.learnerId), READ_RATE_LIMIT);
    const fanout = await this.dependencies.sessions.readFanout(sessionId, cursor, 100);
    return {
      sessionId,
      state: { ...state, mastery: learnerProfile.mastery.slice(-50) },
      events: fanout.events,
      cursor: fanout.cursor,
    };
  }
  async readEventPage(
    learner: LessonLearner,
    sessionId: string,
    cursor: number,
  ): Promise<SessionEventBackfillPage> {
    await this.authorizedState(learner, sessionId);
    const page = await this.dependencies.sessions.readFanout(sessionId, cursor, 100);
    return { events: page.events, nextCursor: page.cursor };
  }


  async authorizeActiveSession(
    learner: LessonLearner,
    sessionId: string,
  ): Promise<ActiveSessionAuthorization> {
    const state = await this.authorizedState(learner, sessionId);
    return { revision: state.revision };
  }

  async openEventStream(
    learner: LessonLearner,
    sessionId: string,
    cursor: number,
    lifetimeMs: number,
  ): Promise<SessionEventStreamLease> {
    if (!Number.isInteger(lifetimeMs) || lifetimeMs <= 0 || lifetimeMs > 60_000) {
      throw new SessionServiceError(400, "invalid_stream_lifetime", "The event stream lifetime is invalid.");
    }
    const initial = await this.recover(learner, sessionId, cursor);
    const now = Date.now();
    const current = this.eventStreamLeases.get(sessionId);
    if (current && current.expiresAt > now) {
      throw new SessionServiceError(409, "event_stream_active", "This lesson already has an active event stream. Reconnect after it closes.");
    }
    const token = this.randomId();
    const acquired = await this.dependencies.sessions.acquireEventStreamLease(
      sessionId,
      token,
      Math.ceil(lifetimeMs / 1_000),
    );
    if (!acquired) {
      throw new SessionServiceError(409, "event_stream_active", "This lesson already has an active event stream. Reconnect after it closes.");
    }
    const expiresAt = now + lifetimeMs;
    this.eventStreamLeases.set(sessionId, { token, expiresAt });
    let released = false;
    const release = async () => {
      if (released) return;
      released = true;
      if (this.eventStreamLeases.get(sessionId)?.token === token) this.eventStreamLeases.delete(sessionId);
      await this.dependencies.sessions.releaseEventStreamLease(sessionId, token);
    };
    return {
      initial,
      read: async (nextCursor) => {
        const lease = this.eventStreamLeases.get(sessionId);
        if (!lease || lease.token !== token || lease.expiresAt <= Date.now()) {
          await release();
          throw new SessionServiceError(409, "event_stream_expired", "The event stream lease expired. Reconnect to continue.");
        }
        return this.dependencies.sessions.readFanout(sessionId, nextCursor, 100);
      },
      release,
    };
  }

  async close(learner: LessonLearner, sessionId: string, input: CloseInput): Promise<CloseSessionResponse> {
    return this.serializeMutation(sessionId, async () => {
      const scope = opaqueScope("close", `${learner.learnerId}:${sessionId}`);
      const prior = await this.dependencies.sessions.readCommittedMutation(scope, input.commandId);
      if (prior) return this.replay(scope, input.commandId, prior, closeSessionResponseSchema);
      const state = await this.authorizedState(learner, sessionId);
      await this.enforceRateLimit(opaqueScope("close", learner.learnerId), MUTATION_RATE_LIMIT);
      if (input.revision !== state.revision + 1) throw new SessionServiceError(409, "stale_revision", "The lesson changed before the close command was applied.");
      const summary = state.concepts.length > 0
        ? `Explored ${state.concepts.join(", ")} across ${state.turnCount} lesson turn${state.turnCount === 1 ? "" : "s"}. The session ended as ${input.reason}; only this compact learning record is retained.`
        : `Opened a science companion session without completing a lesson turn. The session ended as ${input.reason}; no raw transcript is retained.`;
      const response: CloseSessionResponse = { sessionId, summary, deleted: true };
      const effects: SessionMutationEffect[] = [
        { version: 1, id: "closure", type: "closure", input: { sessionId, userId: learner.learnerId, summary, concepts: state.concepts, explorationEdges: state.explorationEdges, startedAt: state.startedAt, endedAt: this.now().toISOString() } },
      ];
      const record = createMutationRecord(response, effects);
      const closedState: ActiveLessonState = {
        ...state,
        revision: input.revision,
        status: "ended",
        cards: null,
        visual: null,
        updatedAt: this.now().toISOString(),
      };
      const committed = await this.dependencies.sessions.commitTerminalMutation({
        scope,
        idempotencyKey: input.commandId,
        sessionId,
        expectedRevision: state.revision,
        state: closedState,
        response: record,
      });
      if (!committed) {
        const existing = await this.dependencies.sessions.readCommittedMutation(scope, input.commandId);
        if (existing) return this.replay(scope, input.commandId, existing, closeSessionResponseSchema);
        throw new SessionServiceError(409, "stale_revision", "The lesson changed before the close command was committed.");
      }
      this.eventStreamLeases.delete(sessionId);
      await this.drainEffects(scope, input.commandId, effects);
      return response;
    });
  }


  private async prepareTurn(
    learner: LessonLearner,
    sessionId: string,
    currentState: ActiveLessonState,
    text: string,
    learnerProfile: LearnerProfile,
    idempotencyKey: string,
    targetRevision?: number,
  ) {
    const turnId = this.randomId();
    const revision = targetRevision ?? currentState.revision + 1;
    const recordedAt = this.now().toISOString();
    let companion;
    try {
      companion = await createCompanionTurn(text, {
        turnNumber: currentState.turnCount + 1,
        ageBand: learner.ageBand,
        learnerProfile,
        cardIdNamespace: `${sessionId}:${idempotencyKey}:${revision}`,
        idempotencyKey,
      }, this.dependencies.companionProvider);
    } catch (error) {
      if (error instanceof CompanionProviderUnavailableError) {
        throw new SessionServiceError(503, "provider_unavailable", error.message);
      }
      throw error;
    }
    const normalizedEvidence = companion.evidence
      ? recordLearningEvidenceArgumentsSchema.parse(companion.evidence)
      : null;
    const cards = { ...companion.cards, revision };
    const visualCall = companion.toolCalls.find((call) => call.name === "show_visual");
    const stopVisualCall = companion.toolCalls.find((call) => call.name === "stop_visual");
    const visualOperationId = visualCall?.name === "show_visual"
      ? opaqueScope("visual", `${sessionId}:${idempotencyKey}`)
      : null;
    const visualEvent: SessionEvent | null = visualCall?.name === "show_visual" && visualOperationId
      ? { protocolVersion: 1, type: currentState.visual ? "visual.redirect" : "visual.start", revision, visualOperationId, spec: visualCall.arguments }
      : stopVisualCall?.name === "stop_visual"
        ? { protocolVersion: 1, type: "visual.stop", revision, reason: stopVisualCall.arguments.reason }
        : null;
    const events: SessionEvent[] = [
      { protocolVersion: 1, type: "session.status", state: "thinking" },
      { protocolVersion: 1, type: "transcript.final", turnId, text: companion.reply, interrupted: false },
      ...(visualEvent ? [visualEvent] : []),
      { protocolVersion: 1, type: "canvas.cards.replace", revision, ...companion.cards },
      { protocolVersion: 1, type: "session.status", state: "text_only", detail: "Continue by typing or selecting a card." },
    ];
    const evidenceConcept = normalizedEvidence?.concept;
    const priorConcept = currentState.concepts.at(-1);
    const concepts = evidenceConcept && !currentState.concepts.includes(evidenceConcept)
      ? [...currentState.concepts, evidenceConcept].slice(-40)
      : currentState.concepts;
    const explorationEdges = priorConcept && evidenceConcept && priorConcept !== evidenceConcept
      ? [...currentState.explorationEdges, { from: priorConcept, to: evidenceConcept }].slice(-24)
      : currentState.explorationEdges;
    const state: ActiveLessonState = {
      ...currentState,
      revision,
      status: "text_only",
      updatedAt: recordedAt,
      turnCount: currentState.turnCount + 1,
      concepts,
      explorationEdges,
      mastery: learnerProfile.mastery.slice(-50),
      cards,
      visual: visualCall?.name === "show_visual" && visualOperationId
        ? { visualOperationId, spec: visualCall.arguments }
        : stopVisualCall?.name === "stop_visual"
          ? null
          : currentState.visual,
      lastEvents: events,
    };
    const response: SessionTurnResponse = { sessionId, turnId, reply: companion.reply, cards, events, toolCalls: companion.toolCalls };
    const effects: SessionMutationEffect[] = [
      { version: 1, id: "transcript:learner", type: "transcript", sessionId, entry: { turnId, role: "learner", text, finalized: true, recordedAt } },
      { version: 1, id: "transcript:assistant", type: "transcript", sessionId, entry: { turnId, role: "assistant", text: companion.reply, finalized: true, recordedAt } },
      ...(normalizedEvidence ? [{
        version: 1,
        id: "evidence",
        type: "evidence",
        learnerId: learner.learnerId,
        evidence: normalizedEvidence,
      } satisfies SessionMutationEffect] : []),
      ...events.map((event, index): SessionMutationEffect => ({ version: 1, id: `fanout:${index}`, type: "fanout", sessionId, event })),
    ];
    return { state, response, effects };
  }

  private async withProviderAttempt<T>(
    sessionId: string,
    expectedRevision: number,
    mutationId: string,
    scope: string,
    idempotencyKey: string,
    schema: { parse(value: unknown): T },
    prepare: () => Promise<PreparedSessionMutation<T>>,
  ): Promise<T> {
    const reservation = await this.dependencies.sessions.reserveMutationAttempt(sessionId, expectedRevision, mutationId);
    if (reservation.status === "completed") {
      return this.replay(scope, idempotencyKey, reservation.response, schema);
    }
    if (reservation.status === "in_progress") {
      throw new SessionServiceError(409, "command_in_flight", "This command is already being prepared.", reservation.retryAfterSeconds);
    }
    if (reservation.status === "stale") {
      throw new SessionServiceError(409, "stale_revision", "The lesson changed before this command was prepared.");
    }
    if (reservation.status === "terminal") {
      throw new SessionServiceError(410, "session_closed", "This lesson has ended and cannot accept more commands.");
    }
    try {
      const prepared = await prepare();
      return await this.commitPrepared(scope, idempotencyKey, sessionId, expectedRevision, reservation.attemptToken, prepared, schema);
    } catch (error) {
      await this.dependencies.sessions.releaseMutationAttempt(sessionId, mutationId, reservation.attemptToken);
      throw error;
    }
  }

  private async commitPrepared<T>(
    scope: string,
    idempotencyKey: string,
    sessionId: string,
    expectedRevision: number,
    attemptToken: string,
    prepared: PreparedSessionMutation<T>,
    schema: { parse(value: unknown): T },
  ): Promise<T> {
    const record = createMutationRecord(prepared.response, prepared.effects);
    const committed = await this.dependencies.sessions.commitMutation({ scope, idempotencyKey, sessionId, expectedRevision, state: prepared.state, response: record, attemptToken });
    if (!committed) {
      const existing = await this.dependencies.sessions.readCommittedMutation(sessionId, idempotencyKey);
      if (existing) return this.replay(scope, idempotencyKey, existing, schema);
      throw new SessionServiceError(409, "stale_revision", "The lesson changed before this turn was committed.");
    }
    await this.drainEffects(scope, idempotencyKey, prepared.effects);
    return prepared.response;
  }

  private async replay<T>(scope: string, idempotencyKey: string, value: unknown, schema: { parse(value: unknown): T }): Promise<T> {
    const record = mutationRecord(value);
    await this.drainEffects(scope, idempotencyKey, record.effects);
    return schema.parse(record.response);
  }

  private async drainEffects(scope: string, idempotencyKey: string, effects: readonly SessionMutationEffect[]): Promise<void> {
    const completion = await Promise.all(effects.map((effect) =>
      this.dependencies.sessions.isMutationEffectComplete(scope, idempotencyKey, effect.id),
    ));
    const pending = effects.filter((_, index) => !completion[index]);
    const markComplete = (effect: SessionMutationEffect) =>
      this.dependencies.sessions.markMutationEffectComplete(scope, idempotencyKey, effect.id);
    const operationId = (effect: SessionMutationEffect) => `${scope}:${idempotencyKey}:${effect.id}`;
    const transcriptEffects = pending.filter((effect) => effect.type === "transcript");
    const fanoutEffects = pending.filter((effect) => effect.type === "fanout");
    const independent = pending.filter((effect) => effect.type !== "transcript" && effect.type !== "fanout");
    const applyIndependentEffect = async (effect: (typeof independent)[number]): Promise<void> => {
      if (effect.type === "evidence") await this.dependencies.memory.recordEvidence(effect.learnerId, effect.evidence, operationId(effect));
      else if (effect.type === "card") await this.dependencies.memory.recordCardInteraction({ ...effect.interaction, occurredAt: new Date(effect.interaction.occurredAt) }, operationId(effect));
      else if (effect.type === "closure") await this.dependencies.closure.close({ ...effect.input, startedAt: new Date(effect.input.startedAt), endedAt: new Date(effect.input.endedAt) });
      await markComplete(effect);
    };
    const applyTranscriptBatch = async () => {
      if (transcriptEffects.length === 0) return;
      await this.dependencies.sessions.appendTranscriptsOnce(
        transcriptEffects[0]!.sessionId,
        transcriptEffects.map((effect) => ({ operationId: operationId(effect), entry: effect.entry })),
      );
      await Promise.all(transcriptEffects.map(markComplete));
    };
    const applyFanoutBatch = async () => {
      if (fanoutEffects.length === 0) return;
      await this.dependencies.sessions.publishManyOnce(
        fanoutEffects[0]!.sessionId,
        fanoutEffects.map((effect) => ({ operationId: operationId(effect), event: effect.event })),
      );
      await Promise.all(fanoutEffects.map(markComplete));
    };
    await Promise.all([
      applyTranscriptBatch(),
      applyFanoutBatch(),
      ...independent.map(applyIndependentEffect),
    ]);
  }

  private async authorizedState(learner: LessonLearner, sessionId: string): Promise<ActiveLessonState> {
    const [storedState, durableRevision] = await Promise.all([
      this.dependencies.sessions.getActiveState(sessionId),
      this.dependencies.sessions.getSessionRevision(sessionId),
    ]);
    const parsed = activeLessonStateSchema.safeParse(storedState);
    if (!parsed.success || parsed.data.learnerId !== learner.learnerId || durableRevision === null) {
      throw new SessionServiceError(404, "session_not_found", "Session not found or expired.");
    }
    const state = durableRevision === parsed.data.revision
      ? parsed.data
      : { ...parsed.data, revision: durableRevision };
    if (state.status === "ended") throw new SessionServiceError(410, "session_closed", "This lesson has ended and cannot accept more commands.");
    return state;
  }

  private async enforceRateLimit(
    subject: string,
    policy: { limit: number; windowSeconds: number },
  ): Promise<void> {
    const result = await this.dependencies.sessions.consumeRateLimit(subject, policy);
    if (!result.allowed) {
      throw new SessionServiceError(
        429,
        "rate_limited",
        "Too many requests. Pause briefly before continuing.",
        result.resetAfterSeconds,
      );
    }
  }

  private async serializeMutation<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const preceding = this.mutationTails.get(sessionId) ?? Promise.resolve();
    let release = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const queued = preceding.then(() => gate);
    this.mutationTails.set(sessionId, queued);
    await preceding;
    try {
      return await operation();
    } finally {
      release();
      if (this.mutationTails.get(sessionId) === queued) this.mutationTails.delete(sessionId);
    }
  }
}
