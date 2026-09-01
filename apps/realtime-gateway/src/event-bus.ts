import { createHash, randomUUID } from "node:crypto";
import { isIP } from "node:net";
import type { CanvasSnapshot } from "@axiom/domain";
import { neon } from "@neondatabase/serverless";
import {
  decodeRetainedPayloadKey,
  decryptRetainedPayload,
  encryptRetainedPayload,
  type GatewayTicketClaim
} from "@axiom/persistence";
import {
  cardSchema,
  recordLearningEvidenceArgumentsSchema,
  sessionEventSchema,
  visualSpecSchema,
  type SessionEvent
} from "@axiom/protocol";
import Redis from "ioredis";
import { z } from "zod";
import type { SafeLogger } from "./logger.js";

const SESSION_STATE_TTL_SECONDS = 15 * 60;
const OWNER_LEASE_TTL_SECONDS = 30;
const SOCKET_PERMIT_TTL_SECONDS = 15 * 60;
const DEFAULT_MAX_SOCKETS_PER_SESSION = 3;
const DEFAULT_MAX_SOCKETS_PER_LEARNER = 6;
const DEFAULT_MAX_SOCKETS_PER_NETWORK = 20;


export function normalizeSocketNetworkIdentity(address: string): string {
  const withoutZone = address.split("%", 1)[0]!;
  if (isIP(withoutZone) !== 6) return withoutZone;
  const embeddedIpv4 = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(withoutZone)?.[1];
  if (embeddedIpv4 && isIP(embeddedIpv4) === 4 && withoutZone.toLowerCase() === `::ffff:${embeddedIpv4}`) {
    return embeddedIpv4;
  }
  const expandedAddress = embeddedIpv4 && isIP(embeddedIpv4) === 4
    ? withoutZone.slice(0, -embeddedIpv4.length) + embeddedIpv4
      .split(".")
      .map(Number)
      .reduce<string[]>((groups, octet, index, octets) => {
        if (index % 2 === 0) groups.push(((octet << 8) | octets[index + 1]!).toString(16));
        return groups;
      }, [])
      .join(":")
    : withoutZone;
  const [left = "", right = ""] = expandedAddress.toLowerCase().split("::", 2);
  const leftGroups = left ? left.split(":") : [];
  const rightGroups = right ? right.split(":") : [];
  const zeroCount = Math.max(0, 8 - leftGroups.length - rightGroups.length);
  const groups = [...leftGroups, ...Array<string>(zeroCount).fill("0"), ...rightGroups];
  return `${groups.slice(0, 4).map((group) => Number.parseInt(group || "0", 16).toString(16)).join(":")}::/64`;
}

type EventSubscriber = (event: SessionEvent) => void;

interface WireEvent {
  readonly origin: string;
  readonly learnerId: string;
  readonly event: SessionEvent;
}

interface OwnedSubscriber {
  readonly learnerId: string;
  readonly receive: EventSubscriber;
}

export interface SocketPermit {
  readonly id: string;
  readonly sessionId: string;
  readonly learnerId: string;
  readonly networkHash: string;
}

export interface SessionEventBusOptions {
  readonly requireRedis?: boolean;
  readonly maxActiveSessionsPerLearner?: number;
  readonly maxSocketsPerSession?: number;
  readonly maxSocketsPerLearner?: number;
  readonly maxSocketsPerNetwork?: number;
  readonly maxPaidCommandsPerLearner?: number;
  readonly transcriptEncryptionKey?: string;
  readonly activeTranscriptTtlSeconds?: number;
}
export interface GatewayVisualEntitlementInput {
  readonly learnerId: string;
  readonly sessionId: string;
  readonly durationSeconds: 5 | 10 | 15;
}

export type GatewayVisualEntitlement =
  | {
      readonly status: "authorized_pending";
      readonly reservationId: string;
      readonly remainingSeconds: number;
      readonly dailyLimitSeconds: number;
    }
  | {
      readonly status: "denied";
      readonly reason: "conflict" | "concurrency_limit" | "daily_limit" | "global_limit";
      readonly remainingSeconds: number;
      readonly dailyLimitSeconds: number;
    };


export type CommandOperationStart =
  | { readonly state: "accepted"; readonly attemptToken: string }
  | { readonly state: "pending" | "stale" }
  | { readonly state: "completed"; readonly events: readonly SessionEvent[] };

const sessionStateSchema = z.strictObject({
  eventRevision: z.number().int().nonnegative(),
  lastCommandRevision: z.number().int().nonnegative(),
  canvas: z.strictObject({
    revision: z.number().int().nonnegative(),
    cards: z.array(cardSchema),
    cardPrompt: z.string().nullable(),
    visual: z.strictObject({
      status: z.enum(["idle", "starting", "playing", "redirecting", "held"]),
      spec: visualSpecSchema.nullable(),
      visualOperationId: z.string().trim().min(1).max(200).nullable(),
      isDimmed: z.boolean(),
      lastFrameUrl: z.string().url().nullable()
    })
  })
});
const explorationEdgeSchema = z.strictObject({
  from: z.string().trim().min(1).max(160),
  to: z.string().trim().min(1).max(160),
  relation: z.string().trim().min(1).max(80).optional()
});

const durableSummarySchema = z.strictObject({
  reason: z.enum(["complete", "abandoned", "error"]),
  summary: z.string().trim().min(1).max(20_000),
  concepts: z.array(z.string().trim().min(1).max(160)).default([]),
  explorationEdges: z.array(explorationEdgeSchema).max(24).default([]),
  startedAt: z.coerce.date(),
  endedAt: z.coerce.date(),
  startedRegion: z.string().trim().min(1).max(64)
});
const durableEnvelopeSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    version: z.literal(1),
    kind: z.literal("learning_evidence"),
    eventId: z.string().min(1).max(500),
    sessionId: z.string().min(1).max(200),
    learnerId: z.string().min(1).max(200),
    payload: z.record(z.string(), z.unknown())
  }),
  z.strictObject({
    version: z.literal(1),
    kind: z.literal("session_summary"),
    eventId: z.string().min(1).max(500),
    sessionId: z.string().min(1).max(200),
    learnerId: z.string().min(1).max(200),
    payload: z.record(z.string(), z.unknown())
  })
]);

type GatewayDurableEnvelope = z.infer<typeof durableEnvelopeSchema>;

export interface GatewaySessionLease {
  readonly sessionId: string;
  readonly learnerId: string;
  readonly gatewayInstanceToken: string;
  readonly callId?: string;
}

export interface GatewayMasteryContext {
  readonly concept: string;
  readonly confidence: number;
  readonly evidenceCount: number;
}

export interface GatewayMisconceptionContext {
  readonly concept: string;
  readonly description: string;
  readonly evidenceCount: number;
}

export interface GatewayLearnerContext {
  readonly mastery: readonly GatewayMasteryContext[];
  readonly misconceptions: readonly GatewayMisconceptionContext[];
  readonly ageBand?: "13-15" | "16-18";
  readonly explanationMode?: string;
  readonly pace?: string;
  readonly challenge?: string;
  readonly interests: readonly string[];
  readonly recentSummaries: readonly string[];
  readonly instructionLines: readonly string[];
}
export interface GatewayCardInteraction {
  readonly sessionId: string;
  readonly learnerId: string;
  readonly cardId: string;
  readonly purpose: "branch" | "predict" | "compare" | "sequence" | "check";
  readonly action: "shown" | "selected" | "dismissed";
  readonly concept?: string;
  readonly occurredAt: Date;
}

export interface GatewayVisualMetadata {
  readonly sessionId: string;
  readonly learnerId?: string;
  readonly visualId: string;
  readonly concept: string;
  readonly durationSeconds: 5 | 10 | 15;
  readonly resolution: "480p" | "768p";
  readonly outcome: "completed" | "interrupted" | "rejected" | "failed";
  readonly promptVersion: number;
  readonly latencyMs?: number;
  readonly createdAt: Date;
}



export interface GatewaySessionState {
  readonly eventRevision: number;
  readonly lastCommandRevision: number;
  readonly canvas: CanvasSnapshot;
}

export interface GatewayDurableSink {
  writeLearningEvidence(eventId: string, sessionId: string, learnerId: string, payload: Readonly<Record<string, unknown>>): Promise<void>;
  writeSessionSummary(eventId: string, sessionId: string, learnerId: string, payload: Readonly<Record<string, unknown>>): Promise<void>;
  writeCardInteraction(eventId: string, input: GatewayCardInteraction): Promise<void>;
  writeVisualMetadata(eventId: string, input: GatewayVisualMetadata): Promise<void>;
  probeReadiness?(): Promise<boolean>;
  loadLearnerContext?(learnerId: string): Promise<GatewayLearnerContext>;
}

export class InMemoryGatewayDurableSink implements GatewayDurableSink {
  readonly learningEvidence: Array<Readonly<Record<string, unknown>>> = [];
  readonly sessionSummaries: Array<Readonly<Record<string, unknown>>> = [];
  readonly cardInteractions: GatewayCardInteraction[] = [];
  readonly visualMetadata: GatewayVisualMetadata[] = [];
  private readonly eventIds = new Set<string>();
  async probeReadiness(): Promise<boolean> { return true; }
  async loadLearnerContext(_learnerId: string): Promise<GatewayLearnerContext> {
    void _learnerId;
    return { mastery: [], misconceptions: [], interests: [], recentSummaries: [], instructionLines: [] };
  }

  async writeLearningEvidence(eventId: string, sessionId: string, learnerId: string, payload: Readonly<Record<string, unknown>>): Promise<void> {
    if (this.eventIds.has(eventId)) return;
    this.eventIds.add(eventId);
    this.learningEvidence.push({ sessionId, learnerId, ...payload });
  }

  async writeSessionSummary(eventId: string, sessionId: string, learnerId: string, payload: Readonly<Record<string, unknown>>): Promise<void> {
    if (this.eventIds.has(eventId)) return;
    this.eventIds.add(eventId);
    this.sessionSummaries.push({ sessionId, learnerId, ...payload });
  }
  async writeCardInteraction(eventId: string, input: GatewayCardInteraction): Promise<void> {
    if (this.eventIds.has(eventId)) return;
    this.eventIds.add(eventId);
    this.cardInteractions.push(input);
  }

  async writeVisualMetadata(eventId: string, input: GatewayVisualMetadata): Promise<void> {
    if (this.eventIds.has(eventId)) return;
    this.eventIds.add(eventId);
    this.visualMetadata.push(input);
  }
}

export class NeonGatewayDurableSink implements GatewayDurableSink {
  private readonly query: (text: string, parameters: readonly unknown[]) => Promise<unknown>;

  constructor(databaseUrl: string) {
    const sql = neon(databaseUrl);
    this.query = (text, parameters) => sql.query(text, [...parameters]);
  }
  async probeReadiness(): Promise<boolean> {
    const rows = await this.query(
      `WITH required_relations(name) AS (
         VALUES
           ('learner_profiles'),
           ('concept_mastery'),
           ('misconceptions'),
           ('learner_preferences'),
           ('schema_migrations'),
           ('topic_interests'),
           ('session_summaries'),
           ('gateway_durable_events'),
           ('exploration_edges'),
           ('card_interactions'),
           ('visual_metadata'),
           ('operational_metrics'),
           ('session_mutation_effects')
       ), required_columns(relation_name, column_name) AS (
         VALUES
           ('learner_profiles', 'learner_id'),
           ('learner_profiles', 'age_band'),
           ('concept_mastery', 'learner_id'),
           ('concept_mastery', 'concept'),
           ('concept_mastery', 'confidence'),
           ('concept_mastery', 'evidence_count'),
           ('concept_mastery', 'last_evidence'),
           ('concept_mastery', 'updated_at'),
           ('misconceptions', 'learner_id'),
           ('misconceptions', 'concept'),
           ('misconceptions', 'description'),
           ('misconceptions', 'evidence_count'),
           ('misconceptions', 'updated_at'),
           ('learner_preferences', 'learner_id'),
           ('learner_preferences', 'explanation_mode'),
           ('learner_preferences', 'pace'),
           ('learner_preferences', 'challenge'),
           ('learner_preferences', 'updated_at'),
           ('topic_interests', 'learner_id'),
           ('topic_interests', 'topic'),
           ('topic_interests', 'weight'),
           ('topic_interests', 'updated_at'),
           ('session_summaries', 'session_id'),
           ('session_summaries', 'learner_id'),
           ('session_summaries', 'summary'),
           ('session_summaries', 'concepts'),
           ('session_summaries', 'started_at'),
           ('session_summaries', 'completed_at'),
           ('gateway_durable_events', 'event_id'),
           ('gateway_durable_events', 'kind'),
           ('gateway_durable_events', 'session_id'),
           ('gateway_durable_events', 'learner_id'),
           ('exploration_edges', 'session_id'),
           ('exploration_edges', 'from_concept'),
           ('exploration_edges', 'to_concept'),
           ('exploration_edges', 'relation'),
           ('card_interactions', 'session_id'),
           ('card_interactions', 'learner_id'),
           ('card_interactions', 'card_id'),
           ('card_interactions', 'purpose'),
           ('card_interactions', 'action'),
           ('card_interactions', 'concept'),
           ('card_interactions', 'occurred_at'),
           ('visual_metadata', 'visual_id'),
           ('visual_metadata', 'session_id'),
           ('visual_metadata', 'learner_id'),
           ('visual_metadata', 'concept'),
           ('visual_metadata', 'duration_seconds'),
           ('visual_metadata', 'resolution'),
           ('visual_metadata', 'outcome'),
           ('visual_metadata', 'prompt_version'),
           ('visual_metadata', 'latency_ms'),
           ('visual_metadata', 'created_at'),
           ('session_mutation_effects', 'effect_id')
       ), required_indexes(name) AS (
         VALUES
           ('concept_mastery_pkey'),
           ('misconceptions_pkey'),
           ('learner_preferences_pkey'),
           ('topic_interests_pkey'),
           ('session_summaries_pkey'),
           ('gateway_durable_events_pkey'),
           ('gateway_durable_events_session_idx'),
           ('concept_mastery_learner_updated_idx'),
           ('misconceptions_learner_updated_idx'),
           ('topic_interests_learner_rank_idx'),
           ('card_interactions_learner_time_idx'),
           ('visual_metadata_learner_time_idx')
       )
       SELECT
         NOT EXISTS (
           SELECT 1 FROM required_relations WHERE to_regclass('public.' || name) IS NULL
         )
         AND NOT EXISTS (
           SELECT 1
           FROM required_columns
           LEFT JOIN information_schema.columns
             ON columns.table_schema = 'public'
            AND columns.table_name = required_columns.relation_name
            AND columns.column_name = required_columns.column_name
           WHERE columns.column_name IS NULL
         )
         AND NOT EXISTS (
           SELECT 1 FROM required_indexes WHERE to_regclass('public.' || name) IS NULL
         )
         AND (
           SELECT count(*) = 4
           FROM schema_migrations
           WHERE name IN (
             '0001_learning_memory.sql',
             '0002_gateway_durable_events.sql',
             '0004_session_mutation_effects.sql',
             '0005_learning_context_retention_indexes.sql'
           )
         ) AS durable_events_ready`,
      []
    ) as Array<{ durable_events_ready?: boolean }>;
    return rows[0]?.durable_events_ready === true;
  }
  async loadLearnerContext(learnerId: string): Promise<GatewayLearnerContext> {
    const rows = await this.query(
      `SELECT
         COALESCE((SELECT jsonb_agg(jsonb_build_object(
           'concept', concept, 'confidence', confidence, 'evidenceCount', evidence_count
         ) ORDER BY updated_at DESC) FROM (
           SELECT concept, confidence, evidence_count, updated_at
           FROM concept_mastery WHERE learner_id = $1 ORDER BY updated_at DESC LIMIT 20
         ) mastery_rows), '[]'::jsonb) AS mastery,
         COALESCE((SELECT jsonb_agg(jsonb_build_object(
           'concept', concept, 'description', description, 'evidenceCount', evidence_count
         ) ORDER BY updated_at DESC) FROM (
           SELECT concept, description, evidence_count, updated_at
           FROM misconceptions WHERE learner_id = $1 ORDER BY updated_at DESC LIMIT 12
         ) misconception_rows), '[]'::jsonb) AS misconceptions,
         (SELECT CASE WHEN age_band IN ('13-15', '16-18') THEN age_band END FROM learner_profiles WHERE learner_id = $1) AS age_band,
         (SELECT explanation_mode FROM learner_preferences WHERE learner_id = $1) AS explanation_mode,
         (SELECT pace FROM learner_preferences WHERE learner_id = $1) AS pace,
         (SELECT challenge FROM learner_preferences WHERE learner_id = $1) AS challenge,
         COALESCE((SELECT jsonb_agg(topic ORDER BY weight DESC, updated_at DESC) FROM (
           SELECT topic, weight, updated_at FROM topic_interests
           WHERE learner_id = $1 ORDER BY weight DESC, updated_at DESC LIMIT 12
         ) interest_rows), '[]'::jsonb) AS interests,
         COALESCE((SELECT jsonb_agg(summary ORDER BY completed_at DESC) FROM (
           SELECT summary, completed_at FROM session_summaries
           WHERE learner_id = $1 ORDER BY completed_at DESC LIMIT 5
         ) summary_rows), '[]'::jsonb) AS recent_summaries`,
      [learnerId]
    ) as Array<{
      mastery?: GatewayMasteryContext[];
      misconceptions?: GatewayMisconceptionContext[];
      age_band?: "13-15" | "16-18" | null;
      explanation_mode?: string | null;
      pace?: string | null;
      challenge?: string | null;
      interests?: string[];
      recent_summaries?: string[];
    }>;
    const row = rows[0] ?? {};
    const mastery = row.mastery ?? [];
    const misconceptions = row.misconceptions ?? [];
    const interests = row.interests ?? [];
    const recentSummaries = row.recent_summaries ?? [];
    const instructionLines = [
      ...mastery.map((item) => `${item.concept}: mastery ${Number(item.confidence).toFixed(2)}, ${item.evidenceCount} evidence`),
      ...misconceptions.map((item) => `${item.concept}: recurring misconception — ${item.description}`),
      ...(row.explanation_mode ? [`Preferred explanation mode: ${row.explanation_mode}`] : []),
      ...(row.pace ? [`Preferred pace: ${row.pace}`] : []),
      ...(row.challenge ? [`Preferred challenge: ${row.challenge}`] : []),
      ...(interests.length ? [`Interests: ${interests.join(", ")}`] : []),
      ...recentSummaries.map((summary) => `Recent lesson: ${summary}`)
    ];
    return {
      mastery,
      misconceptions,
      ...(row.age_band ? { ageBand: row.age_band } : {}),
      ...(row.explanation_mode ? { explanationMode: row.explanation_mode } : {}),
      ...(row.pace ? { pace: row.pace } : {}),
      ...(row.challenge ? { challenge: row.challenge } : {}),
      interests,
      recentSummaries,
      instructionLines
    };
  }

  async writeLearningEvidence(eventId: string, sessionId: string, learnerId: string, payload: Readonly<Record<string, unknown>>): Promise<void> {
    const evidence = recordLearningEvidenceArgumentsSchema.parse(payload);
    const signals = evidence.preferenceSignals;
    const concept = evidence.concept.trim().toLowerCase();
    const interests = [...new Set((signals?.interests ?? []).map((interest) => interest.trim().toLowerCase()))];
    const misconception = evidence.misconception?.trim().toLowerCase() ?? null;
    await this.query(
      `WITH accepted AS (
         INSERT INTO gateway_durable_events (event_id, kind, session_id, learner_id)
         VALUES ($10, 'learning_evidence', $11, $1)
         ON CONFLICT (event_id) DO NOTHING
         RETURNING 1
       ), mastery AS (
         INSERT INTO concept_mastery (learner_id, concept, confidence, evidence_count, last_evidence)
         SELECT $1, $2, LEAST(1, GREATEST(0, 0.5 + $3::double precision)), 1, $4 FROM accepted
         ON CONFLICT (learner_id, concept) DO UPDATE SET
           confidence = LEAST(1, GREATEST(0, concept_mastery.confidence + $3::double precision)),
           evidence_count = concept_mastery.evidence_count + 1,
           last_evidence = $4, updated_at = now()
       ), misconception AS (
         INSERT INTO misconceptions (learner_id, concept, description)
         SELECT $1, $2, $5 FROM accepted WHERE $5::text IS NOT NULL
         ON CONFLICT (learner_id, concept, description) DO UPDATE SET
           evidence_count = misconceptions.evidence_count + 1, updated_at = now()
       ), preferences AS (
         INSERT INTO learner_preferences (learner_id, explanation_mode, pace, challenge)
         SELECT $1, $6, $7, $8 FROM accepted
         ON CONFLICT (learner_id) DO UPDATE SET
           explanation_mode = COALESCE(EXCLUDED.explanation_mode, learner_preferences.explanation_mode),
           pace = COALESCE(EXCLUDED.pace, learner_preferences.pace),
           challenge = COALESCE(EXCLUDED.challenge, learner_preferences.challenge),
           updated_at = now()
       )
       INSERT INTO topic_interests (learner_id, topic)
       SELECT $1, topic FROM accepted CROSS JOIN unnest($9::text[]) AS topic
       ON CONFLICT (learner_id, topic) DO UPDATE SET weight = topic_interests.weight + 1, updated_at = now()`,
      [
        learnerId,
        concept,
        evidence.confidenceDelta,
        evidence.evidence,
        misconception,
        signals?.explanationMode ?? null,
        signals?.pace ?? null,
        signals?.challenge ?? null,
        interests,
        eventId,
        sessionId
      ]
    );
    await this.query(
      `WITH prune_mastery AS (
         DELETE FROM concept_mastery
         WHERE learner_id = $1 AND concept NOT IN (
           SELECT concept FROM concept_mastery WHERE learner_id = $1 ORDER BY updated_at DESC, concept LIMIT 50
         )
       ), prune_misconceptions AS (
         DELETE FROM misconceptions
         WHERE learner_id = $1 AND (concept, description) NOT IN (
           SELECT concept, description FROM misconceptions
           WHERE learner_id = $1 ORDER BY updated_at DESC, concept, description LIMIT 20
         )
       )
       DELETE FROM topic_interests
       WHERE learner_id = $1 AND topic NOT IN (
         SELECT topic FROM topic_interests WHERE learner_id = $1 ORDER BY weight DESC, updated_at DESC, topic LIMIT 8
       )`,
      [learnerId]
    );
  }

  async writeSessionSummary(eventId: string, sessionId: string, learnerId: string, payload: Readonly<Record<string, unknown>>): Promise<void> {
    const summary = durableSummarySchema.parse(payload);
    const uniqueEdges = [...new Map(
      summary.explorationEdges.map((edge) => [`${edge.from.toLowerCase()}\u0000${edge.to.toLowerCase()}`, edge])
    ).values()];
    await this.query(
      `WITH accepted AS (
         INSERT INTO gateway_durable_events (event_id, kind, session_id, learner_id)
         VALUES ($7, 'session_summary', $1, $2)
         ON CONFLICT (event_id) DO NOTHING
         RETURNING 1
       ), summary_write AS (
         INSERT INTO session_summaries (session_id, learner_id, summary, concepts, started_at, completed_at)
         SELECT $1, $2, $3, $4, $5, $6 FROM accepted
         ON CONFLICT (session_id) DO UPDATE SET
           summary = EXCLUDED.summary, concepts = EXCLUDED.concepts,
           started_at = EXCLUDED.started_at, completed_at = EXCLUDED.completed_at
       )
       INSERT INTO exploration_edges (session_id, from_concept, to_concept, relation)
       SELECT $1, edge->>'from', edge->>'to', edge->>'relation'
       FROM accepted CROSS JOIN jsonb_array_elements($8::jsonb) AS edge
       ON CONFLICT (session_id, from_concept, to_concept) DO UPDATE SET relation = EXCLUDED.relation`,
      [
        sessionId,
        learnerId,
        summary.summary.trim().slice(0, 2_000),
        summary.concepts.map((concept) => concept.trim()).filter(Boolean).slice(0, 20),
        summary.startedAt,
        summary.endedAt,
        eventId,
        JSON.stringify(uniqueEdges)
      ]
    );
  }

  async writeCardInteraction(eventId: string, input: GatewayCardInteraction): Promise<void> {
    await this.query(
      `WITH claimed AS (
         INSERT INTO session_mutation_effects (effect_id) VALUES ($1)
         ON CONFLICT (effect_id) DO NOTHING RETURNING 1
       )
       INSERT INTO card_interactions
       (session_id, learner_id, card_id, purpose, action, concept, occurred_at)
       SELECT $2, $3, $4, $5, $6, $7, $8 FROM claimed`,
      [eventId, input.sessionId, input.learnerId, input.cardId, input.purpose, input.action, input.concept ?? null, input.occurredAt]
    );
  }

  async writeVisualMetadata(_eventId: string, input: GatewayVisualMetadata): Promise<void> {
    await this.query(
      `INSERT INTO visual_metadata
       (visual_id, session_id, learner_id, concept, duration_seconds, resolution, outcome, prompt_version, latency_ms, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (visual_id) DO UPDATE SET outcome = EXCLUDED.outcome, latency_ms = EXCLUDED.latency_ms`,
      [input.visualId, input.sessionId, input.learnerId ?? null, input.concept, input.durationSeconds, input.resolution, input.outcome, input.promptVersion, input.latencyMs ?? null, input.createdAt]
    );
  }
}

export class SessionEventBus {
  private readonly origin = randomUUID();
  private readonly subscribers = new Map<string, Set<OwnedSubscriber>>();
  private readonly publisher?: Redis;
  private readonly receiver?: Redis;
  private readonly localStates = new Map<string, GatewaySessionState>();
  private readonly localRevisions = new Map<string, number>();
  private readonly localCommandRevisions = new Map<string, number>();
  private readonly localOwners = new Map<string, GatewaySessionLease>();
  private readonly localPaidCommands = new Map<string, number>();
  private readonly localPaidOperationIds = new Set<string>();
  private readonly localTranscripts = new Map<string, string[]>();
  private readonly localTranscriptEffects = new Set<string>();
  private readonly localSocketPermits = new Map<string, SocketPermit>();
  private readonly requireRedis: boolean;
  private readonly localTerminalSessions = new Set<string>();
  private readonly localCommandOperations = new Map<string, {
    state: "pending" | "completed";
    revision: number;
    attemptToken: string;
    updatedAt: number;
    events: readonly SessionEvent[];
  }>();
  private readonly maxActiveSessionsPerLearner: number;
  private readonly maxSocketsPerSession: number;
  private readonly maxSocketsPerLearner: number;
  private readonly maxSocketsPerNetwork: number;
  private readonly maxPaidCommandsPerLearner: number;
  private readonly encryptionKey?: Buffer;
  private readonly activeTranscriptTtlSeconds: number;
  private databaseReady = false;
  private outboxHealthy = true;
  private readonly readinessTimer: NodeJS.Timeout;

  constructor(
    redisUrl: string | undefined,
    private readonly logger: SafeLogger,
    private readonly durableSink: GatewayDurableSink = new InMemoryGatewayDurableSink(),
    options: SessionEventBusOptions = {}
  ) {
    this.requireRedis = options.requireRedis ?? false;
    this.maxActiveSessionsPerLearner = options.maxActiveSessionsPerLearner ?? 2;
    this.maxSocketsPerSession = options.maxSocketsPerSession ?? DEFAULT_MAX_SOCKETS_PER_SESSION;
    this.maxSocketsPerLearner = options.maxSocketsPerLearner ?? DEFAULT_MAX_SOCKETS_PER_LEARNER;
    this.maxSocketsPerNetwork = options.maxSocketsPerNetwork ?? DEFAULT_MAX_SOCKETS_PER_NETWORK;
    this.maxPaidCommandsPerLearner = options.maxPaidCommandsPerLearner ?? 24;
    this.activeTranscriptTtlSeconds = options.activeTranscriptTtlSeconds ?? 3_600;
    this.encryptionKey = options.transcriptEncryptionKey
      ? decodeRetainedPayloadKey(options.transcriptEncryptionKey)
      : undefined;
    this.readinessTimer = setInterval(() => void this.refreshReadiness(), 10_000);
    this.readinessTimer.unref();
    if (!redisUrl) return;
    if (!this.encryptionKey) throw new Error("TRANSCRIPT_ENCRYPTION_KEY is required with Redis");
    const tls = redisUrl.startsWith("rediss://") ? { rejectUnauthorized: true } : undefined;
    this.publisher = new Redis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: 2, enableReadyCheck: true, tls });
    this.receiver = this.publisher.duplicate();
    this.publisher.on("error", () => this.logger.write("warn", "Redis publisher unavailable", { provider: "redis", recoverable: !this.requireRedis }));
    this.receiver.on("error", () => this.logger.write("warn", "Redis subscriber unavailable", { provider: "redis", recoverable: !this.requireRedis }));
  }

  async connect(): Promise<void> {
    if (!this.publisher || !this.receiver) {
      if (this.requireRedis) throw new Error("Redis is required");
      await this.refreshReadiness();
      return;
    }
    await Promise.all([this.publisher.connect(), this.receiver.connect()]);
    await this.receiver.psubscribe("axiom:session:*:events");
    await this.refreshReadiness();
    if (this.requireRedis && !this.databaseReady) {
      throw new Error("Durable database schema is unavailable");
    }
    this.receiver.on("pmessage", (_pattern, channel, raw) => {
      const sessionId = channel.slice("axiom:session:".length, -":events".length);
      try {
        const wire = JSON.parse(decryptRetainedPayload(
          raw,
          this.encryptionKey!,
          `gateway-event-pubsub|${sessionId}|${channel}`
        )) as Partial<WireEvent>;
        if (wire.origin === this.origin) return;
        const event = sessionEventSchema.safeParse(wire.event);
        const owner = this.localOwners.get(sessionId);
        const learnerId = wire.learnerId;
        if (event.success && learnerId && owner?.learnerId === learnerId) this.deliver(sessionId, learnerId, event.data);
      } catch {
        this.logger.write("warn", "Rejected invalid event from fan-out", { provider: "redis", recoverable: true });
      }
    });
  }

  isReady(): boolean {
    const redisReady = !this.requireRedis || (this.publisher?.status === "ready" && this.receiver?.status === "ready");
    return redisReady && this.databaseReady && this.outboxHealthy;
  }

  readiness(): { redis: boolean; database: boolean; durableOutbox: boolean } {
    return {
      redis: !this.requireRedis || (this.publisher?.status === "ready" && this.receiver?.status === "ready"),
      database: this.databaseReady,
      durableOutbox: this.outboxHealthy
    };
  }

  async bindSessionOwner(
    sessionId: string,
    learnerId: string,
    callId?: string
  ): Promise<GatewaySessionLease | undefined> {
    const lease: GatewaySessionLease = {
      sessionId,
      learnerId,
      gatewayInstanceToken: this.origin,
      ...(callId ? { callId } : {})
    };
    if (this.publisher?.status === "ready") {
      const result = Number(await this.publisher.eval(
        `-- axiom-gateway-bind-owner-fenced
if redis.call("EXISTS", KEYS[3]) == 1 then return -2 end
local existing = redis.call("GET", KEYS[1])
if existing then
  local first = string.find(existing, "|")
  local second = first and string.find(existing, "|", first + 1)
  if not first or not second or string.sub(existing, 1, first - 1) ~= ARGV[1] then return 0 end
  local existingToken = string.sub(existing, first + 1, second - 1)
  if existingToken ~= ARGV[2] then return 0 end
else
  for _, activeSession in ipairs(redis.call("SMEMBERS", KEYS[2])) do
    if redis.call("EXISTS", "axiom:session-owner:" .. activeSession) == 0 then
      redis.call("SREM", KEYS[2], activeSession)
    end
  end
  if redis.call("SCARD", KEYS[2]) >= tonumber(ARGV[4]) then return -1 end
  redis.call("SADD", KEYS[2], ARGV[6])
end
redis.call("SET", KEYS[1], ARGV[1] .. "|" .. ARGV[2] .. "|" .. ARGV[3], "EX", ARGV[5])
redis.call("EXPIRE", KEYS[2], ARGV[5])
return 1`,
        3,
        `axiom:session-owner:${sessionId}`,
        `axiom:learner-sessions:${learnerId}`,
        `axiom:session:${sessionId}:terminal`,
        learnerId,
        this.origin,
        callId ?? "",
        this.maxActiveSessionsPerLearner,
        OWNER_LEASE_TTL_SECONDS,
        sessionId
      ));
      if (result !== 1) return undefined;
      this.localOwners.set(sessionId, lease);
      return lease;
    }
    if (this.localTerminalSessions.has(sessionId)) return undefined;
    if (this.requireRedis) throw new Error("Redis ownership unavailable");
    const owner = this.localOwners.get(sessionId);
    if (owner && owner.learnerId !== learnerId) return undefined;
    const active = [...this.localOwners.values()].filter((candidate) => candidate.learnerId === learnerId).length;
    if (!owner && active >= this.maxActiveSessionsPerLearner) return undefined;
    this.localOwners.set(sessionId, lease);
    return lease;
  }

  async refreshSessionOwner(lease: GatewaySessionLease, callId = lease.callId): Promise<boolean> {
    const refreshed: GatewaySessionLease = { ...lease, ...(callId ? { callId } : {}) };
    if (this.publisher?.status === "ready") {
      const result = Number(await this.publisher.eval(
        `-- axiom-gateway-refresh-owner-fenced
if redis.call("EXISTS", KEYS[3]) == 1 then return 0 end
local existing = redis.call("GET", KEYS[1])
if not existing then return 0 end
local expected = ARGV[1] .. "|" .. ARGV[2] .. "|"
if string.sub(existing, 1, string.len(expected)) ~= expected then return 0 end
redis.call("SET", KEYS[1], expected .. ARGV[3], "EX", ARGV[4])
redis.call("EXPIRE", KEYS[2], ARGV[4])
return 1`,
        3,
        `axiom:session-owner:${lease.sessionId}`,
        `axiom:learner-sessions:${lease.learnerId}`,
        `axiom:session:${lease.sessionId}:terminal`,
        lease.learnerId,
        lease.gatewayInstanceToken,
        callId ?? "",
        OWNER_LEASE_TTL_SECONDS
      ));
      if (result !== 1) {
        if (this.localOwners.get(lease.sessionId)?.gatewayInstanceToken === lease.gatewayInstanceToken) {
          this.localOwners.delete(lease.sessionId);
        }
        return false;
      }
      this.localOwners.set(lease.sessionId, refreshed);
      return true;
    }
    if (this.requireRedis) throw new Error("Redis ownership unavailable");
    const current = this.localOwners.get(lease.sessionId);
    if (current?.gatewayInstanceToken !== lease.gatewayInstanceToken || current.learnerId !== lease.learnerId) return false;
    this.localOwners.set(lease.sessionId, refreshed);
    return true;
  }

  async reserveSocketPermit(
    sessionId: string,
    learnerId: string,
    connectionIdentity: string
  ): Promise<SocketPermit | undefined> {
    const permit: SocketPermit = {
      id: randomUUID(),
      sessionId,
      learnerId,
      networkHash: createHash("sha256").update(normalizeSocketNetworkIdentity(connectionIdentity)).digest("base64url")
    };
    if (this.publisher?.status === "ready") {
      const now = Date.now();
      const expiresAt = now + SOCKET_PERMIT_TTL_SECONDS * 1_000;
      const accepted = Number(await this.publisher.eval(
        `-- axiom-gateway-reserve-socket
if redis.call("EXISTS", KEYS[4]) == 1 then return 0 end
for index = 1, 3 do
  redis.call("ZREMRANGEBYSCORE", KEYS[index], "-inf", ARGV[2])
end
if redis.call("ZCARD", KEYS[1]) >= tonumber(ARGV[4])
  or redis.call("ZCARD", KEYS[2]) >= tonumber(ARGV[5])
  or redis.call("ZCARD", KEYS[3]) >= tonumber(ARGV[6]) then
  return 0
end
for index = 1, 3 do
  redis.call("ZADD", KEYS[index], ARGV[3], ARGV[1])
  redis.call("EXPIRE", KEYS[index], ARGV[7])
end
return 1`,
        4,
        `axiom:gateway-sockets:session:${sessionId}`,
        `axiom:gateway-sockets:learner:${learnerId}`,
        `axiom:gateway-sockets:network:${permit.networkHash}`,
        `axiom:session:${sessionId}:terminal`,
        permit.id,
        now,
        expiresAt,
        this.maxSocketsPerSession,
        this.maxSocketsPerLearner,
        this.maxSocketsPerNetwork,
        SOCKET_PERMIT_TTL_SECONDS * 2
      ));
      return accepted === 1 ? permit : undefined;
    }
    if (this.requireRedis) throw new Error("Redis socket admission unavailable");
    const permits = [...this.localSocketPermits.values()];
    if (
      permits.filter((candidate) => candidate.sessionId === sessionId).length >= this.maxSocketsPerSession
      || permits.filter((candidate) => candidate.learnerId === learnerId).length >= this.maxSocketsPerLearner
      || permits.filter((candidate) => candidate.networkHash === permit.networkHash).length >= this.maxSocketsPerNetwork
    ) {
      return undefined;
    }
    this.localSocketPermits.set(permit.id, permit);
    return permit;
  }

  async releaseSocketPermit(permit: SocketPermit): Promise<void> {
    this.localSocketPermits.delete(permit.id);
    if (this.publisher?.status !== "ready") return;
    await this.publisher.eval(
      `-- axiom-gateway-release-socket
for index = 1, 3 do redis.call("ZREM", KEYS[index], ARGV[1]) end
return 1`,
      3,
      `axiom:gateway-sockets:session:${permit.sessionId}`,
      `axiom:gateway-sockets:learner:${permit.learnerId}`,
      `axiom:gateway-sockets:network:${permit.networkHash}`,
      permit.id
    );
  }

  async refreshSocketPermit(permit: SocketPermit): Promise<boolean> {
    if (this.publisher?.status === "ready") {
      const expiresAt = Date.now() + SOCKET_PERMIT_TTL_SECONDS * 1_000;
      return Number(await this.publisher.eval(
        `-- axiom-gateway-refresh-socket
for index = 1, 3 do
  if redis.call("ZSCORE", KEYS[index], ARGV[1]) == false then return 0 end
end
for index = 1, 3 do
  redis.call("ZADD", KEYS[index], "XX", ARGV[2], ARGV[1])
  redis.call("EXPIRE", KEYS[index], ARGV[3])
end
return 1`,
        3,
        `axiom:gateway-sockets:session:${permit.sessionId}`,
        `axiom:gateway-sockets:learner:${permit.learnerId}`,
        `axiom:gateway-sockets:network:${permit.networkHash}`,
        permit.id,
        expiresAt,
        SOCKET_PERMIT_TTL_SECONDS * 2
      )) === 1;
    }
    if (this.requireRedis) throw new Error("Redis socket admission unavailable");
    return this.localSocketPermits.has(permit.id);
  }

  async releaseSessionOwner(lease: GatewaySessionLease): Promise<boolean> {
    const local = this.localOwners.get(lease.sessionId);
    if (local?.gatewayInstanceToken === lease.gatewayInstanceToken) this.localOwners.delete(lease.sessionId);
    if (this.publisher?.status !== "ready") {
      if (this.requireRedis) throw new Error("Redis ownership unavailable");
      return local?.gatewayInstanceToken === lease.gatewayInstanceToken;
    }
    return Number(await this.publisher.eval(
      `-- axiom-gateway-release-owner-fenced
local existing = redis.call("GET", KEYS[1])
if not existing then return 0 end
local expected = ARGV[1] .. "|" .. ARGV[2] .. "|"
if string.sub(existing, 1, string.len(expected)) ~= expected then return 0 end
redis.call("DEL", KEYS[1])
redis.call("SREM", KEYS[2], ARGV[3])
return 1`,
      2,
      `axiom:session-owner:${lease.sessionId}`,
      `axiom:learner-sessions:${lease.learnerId}`,
      lease.learnerId,
      lease.gatewayInstanceToken,
      lease.sessionId
    )) === 1;
  }

  async finalizeSession(lease: GatewaySessionLease): Promise<boolean> {
    const local = this.localOwners.get(lease.sessionId);
    if (local?.gatewayInstanceToken === lease.gatewayInstanceToken) {
      this.localTerminalSessions.add(lease.sessionId);
      this.localOwners.delete(lease.sessionId);
      this.localStates.delete(lease.sessionId);
      this.localTranscripts.delete(lease.sessionId);
    }
    if (this.publisher?.status !== "ready") {
      if (this.requireRedis) throw new Error("Redis terminal finalize unavailable");
      return local?.gatewayInstanceToken === lease.gatewayInstanceToken;
    }
    const sessionHash = createHash("sha256").update(lease.sessionId).digest("base64url");
    return Number(await this.publisher.eval(
      `-- axiom-gateway-session-terminal-finalize
local existing = redis.call("GET", KEYS[1])
local expected = ARGV[1] .. "|" .. ARGV[2] .. "|"
if not existing or string.sub(existing, 1, string.len(expected)) ~= expected then return 0 end
redis.call("SET", KEYS[2], "1", "EX", ARGV[4])
local mapping = redis.call("GET", KEYS[7])
if mapping then
  local parsed = cjson.decode(mapping)
  if redis.call("GET", parsed.leaseKey) == parsed.leaseId then redis.call("DEL", parsed.leaseKey) end
end
redis.call("DEL", KEYS[1], KEYS[3], KEYS[4], KEYS[5], KEYS[7])
redis.call("SREM", KEYS[6], ARGV[3])
return 1`,
      7,
      `axiom:session-owner:${lease.sessionId}`,
      `axiom:session:${lease.sessionId}:terminal`,
      `axiom:session-state:${lease.sessionId}`,
      `axiom:session-transcript:${lease.sessionId}`,
      `axiom:session:${lease.sessionId}:events`,
      `axiom:learner-sessions:${lease.learnerId}`,
      `axiom:realtime:session:${sessionHash}`,
      lease.learnerId,
      lease.gatewayInstanceToken,
      lease.sessionId,
      86_400
    )) === 1;
  }

  subscribe(sessionId: string, learnerId: string, subscriber: EventSubscriber): () => void {
    const listeners = this.subscribers.get(sessionId) ?? new Set<OwnedSubscriber>();
    const owned = { learnerId, receive: subscriber };
    listeners.add(owned);
    this.subscribers.set(sessionId, listeners);
    return () => {
      listeners.delete(owned);
      if (listeners.size === 0) this.subscribers.delete(sessionId);
    };
  }

  async publish(sessionId: string, learnerId: string, candidate: SessionEvent): Promise<void> {
    const event = sessionEventSchema.parse(candidate);
    if (this.publisher?.status !== "ready") {
      if (this.localTerminalSessions.has(sessionId)) throw new Error("Session is terminal");
      if (this.requireRedis) throw new Error("Redis fan-out unavailable");
      this.deliver(sessionId, learnerId, event);
      return;
    }
    const wire: WireEvent = { origin: this.origin, learnerId, event };
    const channel = `axiom:session:${sessionId}:events`;
    const encryptedEvent = encryptRetainedPayload(
      JSON.stringify(event),
      this.encryptionKey!,
      `fanout-event|${sessionId}|${channel}`
    );
    const encryptedWire = encryptRetainedPayload(
      JSON.stringify(wire),
      this.encryptionKey!,
      `gateway-event-pubsub|${sessionId}|${channel}`
    );
    const published = Number(await this.publisher.eval(
      `-- axiom-gateway-session-event-fanout
if redis.call("EXISTS", KEYS[2]) == 1 then return 0 end
local length = redis.call("RPUSH", KEYS[1], ARGV[1])
if length == 1 then redis.call("EXPIRE", KEYS[1], ARGV[2]) end
redis.call("PUBLISH", KEYS[1], ARGV[3])
return 1`,
      2,
      channel,
      `axiom:session:${sessionId}:terminal`,
      encryptedEvent,
      SESSION_STATE_TTL_SECONDS,
      encryptedWire
    ));
    if (published !== 1) throw new Error("Session is terminal");
    this.deliver(sessionId, learnerId, event);
  }

  async claimCommand(sessionId: string, commandId: string, ttlSeconds = 900): Promise<boolean> {
    if (this.publisher?.status === "ready") {
      return (await this.publisher.set(`axiom:command:${sessionId}:${commandId}`, "1", "EX", ttlSeconds, "NX")) === "OK";
    }
    if (this.requireRedis) throw new Error("Redis idempotency unavailable");
    return true;
  }

  async claimGatewayTicket(input: GatewayTicketClaim, nowUnixSeconds: number): Promise<boolean> {
    if (
      !/^[A-Za-z0-9_-]{16,200}$/u.test(input.nonce)
      || !/^lrn_[A-Za-z0-9_-]{16,32}$/u.test(input.learnerId)
      || !/^[0-9a-f-]{36}$/iu.test(input.sessionId)
      || !/^rtc_[A-Za-z0-9_-]{4,240}$/u.test(input.callId)
      || !Number.isSafeInteger(input.expiresAtUnixSeconds)
      || !Number.isSafeInteger(nowUnixSeconds)
      || nowUnixSeconds < 0
    ) throw new Error("Invalid gateway ticket claim");
    if (input.expiresAtUnixSeconds <= nowUnixSeconds) return false;
    if (this.publisher?.status === "ready") {
      const sessionHash = createHash("sha256").update(input.sessionId).digest("base64url");
      const learnerHash = createHash("sha256").update(input.learnerId).digest("base64url");
      const nonceHash = createHash("sha256").update(input.nonce).digest("base64url");
      return Number(await this.publisher.eval(
        `-- axiom-gateway-ticket-claim
if tonumber(ARGV[3]) <= tonumber(ARGV[2]) then return 0 end
if redis.call("GET", KEYS[4]) or redis.call("GET", KEYS[3]) then return 0 end
local mapping = redis.call("GET", KEYS[1])
if not mapping then return 0 end
local parsed = cjson.decode(mapping)
if parsed.leaseKey ~= KEYS[2] or parsed.callId ~= ARGV[1] then return 0 end
if redis.call("GET", KEYS[2]) ~= parsed.leaseId then return 0 end
local ttl = tonumber(ARGV[3]) - tonumber(ARGV[2])
local claimed = redis.call("SET", KEYS[3], "1", "EX", ttl, "NX")
if not claimed then return 0 end
return 1`,
        4,
        `axiom:realtime:session:${sessionHash}`,
        `axiom:realtime:active:${learnerHash}`,
        `axiom:gateway:ticket-nonce:${nonceHash}`,
        `axiom:session:${input.sessionId}:terminal`,
        input.callId,
        nowUnixSeconds,
        input.expiresAtUnixSeconds
      )) === 1;
    }
    if (this.requireRedis) throw new Error("Redis gateway ticket claim unavailable");
    return await this.claimCommand(
      input.sessionId,
      `gateway-auth:${input.nonce}`,
      Math.max(1, input.expiresAtUnixSeconds - nowUnixSeconds)
    );
  }


  async beginCommandOperation(
    sessionId: string,
    commandId: string,
    revision: number,
    currentRevision: number,
    ttlSeconds = 900
  ): Promise<CommandOperationStart> {
    const operationKey = `axiom:command-operation:${sessionId}:${commandId}`;
    const markerKey = `${operationKey}:status`;
    const resultKey = `${operationKey}:result`;
    const attemptToken = randomUUID();
    if (this.publisher?.status === "ready") {
      const now = Date.now();
      const activeStateKey = `axiom:session:${sessionId}:state`;
      const encryptedActiveState = await this.publisher.get(activeStateKey);
      let nextActiveState = "";
      if (encryptedActiveState) {
        const candidate = JSON.parse(
          decryptRetainedPayload(
            encryptedActiveState,
            this.encryptionKey!,
            `active-state|${sessionId}|${activeStateKey}`
          )
        ) as Record<string, unknown>;
        candidate.revision = revision;
        if (typeof candidate.updatedAt === "string") candidate.updatedAt = new Date(now).toISOString();
        nextActiveState = encryptRetainedPayload(
          JSON.stringify(candidate),
          this.encryptionKey!,
          `active-state|${sessionId}|${activeStateKey}`
        );
      }
      const result = Number(await this.publisher.eval(
        `-- axiom-gateway-command-operation-begin-fenced
if redis.call("EXISTS", KEYS[4]) == 1 then return -2 end
local status = redis.call("GET", KEYS[2])
if status == "completed" then return 3 end
local current = tonumber(redis.call("GET", KEYS[1]) or ARGV[1])
if status and string.sub(status, 1, 8) == "pending:" then
  local tokenEnd = string.find(status, ":", 9)
  local revisionEnd = tokenEnd and string.find(status, ":", tokenEnd + 1)
  local pendingRevision = revisionEnd and tonumber(string.sub(status, tokenEnd + 1, revisionEnd - 1))
  local updated = revisionEnd and tonumber(string.sub(status, revisionEnd + 1))
  if pendingRevision ~= tonumber(ARGV[2]) or current ~= pendingRevision then return -1 end
  if updated and tonumber(ARGV[5]) - updated < 30000 then return 2 end
elseif tonumber(ARGV[2]) ~= current + 1 then
  return -1
end
if ARGV[6] ~= "" then redis.call("SET", KEYS[3], ARGV[6], "EX", ARGV[3]) end
redis.call("SET", KEYS[1], ARGV[2], "EX", ARGV[3])
redis.call("SET", KEYS[2], "pending:" .. ARGV[4] .. ":" .. ARGV[2] .. ":" .. ARGV[5], "EX", ARGV[3])
return 1`,
        4,
        `axiom:session:${sessionId}:revision`,
        markerKey,
        activeStateKey,
        `axiom:session:${sessionId}:terminal`,
        currentRevision,
        revision,
        ttlSeconds,
        attemptToken,
        now,
        nextActiveState
      ));
      if (result === 3) {
        const encrypted = await this.publisher.get(resultKey);
        if (!encrypted) return { state: "pending" };
        return {
          state: "completed",
          events: z.array(sessionEventSchema).parse(JSON.parse(
            decryptRetainedPayload(encrypted, this.encryptionKey!, `command-result|${sessionId}|${resultKey}`)
          ))
        };
      }
      if (result === 1) return { state: "accepted", attemptToken };
      return { state: result === 2 ? "pending" : "stale" };
    }
    if (this.localTerminalSessions.has(sessionId)) return { state: "stale" };
    if (this.requireRedis) throw new Error("Redis command operation unavailable");
    const key = `${sessionId}:${commandId}`;
    const existing = this.localCommandOperations.get(key);
    if (existing?.state === "completed") return { state: "completed", events: existing.events };
    const now = Date.now();
    const storedRevision = this.localCommandRevisions.get(sessionId) ?? currentRevision;
    if (existing && (existing.revision !== revision || storedRevision !== revision)) return { state: "stale" };
    if (existing && now - existing.updatedAt < 30_000) return { state: "pending" };
    if (!existing && revision !== storedRevision + 1) return { state: "stale" };
    this.localCommandRevisions.set(sessionId, revision);
    this.localCommandOperations.set(key, {
      state: "pending",
      revision,
      updatedAt: now,
      events: [],
      attemptToken
    });
    return { state: "accepted", attemptToken };
  }

  async completeCommandOperation(
    sessionId: string,
    commandId: string,
    attemptToken: string,
    events: readonly SessionEvent[],
    ttlSeconds = 900
  ): Promise<boolean> {
    const parsed = z.array(sessionEventSchema).parse(events);
    const operationKey = `axiom:command-operation:${sessionId}:${commandId}`;
    const resultKey = `${operationKey}:result`;
    if (this.publisher?.status === "ready") {
      return Number(await this.publisher.eval(
        `-- axiom-gateway-command-operation-complete-fenced
if redis.call("EXISTS", KEYS[3]) == 1 then return 0 end
local status = redis.call("GET", KEYS[2])
if not status or string.sub(status, 1, string.len(ARGV[1]) + 9) ~= "pending:" .. ARGV[1] .. ":" then return 0 end
redis.call("SET", KEYS[1], ARGV[2], "EX", ARGV[3])
redis.call("SET", KEYS[2], "completed", "EX", ARGV[3])
return 1`,
        3,
        resultKey,
        `${operationKey}:status`,
        `axiom:session:${sessionId}:terminal`,
        attemptToken,
        encryptRetainedPayload(JSON.stringify(parsed), this.encryptionKey!, `command-result|${sessionId}|${resultKey}`),
        ttlSeconds
      )) === 1;
    }
    if (this.localTerminalSessions.has(sessionId)) return false;
    if (this.requireRedis) throw new Error("Redis command operation unavailable");
    const key = `${sessionId}:${commandId}`;
    const existing = this.localCommandOperations.get(key);
    if (!existing || existing.state !== "pending" || existing.attemptToken !== attemptToken) return false;
    this.localCommandOperations.set(key, { ...existing, state: "completed", updatedAt: Date.now(), events: parsed });
    return true;
  }

  async reservePaidCommand(learnerId: string, operationId: string = randomUUID()): Promise<boolean> {
    const now = new Date();

    const utcDay = now.toISOString().slice(0, 10);
    const nextUtcMidnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
    const ttlSeconds = Math.max(1, Math.ceil((nextUtcMidnight - now.getTime()) / 1_000));
    const countKey = `axiom:paid-commands:${learnerId}:${utcDay}`;
    const operationKey = `axiom:paid-operation:${learnerId}:${utcDay}:${operationId}`;
    if (this.publisher?.status === "ready") {
      return Number(await this.publisher.eval(
        `-- axiom-idempotent-paid-command-utc-day
if redis.call("EXISTS", KEYS[2]) == 1 then return 1 end
local count = tonumber(redis.call("GET", KEYS[1]) or "0")
if count >= tonumber(ARGV[1]) then return 0 end
if count == 0 then
  redis.call("SET", KEYS[1], "1", "EX", ARGV[2])
else
  redis.call("INCR", KEYS[1])
end
redis.call("SET", KEYS[2], "1", "EX", ARGV[2])
return 1`,
        2,
        countKey,
        operationKey,
        this.maxPaidCommandsPerLearner,
        ttlSeconds
      )) === 1;
    }
    if (this.requireRedis) throw new Error("Redis paid-command quota unavailable");
    if (this.localPaidOperationIds.has(operationKey)) return true;
    const count = (this.localPaidCommands.get(countKey) ?? 0) + 1;
    if (count > this.maxPaidCommandsPerLearner) return false;
    this.localPaidOperationIds.add(operationKey);
    this.localPaidCommands.set(countKey, count);
    return true;
  }
  async reserveVisualEntitlement(input: GatewayVisualEntitlementInput): Promise<GatewayVisualEntitlement> {
    const dailyLimitSeconds = 60;
    if (this.publisher?.status !== "ready") {
      if (this.requireRedis) throw new Error("Redis visual entitlement unavailable");
      return {
        status: "authorized_pending",
        reservationId: randomUUID(),
        remainingSeconds: dailyLimitSeconds - input.durationSeconds,
        dailyLimitSeconds
      };
    }
    const learner = createHash("sha256").update(input.learnerId).digest("base64url");
    const session = createHash("sha256").update(input.sessionId).digest("base64url");
    const nowSeconds = Math.floor(Date.now() / 1_000);
    const now = new Date(nowSeconds * 1_000);
    const day = now.toISOString().slice(0, 10).replaceAll("-", "");
    const nextDay = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1) / 1_000;
    const dayTtl = Math.max(1, nextDay - nowSeconds);
    const reservationId = randomUUID();
    const result = await this.publisher.eval(
      `-- axiom-visual-entitlement-reserve
local used = tonumber(redis.call("GET", KEYS[3]) or "0")
local remaining = math.max(0, tonumber(ARGV[5]) - used)
local existing = redis.call("GET", KEYS[1])
if existing then
  local lease = cjson.decode(existing)
  if lease.learner ~= ARGV[1] or tonumber(lease.duration) ~= tonumber(ARGV[2]) then return {-1, "", remaining} end
  if lease.state == "pending" then return {3, lease.id, remaining} end
  return {-1, "", remaining}
end
redis.call("ZREMRANGEBYSCORE", KEYS[2], "-inf", ARGV[3])
if redis.call("ZCARD", KEYS[2]) >= tonumber(ARGV[4]) then return {-2, "", remaining} end
if used + tonumber(ARGV[2]) > tonumber(ARGV[5]) then return {-3, "", remaining} end
local globalUsed = tonumber(redis.call("GET", KEYS[4]) or "0")
if globalUsed + tonumber(ARGV[2]) > tonumber(ARGV[9]) then return {-4, "", remaining} end
local charged = redis.call("INCRBY", KEYS[3], ARGV[2])
if charged == tonumber(ARGV[2]) then redis.call("EXPIRE", KEYS[3], ARGV[6]) end
local globalCharged = redis.call("INCRBY", KEYS[4], ARGV[2])
if globalCharged == tonumber(ARGV[2]) then redis.call("EXPIRE", KEYS[4], ARGV[6]) end
local lease = cjson.encode({learner=ARGV[1], duration=tonumber(ARGV[2]), id=ARGV[7], state="pending"})
redis.call("SET", KEYS[1], lease, "EX", ARGV[8])
redis.call("ZADD", KEYS[2], tonumber(ARGV[3]) + tonumber(ARGV[8]), ARGV[7])
redis.call("EXPIRE", KEYS[2], ARGV[8])
return {1, ARGV[7], math.max(0, tonumber(ARGV[5]) - charged)}`,
      4,
      `axiom:visual:lease:${session}`,
      `axiom:visual:active:${learner}`,
      `axiom:visual:daily:${learner}:${day}`,
      `axiom:visual:daily:global:${day}`,
      learner,
      input.durationSeconds,
      nowSeconds,
      1,
      dailyLimitSeconds,
      dayTtl,
      reservationId,
      60,
      2_000
    );
    if (!Array.isArray(result) || result.length !== 3) throw new Error("Unexpected visual entitlement response");
    const status = Number(result[0]);
    const remainingSeconds = Math.max(0, Number(result[2]));
    if (status === 1 || status === 3) {
      return { status: "authorized_pending", reservationId: String(result[1]), remainingSeconds, dailyLimitSeconds };
    }
    const reason = status === -2 ? "concurrency_limit" : status === -3 ? "daily_limit" : status === -4 ? "global_limit" : "conflict";
    return { status: "denied", reason, remainingSeconds, dailyLimitSeconds };
  }

  async nextEventRevision(sessionId: string, currentRevision: number): Promise<number> {
    if (this.publisher?.status === "ready") {
      const revision = await this.publisher.incr(`axiom:session-revision:${sessionId}`);
      await this.publisher.expire(`axiom:session-revision:${sessionId}`, SESSION_STATE_TTL_SECONDS);
      return revision;
    }
    if (this.requireRedis) throw new Error("Redis revision allocation unavailable");
    const revision = Math.max(currentRevision, this.localRevisions.get(sessionId) ?? 0) + 1;
    this.localRevisions.set(sessionId, revision);
    return revision;
  }
  async readCommandRevision(sessionId: string, fallback = 0): Promise<number> {
    if (this.publisher?.status === "ready") {
      const raw = await this.publisher.get(`axiom:session:${sessionId}:revision`);
      const revision = raw === null ? fallback : Number(raw);
      return Number.isInteger(revision) && revision >= 0 ? revision : fallback;
    }
    if (this.requireRedis) throw new Error("Redis command revision unavailable");
    return this.localCommandRevisions.get(sessionId) ?? fallback;
  }


  async hydrateSessionState(sessionId: string): Promise<GatewaySessionState | undefined> {
    if (this.localTerminalSessions.has(sessionId)) return undefined;
    const stateKey = `axiom:session-state:${sessionId}`;
    const raw = this.publisher?.status === "ready"
      ? await this.publisher.get(stateKey)
      : this.localStates.get(sessionId);
    if (!raw) return undefined;
    try {
      const decoded = typeof raw === "string" && this.publisher
        ? decryptRetainedPayload(raw, this.encryptionKey!, `gateway-state|${sessionId}|${stateKey}`)
        : raw;
      const parsed = sessionStateSchema.safeParse(typeof decoded === "string" ? JSON.parse(decoded) : decoded);
      if (parsed.success) return parsed.data;
    } catch {}
    this.logger.write("warn", "Rejected invalid persisted session state", { provider: "redis", recoverable: true });
    return undefined;
  }

  async persistSessionState(sessionId: string, state: GatewaySessionState): Promise<void> {
    const parsed = sessionStateSchema.parse(state);
    if (this.publisher?.status === "ready") {

      const stateKey = `axiom:session-state:${sessionId}`;
      await this.publisher.eval(
        `-- axiom-gateway-persist-encrypted-state
if redis.call("EXISTS", KEYS[4]) == 1 then return -1 end
local current = tonumber(redis.call("GET", KEYS[2]) or "0")
if current > tonumber(ARGV[2]) then return 0 end
redis.call("SET", KEYS[1], ARGV[1], "EX", ARGV[4])
redis.call("SET", KEYS[2], ARGV[2], "EX", ARGV[4])
local commandRevision = tonumber(redis.call("GET", KEYS[3]) or "0")
if commandRevision < tonumber(ARGV[3]) then redis.call("SET", KEYS[3], ARGV[3], "EX", ARGV[4]) end
return 1`,
        4,
        stateKey,
        `axiom:session-revision:${sessionId}`,
        `axiom:session:${sessionId}:revision`,
        `axiom:session:${sessionId}:terminal`,
        encryptRetainedPayload(JSON.stringify(parsed), this.encryptionKey!, `gateway-state|${sessionId}|${stateKey}`),
        parsed.eventRevision,
        parsed.lastCommandRevision,
        SESSION_STATE_TTL_SECONDS
      );
      return;
    }
    if (this.localTerminalSessions.has(sessionId)) throw new Error("Session is terminal");
    if (this.requireRedis) throw new Error("Redis session state unavailable");
    const existing = this.localStates.get(sessionId);
    if (!existing || existing.eventRevision <= parsed.eventRevision) this.localStates.set(sessionId, parsed);
    this.localRevisions.set(sessionId, Math.max(parsed.eventRevision, this.localRevisions.get(sessionId) ?? 0));
    this.localCommandRevisions.set(sessionId, Math.max(parsed.lastCommandRevision, this.localCommandRevisions.get(sessionId) ?? 0));
  }
  async writeCardInteraction(eventId: string, input: GatewayCardInteraction): Promise<boolean> {
    try {
      await this.durableSink.writeCardInteraction(eventId, input);
      return true;
    } catch {
      this.databaseReady = false;
      this.logger.write("warn", "Durable card interaction write failed", { provider: "gateway", recoverable: true });
      return false;
    }
  }

  async writeVisualMetadata(eventId: string, input: GatewayVisualMetadata): Promise<boolean> {
    try {
      await this.durableSink.writeVisualMetadata(eventId, input);
      return true;
    } catch {
      this.databaseReady = false;
      this.logger.write("warn", "Durable visual metadata write failed", { provider: "gateway", recoverable: true });
      return false;
    }
  }

  async clearSessionState(sessionId: string): Promise<void> {
    this.localStates.delete(sessionId);
    this.localRevisions.delete(sessionId);
    this.localCommandRevisions.delete(sessionId);
    this.localTranscripts.delete(sessionId);
    if (this.publisher?.status === "ready") {
      await this.publisher.del(
        `axiom:session-state:${sessionId}`,
        `axiom:session-revision:${sessionId}`,
        `axiom:session-transcript:${sessionId}`,
      );
    }
  }

  async writeDurableEvent(
    kind: "learning_evidence" | "session_summary",
    eventId: string,
    sessionId: string,
    learnerId: string,
    payload: Readonly<Record<string, unknown>>
  ): Promise<boolean> {
    const envelope: GatewayDurableEnvelope = { version: 1, kind, eventId, sessionId, learnerId, payload };
    try {
      await this.writeEnvelope(envelope);
      return true;
    } catch {
      this.databaseReady = false;
      this.logger.write("warn", "Durable database write failed", { provider: "gateway", recoverable: true });
      if (this.publisher?.status !== "ready" || !this.encryptionKey) return false;
      try {
        const outboxKey = "axiom:gateway-durable-outbox";
        await this.publisher.rpush(
          outboxKey,
          encryptRetainedPayload(JSON.stringify(envelope), this.encryptionKey, `gateway-outbox|${outboxKey}`)
        );
        await this.publisher.expire("axiom:gateway-durable-outbox", 86_400);
        this.outboxHealthy = false;
        return true;
      } catch {
        this.outboxHealthy = false;
        return false;
      }
    }
  }

  async appendTranscript(
    sessionId: string,
    effectId: string,
    entry: Readonly<Record<string, unknown>>
  ): Promise<void> {
    if (!effectId || effectId.length > 500) throw new Error("Invalid transcript effect identifier");
    const serialized = JSON.stringify(entry);
    const effectHash = createHash("sha256").update(effectId).digest("base64url");
    const localEffectKey = `${sessionId}:${effectHash}`;
    if (this.publisher?.status === "ready") {
      const transcriptKey = `axiom:session-transcript:${sessionId}`;
      const appended = Number(await this.publisher.eval(
        `-- axiom-gateway-transcript-append-once-terminal-fenced
if redis.call("EXISTS", KEYS[2]) == 1 then return 0 end
if redis.call("EXISTS", KEYS[3]) == 1 then return 2 end
local length = redis.call("RPUSH", KEYS[1], ARGV[1])
if length == 1 then redis.call("EXPIRE", KEYS[1], ARGV[2]) end
redis.call("SET", KEYS[3], "1", "EX", ARGV[2])
return 1`,
        3,
        transcriptKey,
        `axiom:session:${sessionId}:terminal`,
        `axiom:session:${sessionId}:transcript-effect:${effectHash}`,
        encryptRetainedPayload(serialized, this.encryptionKey!, `gateway-transcript|${sessionId}|${transcriptKey}`),
        Math.min(this.activeTranscriptTtlSeconds, 86_400)
      ));
      if (appended === 0) throw new Error("Session is terminal");
      return;
    }
    if (this.localTerminalSessions.has(sessionId)) throw new Error("Session is terminal");
    if (this.requireRedis) throw new Error("Redis transcript recovery unavailable");
    if (this.localTranscriptEffects.has(localEffectKey)) return;
    const entries = this.localTranscripts.get(sessionId) ?? [];
    entries.push(serialized);
    this.localTranscripts.set(sessionId, entries);
    this.localTranscriptEffects.add(localEffectKey);
  }

  async hydrateTranscript(sessionId: string): Promise<Array<Readonly<Record<string, unknown>>>> {
    const transcriptKey = `axiom:session-transcript:${sessionId}`;
    const entries = this.publisher?.status === "ready"
      ? await this.publisher.lrange(transcriptKey, -20, -1)
      : this.localTranscripts.get(sessionId) ?? [];
    return entries.map((entry) => JSON.parse(
      this.publisher
        ? decryptRetainedPayload(String(entry), this.encryptionKey!, `gateway-transcript|${sessionId}|${transcriptKey}`)
        : String(entry)
    ) as Readonly<Record<string, unknown>>);
  }

  async loadLearnerContext(learnerId: string): Promise<GatewayLearnerContext> {
    return await this.durableSink.loadLearnerContext?.(learnerId)
      ?? { mastery: [], misconceptions: [], interests: [], recentSummaries: [], instructionLines: [] };
  }

  private async writeEnvelope(envelope: GatewayDurableEnvelope): Promise<void> {
    if (envelope.kind === "learning_evidence") {
      await this.durableSink.writeLearningEvidence(
        envelope.eventId,
        envelope.sessionId,
        envelope.learnerId,
        envelope.payload
      );
    } else {
      await this.durableSink.writeSessionSummary(
        envelope.eventId,
        envelope.sessionId,
        envelope.learnerId,
        envelope.payload
      );
    }
  }

  private async refreshReadiness(): Promise<void> {
    try {
      this.databaseReady = await this.durableSink.probeReadiness?.() ?? true;
    } catch {
      this.databaseReady = false;
    }
    if (this.publisher?.status === "ready") await this.drainDurableOutbox();
  }

  private async drainDurableOutbox(): Promise<void> {
    if (this.publisher?.status !== "ready" || !this.encryptionKey) return;
    const outboxKey = "axiom:gateway-durable-outbox";
    const deadLetterKey = "axiom:gateway-durable-dead-letter";
    let quarantined = false;
    try {
      const retained = await this.publisher.lrange(outboxKey, 0, -1);
      for (const encrypted of retained) {
        let envelope: GatewayDurableEnvelope;
        try {
          envelope = durableEnvelopeSchema.parse(JSON.parse(decryptRetainedPayload(
            String(encrypted),
            this.encryptionKey,
            `gateway-outbox|${outboxKey}`
          )));
        } catch {
          quarantined = true;
          await this.publisher.rpush(deadLetterKey, encrypted);
          await this.publisher.expire(deadLetterKey, 86_400);
          await this.publisher.lrem(outboxKey, 1, encrypted);
          this.logger.write("warn", "Quarantined invalid durable outbox entry", { provider: "gateway", recoverable: true });
          continue;
        }
        try {
          await this.writeEnvelope(envelope);
          await this.publisher.lrem(outboxKey, 1, encrypted);
        } catch {
          this.databaseReady = false;
        }
      }
      this.outboxHealthy = !quarantined && (await this.publisher.llen(outboxKey)) === 0;
    } catch {
      this.outboxHealthy = false;
    }
  }

  private deliver(sessionId: string, learnerId: string, event: SessionEvent): void {
    for (const subscriber of this.subscribers.get(sessionId) ?? []) {
      if (subscriber.learnerId === learnerId) subscriber.receive(event);
    }
  }

  async close(): Promise<void> {
    clearInterval(this.readinessTimer);
    await Promise.allSettled([this.receiver?.quit(), this.publisher?.quit()]);
  }
}
