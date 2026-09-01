export type ExplanationMode = "analogy" | "visual" | "mathematical" | "concise" | "stepwise";
export type LearningPace = "slower" | "steady" | "faster";
export type ChallengeLevel = "supportive" | "balanced" | "stretch";

export interface LearnerPreferences {
  readonly explanationMode?: ExplanationMode;
  readonly pace?: LearningPace;
  readonly challenge?: ChallengeLevel;
  readonly interests: readonly string[];
}

export interface PreferenceUpdate {
  readonly explanationMode?: ExplanationMode;
  readonly pace?: LearningPace;
  readonly challenge?: ChallengeLevel;
  readonly interests?: readonly string[];
}

export interface ConceptMastery { readonly concept: string; readonly confidence: number; readonly evidenceCount: number }
export interface Misconception { readonly concept: string; readonly description: string; readonly evidenceCount: number }
export interface ExplorationEdge { readonly from: string; readonly to: string }
export interface SessionSummary {
  readonly sessionId: string;
  readonly summary: string;
  readonly concepts: readonly string[];
  readonly explorationEdges: readonly ExplorationEdge[];
  readonly completedAt: Date;
}
export interface LearningEvidence {
  readonly concept: string;
  readonly evidence: string;
  readonly confidenceDelta: number;
  readonly misconception?: string | null;
  readonly preferenceSignals?: PreferenceUpdate;
}
export interface LearnerProfile {
  readonly learnerId: string;
  readonly mastery: readonly ConceptMastery[];
  readonly misconceptions: readonly Misconception[];
  readonly preferences: LearnerPreferences;
  readonly recentSummaries: readonly SessionSummary[];
}

export interface LearningMemory {
  load(learnerId: string): Promise<LearnerProfile>;
  recordEvidence(learnerId: string, evidence: LearningEvidence): Promise<LearnerProfile>;
  recordSessionSummary(learnerId: string, summary: SessionSummary): Promise<void>;
}

const MAX_MASTERY = 50;
const MAX_MISCONCEPTIONS = 20;
const MAX_INTERESTS = 8;
const MAX_SUMMARIES = 8;
const MAX_EDGES_PER_SUMMARY = 24;

export class InMemoryLearningMemory implements LearningMemory {
  private readonly profiles = new Map<string, LearnerProfile>();

  async load(learnerId: string): Promise<LearnerProfile> {
    if (!learnerId) throw new Error("learnerId is required");
    return this.profiles.get(learnerId) ?? emptyProfile(learnerId);
  }

  async recordEvidence(learnerId: string, evidence: LearningEvidence): Promise<LearnerProfile> {
    validateEvidence(evidence);
    const profile = await this.load(learnerId);
    const concept = normalize(evidence.concept);
    const masteryIndex = profile.mastery.findIndex((item) => item.concept.toLocaleLowerCase() === concept.toLocaleLowerCase());
    const previous = masteryIndex >= 0 ? profile.mastery[masteryIndex]! : undefined;
    const updatedMastery: ConceptMastery = Object.freeze({
      concept: previous?.concept ?? concept,
      confidence: clamp((previous?.confidence ?? 0.5) + evidence.confidenceDelta, 0, 1),
      evidenceCount: (previous?.evidenceCount ?? 0) + 1
    });
    const mastery = replaceOrAppend(profile.mastery, masteryIndex, updatedMastery, MAX_MASTERY);
    const misconceptions = updateMisconceptions(profile.misconceptions, previous?.concept ?? concept, evidence.misconception);
    const preferences = mergePreferences(profile.preferences, evidence.preferenceSignals);
    const updated = freezeProfile({ ...profile, mastery, misconceptions, preferences });
    this.profiles.set(learnerId, updated);
    return updated;
  }

  async recordSessionSummary(learnerId: string, summary: SessionSummary): Promise<void> {
    validateSummary(summary);
    const profile = await this.load(learnerId);
    const compact: SessionSummary = Object.freeze({
      sessionId: normalize(summary.sessionId),
      summary: normalize(summary.summary).slice(0, 2_000),
      concepts: Object.freeze(uniqueNormalized(summary.concepts, 20)),
      explorationEdges: Object.freeze(summary.explorationEdges.slice(0, MAX_EDGES_PER_SUMMARY).map((edge) => Object.freeze({ from: normalize(edge.from), to: normalize(edge.to) }))),
      completedAt: new Date(summary.completedAt.getTime())
    });
    const summaries = Object.freeze([...profile.recentSummaries.filter((item) => item.sessionId !== compact.sessionId), compact].slice(-MAX_SUMMARIES));
    this.profiles.set(learnerId, freezeProfile({ ...profile, recentSummaries: summaries }));
  }
}

function emptyProfile(learnerId: string): LearnerProfile {
  return freezeProfile({ learnerId, mastery: [], misconceptions: [], preferences: { interests: [] }, recentSummaries: [] });
}

function updateMisconceptions(current: readonly Misconception[], concept: string, misconception?: string | null): readonly Misconception[] {
  if (!misconception?.trim()) return current;
  const description = normalize(misconception);
  const index = current.findIndex((item) => item.concept.toLocaleLowerCase() === concept.toLocaleLowerCase() && item.description.toLocaleLowerCase() === description.toLocaleLowerCase());
  const item = Object.freeze({
    concept,
    description: index >= 0 ? current[index]!.description : description,
    evidenceCount: (index >= 0 ? current[index]!.evidenceCount : 0) + 1
  });
  return Object.freeze(replaceOrAppend(current, index, item, MAX_MISCONCEPTIONS));
}

function mergePreferences(current: LearnerPreferences, update?: PreferenceUpdate): LearnerPreferences {
  if (!update) return current;
  const interests = update.interests ? uniqueNormalized([...current.interests, ...update.interests], MAX_INTERESTS) : current.interests;
  return Object.freeze({
    ...(current.explanationMode ? { explanationMode: current.explanationMode } : {}),
    ...(current.pace ? { pace: current.pace } : {}),
    ...(current.challenge ? { challenge: current.challenge } : {}),
    ...update,
    interests: Object.freeze(interests)
  });
}

function replaceOrAppend<T>(items: readonly T[], index: number, value: T, maximum: number): readonly T[] {
  if (index >= 0) {
    const result = [...items];
    result[index] = value;
    return Object.freeze(result);
  }
  return Object.freeze([...items, value].slice(-maximum));
}

function uniqueNormalized(values: readonly string[], maximum: number): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const raw of values) {
    const value = normalize(raw);
    const key = value.toLocaleLowerCase();
    if (value && !seen.has(key)) { seen.add(key); result.push(value); }
    if (result.length === maximum) break;
  }
  return result;
}

function validateEvidence(evidence: LearningEvidence): void {
  if (!normalize(evidence.concept) || !normalize(evidence.evidence)) throw new Error("Evidence concept and description are required");
  if (!Number.isFinite(evidence.confidenceDelta) || evidence.confidenceDelta < -1 || evidence.confidenceDelta > 1) throw new Error("confidenceDelta must be between -1 and 1");
}

function validateSummary(summary: SessionSummary): void {
  if (!normalize(summary.sessionId) || !normalize(summary.summary)) throw new Error("Session id and summary are required");
  if (Number.isNaN(summary.completedAt.getTime())) throw new Error("completedAt must be valid");
}

function freezeProfile(profile: LearnerProfile): LearnerProfile {
  return Object.freeze({
    ...profile,
    mastery: Object.freeze([...profile.mastery]),
    misconceptions: Object.freeze([...profile.misconceptions]),
    preferences: Object.freeze({ ...profile.preferences, interests: Object.freeze([...profile.preferences.interests]) }),
    recentSummaries: Object.freeze([...profile.recentSummaries])
  });
}
function normalize(value: string): string { return value.trim().replace(/\s+/g, " "); }
function clamp(value: number, minimum: number, maximum: number): number { return Math.min(maximum, Math.max(minimum, value)); }
