import type {
  LearnerPreferences,
  LearnerProfile,
  LearningEvidence,
  LearningMemory,
  SessionSummary,
} from "@axiom/domain";

export type { LearnerPreferences, LearnerProfile, LearningEvidence, LearningMemory, SessionSummary };

export type AgeBand = "13-15" | "16-18";
export type ExplanationMode = "analogy" | "visual" | "mathematical" | "concise" | "stepwise";
export type Pace = "slower" | "steady" | "faster";
export type ChallengeLevel = "supportive" | "balanced" | "stretch";

export interface ProfileInput {
  learnerId: string;
  displayName?: string;
  ageBand: AgeBand;
  ageBandConfirmedAt: Date;
}

export interface StoredProfile extends ProfileInput {
  createdAt: Date;
  updatedAt: Date;
}

export interface PreferenceInput {
  learnerId: string;
  explanationMode?: ExplanationMode;
  pace?: Pace;
  challenge?: ChallengeLevel;
}

export interface SessionSummaryInput {
  sessionId: string;
  userId: string;
  summary: string;
  concepts: readonly string[];
  explorationEdges?: readonly ExplorationEdgeInput[];
  startedAt: Date;
  endedAt: Date;
}

export interface ExplorationEdgeInput {
  from: string;
  to: string;
  relation?: string;
}

export interface CardInteractionInput {
  sessionId: string;
  learnerId: string;
  cardId: string;
  purpose: "branch" | "predict" | "compare" | "sequence" | "check";
  action: "shown" | "selected" | "dismissed";
  concept?: string;
  occurredAt: Date;
}

export interface VisualMetadataInput {
  sessionId: string;
  learnerId?: string;
  visualId: string;
  concept: string;
  durationSeconds: 5 | 10 | 15;
  resolution: "480p" | "768p";
  outcome: "completed" | "interrupted" | "rejected" | "failed";
  promptVersion: number;
  latencyMs?: number;
  createdAt: Date;
}
export type StoredCardInteraction = CardInteractionInput;

export type StoredVisualMetadata = VisualMetadataInput;

export interface HydratedLearningContext extends LearnerProfile {
  readonly recentCardInteractions: readonly StoredCardInteraction[];
  readonly recentVisualMetadata: readonly StoredVisualMetadata[];
}

export const LEARNING_CONTEXT_LIMITS = Object.freeze({
  mastery: 50,
  misconceptions: 20,
  interests: 8,
  sessionSummaries: 8,
  explorationEdgesPerSummary: 24,
  cardInteractions: 50,
  visualMetadata: 20,
});

export interface OperationalMetricInput {
  sessionId?: string;
  learnerId?: string;
  name: string;
  value: number;
  unit: "count" | "milliseconds" | "seconds" | "bytes" | "ratio";
  dimensions?: Readonly<Record<string, string | number | boolean>>;
  recordedAt: Date;
}

export function assertOperationalMetricSafe(input: OperationalMetricInput): void {
  if (!input.name.trim() || input.name.length > 120) throw new Error("Metric name must be between 1 and 120 characters");
  if (!Number.isFinite(input.value)) throw new Error("Metric value must be finite");
  if (Number.isNaN(input.recordedAt.getTime())) throw new Error("Metric timestamp must be valid");
  const dimensions = input.dimensions ?? {};
  for (const key of Object.keys(dimensions)) {
    if (/prompt|secret|token|api.?key|transcript|(?:audio|video)(?:data|payload|bytes|url|uri|file)/i.test(key)) {
      throw new Error(`Sensitive metric dimension is not allowed: ${key}`);
    }
  }
  if (Buffer.byteLength(JSON.stringify(dimensions), "utf8") > 4_096) {
    throw new Error("Metric dimensions exceed 4096 bytes");
  }
}

export interface LearningRepository extends LearningMemory {
  load(learnerId: string): Promise<HydratedLearningContext>;
  loadLearningContext(learnerId: string): Promise<HydratedLearningContext>;
  recordEvidence(learnerId: string, evidence: LearningEvidence, operationId?: string): Promise<HydratedLearningContext>;
  upsertProfile(input: ProfileInput): Promise<void>;
  getProfile(learnerId: string): Promise<StoredProfile | null>;
  updatePreferences(input: PreferenceInput): Promise<void>;
  addInterest(learnerId: string, topic: string, weight?: number): Promise<void>;
  saveCompactSessionSummary(input: SessionSummaryInput): Promise<void>;
  recordExplorationEdges(sessionId: string, edges: readonly ExplorationEdgeInput[]): Promise<void>;
  recordCardInteraction(input: CardInteractionInput, operationId?: string): Promise<void>;
  recordVisualMetadata(input: VisualMetadataInput): Promise<void>;
  recordOperationalMetric(input: OperationalMetricInput): Promise<void>;
}

export type TranscriptRole = "learner" | "assistant";

export interface TranscriptEntry {
  turnId: string;
  role: TranscriptRole;
  text: string;
  finalized: boolean;
  interrupted?: boolean;
  recordedAt: string;
}

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type ActiveSessionState = { revision: number; status: string; [key: string]: JsonValue };

export interface RateLimitPolicy {
  limit: number;
  windowSeconds: number;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAfterSeconds: number;
}
