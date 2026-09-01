export const disciplines = [
  "physics",
  "chemistry",
  "biology",
  "astronomy",
  "earth-science",
  "environmental-science"
] as const;

export type Discipline = (typeof disciplines)[number];
export type EvaluationDimension = "factual" | "teaching" | "safety";
export type PromptKind = "canonical-misconception" | "adversarial" | "dangerous-experiment";

export interface TextRule {
  readonly allOf?: readonly string[];
  readonly anyOf?: readonly string[];
  readonly noneOf?: readonly string[];
}

export interface ExpectedInvariant {
  readonly id: string;
  readonly dimension: EvaluationDimension;
  readonly description: string;
  /** Case-insensitive regular expressions evaluated against normalized response text. */
  readonly rule: TextRule;
}

export interface ScienceEvalFixture {
  readonly id: string;
  readonly discipline: Discipline;
  readonly kind: PromptKind;
  readonly prompt: string;
  readonly misconception?: string;
  readonly expectedInvariants: readonly ExpectedInvariant[];
}

export interface EvaluationCandidate {
  readonly fixtureId: string;
  readonly response: string;
  /** Optional product metric. It is reported but never used to determine correctness. */
  readonly engagementScore?: number;
}

export interface InvariantResult {
  readonly id: string;
  readonly dimension: EvaluationDimension;
  readonly description: string;
  readonly passed: boolean;
}

export interface DimensionScore {
  readonly passed: number;
  readonly total: number;
  readonly score: number;
  readonly threshold: number;
  readonly passedGate: boolean;
}

export interface FixtureEvaluation {
  readonly fixtureId: string;
  readonly discipline: Discipline;
  readonly kind: PromptKind;
  readonly status: "pass" | "fail";
  readonly factual: DimensionScore;
  readonly teaching: DimensionScore;
  readonly safety: DimensionScore;
  readonly engagementScore?: number;
  readonly invariants: readonly InvariantResult[];
}

export interface SuiteSummary {
  readonly total: number;
  readonly passed: number;
  readonly failed: number;
  readonly factualFailures: number;
  readonly teachingFailures: number;
  readonly safetyFailures: number;
  readonly meanEngagement?: number;
}

export interface SuiteEvaluation {
  readonly generatedBy: "deterministic-local-science-eval";
  readonly retrievalUsed: false;
  readonly citationsUsed: false;
  readonly results: readonly FixtureEvaluation[];
  readonly summary: SuiteSummary;
}

export interface EvaluationThresholds {
  readonly factual: number;
  readonly teaching: number;
  readonly safety: number;
}
