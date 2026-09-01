import { randomUUID } from "node:crypto";
import type {
  LearnerProfile,
  LearningEvidence,
  SessionSummary,
} from "@axiom/domain";
import { assertOperationalMetricSafe, LEARNING_CONTEXT_LIMITS } from "./types";
import type {
  AgeBand,
  CardInteractionInput,
  ExplorationEdgeInput,
  HydratedLearningContext,
  LearningRepository,
  OperationalMetricInput,
  PreferenceInput,
  ProfileInput,
  SessionSummaryInput,
  StoredProfile,
  VisualMetadataInput,
} from "./types";

export interface SqlExecutor {
  query<Row extends Record<string, unknown>>(text: string, parameters: readonly unknown[]): Promise<readonly Row[]>;
}

interface ProfileRow extends Record<string, unknown> {
  learner_id: string;
  display_name: string | null;
  age_band: AgeBand;
  age_band_confirmed_at: Date | string;
  created_at: Date | string;
  updated_at: Date | string;
}

interface MasteryRow extends Record<string, unknown> {
  concept: string;
  confidence: number | string;
  evidence_count: number | string;
}
interface MisconceptionRow extends Record<string, unknown> {
  concept: string;
  description: string;
  evidence_count: number | string;
}
interface PreferencesRow extends Record<string, unknown> {
  explanation_mode: LearnerProfile["preferences"]["explanationMode"] | null;
  pace: LearnerProfile["preferences"]["pace"] | null;
  challenge: LearnerProfile["preferences"]["challenge"] | null;
}
interface InterestRow extends Record<string, unknown> { topic: string }
interface SummaryRow extends Record<string, unknown> {
  session_id: string;
  summary: string;
  concepts: string[];
  completed_at: Date | string;
  exploration_edges: Array<{ from: string; to: string }> | null;
}
interface CardInteractionRow extends Record<string, unknown> {
  session_id: string;
  learner_id: string;
  card_id: string;
  purpose: CardInteractionInput["purpose"];
  action: CardInteractionInput["action"];
  concept: string | null;
  occurred_at: Date | string;
}
interface VisualMetadataRow extends Record<string, unknown> {
  session_id: string;
  learner_id: string | null;
  visual_id: string;
  concept: string;
  duration_seconds: VisualMetadataInput["durationSeconds"];
  resolution: VisualMetadataInput["resolution"];
  outcome: VisualMetadataInput["outcome"];
  prompt_version: number;
  latency_ms: number | null;
  created_at: Date | string;
}
function boundedExplorationEdges(edges: readonly ExplorationEdgeInput[] | undefined): ExplorationEdgeInput[] {
  const unique = new Map<string, ExplorationEdgeInput>();
  for (const edge of edges ?? []) {
    const from = edge.from.trim().toLocaleLowerCase();
    const to = edge.to.trim().toLocaleLowerCase();
    unique.set(`${from.toLocaleLowerCase()}\u0000${to.toLocaleLowerCase()}`, {
      from,
      to,
      ...(edge.relation?.trim() ? { relation: edge.relation.trim() } : {}),
    });
  }
  return [...unique.values()].slice(0, LEARNING_CONTEXT_LIMITS.explorationEdgesPerSummary);
}

export class PostgresLearningRepository implements LearningRepository {
  constructor(private readonly sql: SqlExecutor) {}

  async load(learnerId: string): Promise<HydratedLearningContext> {
    return this.loadLearningContext(learnerId);
  }

  async loadLearningContext(learnerId: string): Promise<HydratedLearningContext> {
    const [masteryRows, misconceptionRows, preferenceRows, interestRows, summaryRows, cardRows, visualRows] = await Promise.all([
      this.sql.query<MasteryRow>(
        "SELECT concept, confidence, evidence_count FROM concept_mastery WHERE learner_id = $1 ORDER BY updated_at DESC, concept LIMIT $2",
        [learnerId, LEARNING_CONTEXT_LIMITS.mastery],
      ),
      this.sql.query<MisconceptionRow>(
        "SELECT concept, description, evidence_count FROM misconceptions WHERE learner_id = $1 ORDER BY updated_at DESC, concept LIMIT $2",
        [learnerId, LEARNING_CONTEXT_LIMITS.misconceptions],
      ),
      this.sql.query<PreferencesRow>(
        "SELECT explanation_mode, pace, challenge FROM learner_preferences WHERE learner_id = $1",
        [learnerId],
      ),
      this.sql.query<InterestRow>(
        "SELECT topic FROM topic_interests WHERE learner_id = $1 ORDER BY weight DESC, updated_at DESC, topic LIMIT $2",
        [learnerId, LEARNING_CONTEXT_LIMITS.interests],
      ),
      this.sql.query<SummaryRow>(
        `SELECT s.session_id, s.summary, s.concepts, s.completed_at,
          COALESCE(jsonb_agg(jsonb_build_object('from', e.from_concept, 'to', e.to_concept) ORDER BY e.id)
            FILTER (WHERE e.id IS NOT NULL), '[]'::jsonb) AS exploration_edges
         FROM session_summaries s
         LEFT JOIN exploration_edges e ON e.session_id = s.session_id
         WHERE s.learner_id = $1
         GROUP BY s.session_id
         ORDER BY s.completed_at DESC
         LIMIT $2`,
        [learnerId, LEARNING_CONTEXT_LIMITS.sessionSummaries],
      ),
      this.sql.query<CardInteractionRow>(
        `SELECT session_id, learner_id, card_id, purpose, action, concept, occurred_at
         FROM card_interactions WHERE learner_id = $1 ORDER BY occurred_at DESC, id DESC LIMIT $2`,
        [learnerId, LEARNING_CONTEXT_LIMITS.cardInteractions],
      ),
      this.sql.query<VisualMetadataRow>(
        `SELECT session_id, learner_id, visual_id, concept, duration_seconds, resolution,
                outcome, prompt_version, latency_ms, created_at
         FROM visual_metadata WHERE learner_id = $1 ORDER BY created_at DESC, visual_id DESC LIMIT $2`,
        [learnerId, LEARNING_CONTEXT_LIMITS.visualMetadata],
      ),
    ]);
    const preferences = preferenceRows[0];
    return {
      learnerId,
      mastery: masteryRows.map((row) => ({
        concept: row.concept,
        confidence: Number(row.confidence),
        evidenceCount: Number(row.evidence_count),
      })),
      misconceptions: misconceptionRows.map((row) => ({
        concept: row.concept,
        description: row.description,
        evidenceCount: Number(row.evidence_count),
      })),
      preferences: {
        ...(preferences?.explanation_mode ? { explanationMode: preferences.explanation_mode } : {}),
        ...(preferences?.pace ? { pace: preferences.pace } : {}),
        ...(preferences?.challenge ? { challenge: preferences.challenge } : {}),
        interests: interestRows.map((row) => row.topic),
      },
      recentSummaries: summaryRows.map((row) => ({
        sessionId: row.session_id,
        summary: row.summary,
        concepts: row.concepts,
        explorationEdges: (row.exploration_edges ?? []).slice(0, LEARNING_CONTEXT_LIMITS.explorationEdgesPerSummary),
        completedAt: new Date(row.completed_at),
      })),
      recentCardInteractions: cardRows.map((row) => ({
        sessionId: row.session_id,
        learnerId: row.learner_id,
        cardId: row.card_id,
        purpose: row.purpose,
        action: row.action,
        ...(row.concept ? { concept: row.concept } : {}),
        occurredAt: new Date(row.occurred_at),
      })),
      recentVisualMetadata: visualRows.map((row) => ({
        sessionId: row.session_id,
        ...(row.learner_id ? { learnerId: row.learner_id } : {}),
        visualId: row.visual_id,
        concept: row.concept,
        durationSeconds: row.duration_seconds,
        resolution: row.resolution,
        outcome: row.outcome,
        promptVersion: row.prompt_version,
        ...(row.latency_ms === null ? {} : { latencyMs: row.latency_ms }),
        createdAt: new Date(row.created_at),
      })),
    };
  }

  async recordEvidence(learnerId: string, evidence: LearningEvidence, operationId = randomUUID()): Promise<HydratedLearningContext> {
    const signals = evidence.preferenceSignals;
    const concept = evidence.concept.trim().toLocaleLowerCase();
    if (!concept) throw new Error("Evidence concept is required");
    const misconception = evidence.misconception?.trim().toLocaleLowerCase() || null;
    const interestSignals = [...new Map(
      (signals?.interests ?? [])
        .map((topic) => topic.trim())
        .filter(Boolean)
        .map((topic) => [topic.toLocaleLowerCase(), topic.toLocaleLowerCase()]),
    ).values()].slice(0, LEARNING_CONTEXT_LIMITS.interests);
    await this.sql.query(
      `WITH claimed AS (
         INSERT INTO session_mutation_effects (effect_id) VALUES ($1)
         ON CONFLICT (effect_id) DO NOTHING
         RETURNING effect_id
       ), mastery AS (
         INSERT INTO concept_mastery (learner_id, concept, confidence, evidence_count, last_evidence)
         SELECT $2, $3, LEAST(1, GREATEST(0, 0.5 + $4::double precision)), 1, $5 FROM claimed
         ON CONFLICT (learner_id, concept) DO UPDATE SET
           confidence = LEAST(1, GREATEST(0, concept_mastery.confidence + $4::double precision)),
           evidence_count = concept_mastery.evidence_count + 1,
           last_evidence = $5,
           updated_at = now()
       ), misconception AS (
         INSERT INTO misconceptions (learner_id, concept, description)
         SELECT $2, $3, $6 FROM claimed WHERE $6::text IS NOT NULL
         ON CONFLICT (learner_id, concept, description) DO UPDATE SET
           evidence_count = misconceptions.evidence_count + 1,
           updated_at = now()
       ), preferences AS (
         INSERT INTO learner_preferences (learner_id, explanation_mode, pace, challenge)
         SELECT $2, $7, $8, $9 FROM claimed
         ON CONFLICT (learner_id) DO UPDATE SET
           explanation_mode = COALESCE(EXCLUDED.explanation_mode, learner_preferences.explanation_mode),
           pace = COALESCE(EXCLUDED.pace, learner_preferences.pace),
           challenge = COALESCE(EXCLUDED.challenge, learner_preferences.challenge),
           updated_at = now()
       )
       INSERT INTO topic_interests (learner_id, topic)
       SELECT $2, topic FROM claimed, unnest($10::text[]) AS topic
       ON CONFLICT (learner_id, topic) DO UPDATE SET weight = topic_interests.weight + 1, updated_at = now()`,
      [
        operationId,
        learnerId,
        concept,
        evidence.confidenceDelta,
        evidence.evidence,
        misconception,
        signals?.explanationMode ?? null,
        signals?.pace ?? null,
        signals?.challenge ?? null,
        interestSignals,
      ],
    );
    await this.sql.query(
      `WITH trim_mastery AS (
         DELETE FROM concept_mastery
         WHERE (learner_id, concept) IN (
           SELECT learner_id, concept FROM concept_mastery
           WHERE learner_id = $1 ORDER BY updated_at DESC, concept OFFSET $2
         )
       ), trim_misconceptions AS (
         DELETE FROM misconceptions
         WHERE (learner_id, concept, description) IN (
           SELECT learner_id, concept, description FROM misconceptions
           WHERE learner_id = $1 ORDER BY updated_at DESC, concept, description OFFSET $3
         )
       )
       DELETE FROM topic_interests
       WHERE (learner_id, topic) IN (
         SELECT learner_id, topic FROM topic_interests
         WHERE learner_id = $1 ORDER BY weight DESC, updated_at DESC, topic OFFSET $4
       )`,
      [
        learnerId,
        LEARNING_CONTEXT_LIMITS.mastery,
        LEARNING_CONTEXT_LIMITS.misconceptions,
        LEARNING_CONTEXT_LIMITS.interests,
      ],
    );
    return this.load(learnerId);
  }

  async recordSessionSummary(learnerId: string, summary: SessionSummary): Promise<void> {
    await this.saveSummary({
      sessionId: summary.sessionId,
      userId: learnerId,
      summary: summary.summary,
      concepts: summary.concepts,
      explorationEdges: summary.explorationEdges,
      startedAt: summary.completedAt,
      endedAt: summary.completedAt,
    });
  }

  async upsertProfile(input: ProfileInput): Promise<void> {
    await this.sql.query(
      `INSERT INTO learner_profiles (learner_id, display_name, age_band, age_band_confirmed_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (learner_id) DO UPDATE SET
         display_name = EXCLUDED.display_name,
         age_band = EXCLUDED.age_band,
         age_band_confirmed_at = EXCLUDED.age_band_confirmed_at,
         updated_at = now()`,
      [input.learnerId, input.displayName ?? null, input.ageBand, input.ageBandConfirmedAt],
    );
  }

  async getProfile(learnerId: string): Promise<StoredProfile | null> {
    const rows = await this.sql.query<ProfileRow>(
      `SELECT learner_id, display_name, age_band, age_band_confirmed_at, created_at, updated_at
       FROM learner_profiles WHERE learner_id = $1`,
      [learnerId],
    );
    const row = rows[0];
    if (!row) return null;
    return {
      learnerId: row.learner_id,
      ...(row.display_name ? { displayName: row.display_name } : {}),
      ageBand: row.age_band,
      ageBandConfirmedAt: new Date(row.age_band_confirmed_at),
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    };
  }

  async updatePreferences(input: PreferenceInput): Promise<void> {
    await this.sql.query(
      `INSERT INTO learner_preferences (learner_id, explanation_mode, pace, challenge)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (learner_id) DO UPDATE SET
         explanation_mode = COALESCE(EXCLUDED.explanation_mode, learner_preferences.explanation_mode),
         pace = COALESCE(EXCLUDED.pace, learner_preferences.pace),
         challenge = COALESCE(EXCLUDED.challenge, learner_preferences.challenge),
         updated_at = now()`,
      [input.learnerId, input.explanationMode ?? null, input.pace ?? null, input.challenge ?? null],
    );
  }

  async addInterest(learnerId: string, topic: string, weight = 1): Promise<void> {
    const normalized = topic.trim().toLocaleLowerCase();
    if (!normalized) throw new Error("Interest topic is required");
    await this.sql.query(
      `INSERT INTO topic_interests (learner_id, topic, weight) VALUES ($1, $2, $3)
       ON CONFLICT (learner_id, topic) DO UPDATE SET weight = topic_interests.weight + $3, updated_at = now()`,
      [learnerId, normalized, weight],
    );
    await this.sql.query(
      `DELETE FROM topic_interests WHERE (learner_id, topic) IN (
         SELECT learner_id, topic FROM topic_interests
         WHERE learner_id = $1 ORDER BY weight DESC, updated_at DESC, topic OFFSET $2
       )`,
      [learnerId, LEARNING_CONTEXT_LIMITS.interests],
    );
  }

  async saveCompactSessionSummary(input: SessionSummaryInput): Promise<void> {
    await this.saveSummary(input);
  }

  async recordExplorationEdges(sessionId: string, edges: readonly ExplorationEdgeInput[]): Promise<void> {
    const retained = boundedExplorationEdges(edges);
    await this.sql.query(
      `INSERT INTO exploration_edges (session_id, from_concept, to_concept, relation)
       SELECT $1, edge->>'from', edge->>'to', edge->>'relation'
       FROM jsonb_array_elements($2::jsonb) AS edge
       ON CONFLICT (session_id, from_concept, to_concept) DO UPDATE SET relation = EXCLUDED.relation`,
      [sessionId, JSON.stringify(retained)],
    );
    await this.sql.query(
      `DELETE FROM exploration_edges WHERE id IN (
         SELECT id FROM exploration_edges WHERE session_id = $1
         ORDER BY created_at DESC, id DESC OFFSET $2
       )`,
      [sessionId, LEARNING_CONTEXT_LIMITS.explorationEdgesPerSummary],
    );
  }

  async recordCardInteraction(input: CardInteractionInput, operationId = randomUUID()): Promise<void> {
    await this.sql.query(
      `WITH claimed AS (
         INSERT INTO session_mutation_effects (effect_id) VALUES ($1)
         ON CONFLICT (effect_id) DO NOTHING
         RETURNING effect_id
       )
       INSERT INTO card_interactions
       (session_id, learner_id, card_id, purpose, action, concept, occurred_at)
       SELECT $2, $3, $4, $5, $6, $7, $8 FROM claimed`,
      [operationId, input.sessionId, input.learnerId, input.cardId, input.purpose, input.action, input.concept ?? null, input.occurredAt],
    );
    await this.sql.query(
      `DELETE FROM card_interactions WHERE id IN (
         SELECT id FROM card_interactions WHERE learner_id = $1
         ORDER BY occurred_at DESC, id DESC OFFSET $2
       )`,
      [input.learnerId, LEARNING_CONTEXT_LIMITS.cardInteractions],
    );
  }

  async recordVisualMetadata(input: VisualMetadataInput): Promise<void> {
    await this.sql.query(
      `INSERT INTO visual_metadata
       (visual_id, session_id, learner_id, concept, duration_seconds, resolution, outcome, prompt_version, latency_ms, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (visual_id) DO UPDATE SET outcome = EXCLUDED.outcome, latency_ms = EXCLUDED.latency_ms`,
      [input.visualId, input.sessionId, input.learnerId ?? null, input.concept, input.durationSeconds, input.resolution, input.outcome, input.promptVersion, input.latencyMs ?? null, input.createdAt],
    );
    if (input.learnerId) {
      await this.sql.query(
        `DELETE FROM visual_metadata WHERE visual_id IN (
           SELECT visual_id FROM visual_metadata WHERE learner_id = $1
           ORDER BY created_at DESC, visual_id DESC OFFSET $2
         )`,
        [input.learnerId, LEARNING_CONTEXT_LIMITS.visualMetadata],
      );
    }
  }

  async recordOperationalMetric(input: OperationalMetricInput): Promise<void> {
    assertOperationalMetricSafe(input);
    await this.sql.query(
      `INSERT INTO operational_metrics
       (session_id, learner_id, name, value, unit, dimensions, recorded_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
      [input.sessionId ?? null, input.learnerId ?? null, input.name, input.value, input.unit, JSON.stringify(input.dimensions ?? {}), input.recordedAt],
    );
  }

  private async saveSummary(input: SessionSummaryInput): Promise<void> {
    const compactSummary = input.summary.trim().slice(0, 2_000);
    if (!compactSummary) throw new Error("Session summary is required");
    const concepts = [...new Set(
      input.concepts.map((concept) => concept.trim().toLocaleLowerCase()).filter(Boolean),
    )].slice(0, 20);
    const edges = boundedExplorationEdges(input.explorationEdges);
    await this.sql.query(
      `WITH summary AS (
         INSERT INTO session_summaries (session_id, learner_id, summary, concepts, started_at, completed_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (session_id) DO UPDATE SET
           summary = EXCLUDED.summary, concepts = EXCLUDED.concepts,
           started_at = EXCLUDED.started_at, completed_at = EXCLUDED.completed_at
         RETURNING session_id
       )
       INSERT INTO exploration_edges (session_id, from_concept, to_concept, relation)
       SELECT summary.session_id, edge->>'from', edge->>'to', edge->>'relation'
       FROM summary CROSS JOIN jsonb_array_elements($7::jsonb) AS edge
       ON CONFLICT (session_id, from_concept, to_concept) DO UPDATE SET relation = EXCLUDED.relation`,
      [input.sessionId, input.userId, compactSummary, concepts, input.startedAt, input.endedAt, JSON.stringify(edges)],
    );
    await this.sql.query(
      `WITH trimmed_edges AS (
         DELETE FROM exploration_edges WHERE id IN (
           SELECT id FROM exploration_edges WHERE session_id = $1
           ORDER BY created_at DESC, id DESC OFFSET $3
         )
       )
       DELETE FROM session_summaries WHERE session_id IN (
         SELECT session_id FROM session_summaries WHERE learner_id = $2
         ORDER BY completed_at DESC, session_id DESC OFFSET $4
       )`,
      [input.sessionId, input.userId, LEARNING_CONTEXT_LIMITS.explorationEdgesPerSummary, LEARNING_CONTEXT_LIMITS.sessionSummaries],
    );
  }
}
