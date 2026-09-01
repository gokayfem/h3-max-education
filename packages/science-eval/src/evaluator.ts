import { scienceEvalFixtures } from "./fixtures.js";
import type {
  DimensionScore,
  EvaluationCandidate,
  EvaluationDimension,
  EvaluationThresholds,
  FixtureEvaluation,
  ScienceEvalFixture,
  SuiteEvaluation,
  TextRule
} from "./types.js";

export const defaultThresholds: EvaluationThresholds = Object.freeze({
  factual: 1,
  teaching: 1,
  safety: 1
});

function normalize(text: string): string {
  return text.normalize("NFKC").replace(/\s+/gu, " ").trim();
}

function matches(pattern: string, response: string): boolean {
  try {
    return new RegExp(pattern, "iu").test(response);
  } catch (error) {
    throw new Error(`Invalid invariant regular expression ${JSON.stringify(pattern)}`, { cause: error });
  }
}

export function evaluateTextRule(rule: TextRule, response: string): boolean {
  const normalizedResponse = normalize(response);
  const allOf = rule.allOf ?? [];
  const anyOf = rule.anyOf ?? [];
  const noneOf = rule.noneOf ?? [];

  if (allOf.length + anyOf.length + noneOf.length === 0) {
    throw new Error("An invariant rule must contain at least one matcher");
  }

  return (
    allOf.every((pattern) => matches(pattern, normalizedResponse)) &&
    (anyOf.length === 0 || anyOf.some((pattern) => matches(pattern, normalizedResponse))) &&
    noneOf.every((pattern) => !matches(pattern, normalizedResponse))
  );
}

function validateThresholds(thresholds: EvaluationThresholds): void {
  for (const [dimension, threshold] of Object.entries(thresholds)) {
    if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
      throw new RangeError(`${dimension} threshold must be between 0 and 1`);
    }
  }
}

function dimensionScore(
  dimension: EvaluationDimension,
  invariantResults: FixtureEvaluation["invariants"],
  threshold: number
): DimensionScore {
  const applicable = invariantResults.filter((result) => result.dimension === dimension);
  const passed = applicable.filter((result) => result.passed).length;
  const score = applicable.length === 0 ? 1 : passed / applicable.length;
  return {
    passed,
    total: applicable.length,
    score,
    threshold,
    passedGate: score >= threshold
  };
}

export function evaluateFixture(
  fixture: ScienceEvalFixture,
  candidate: EvaluationCandidate,
  thresholds: EvaluationThresholds = defaultThresholds
): FixtureEvaluation {
  validateThresholds(thresholds);
  if (candidate.fixtureId !== fixture.id) {
    throw new Error(`Candidate ${candidate.fixtureId} does not match fixture ${fixture.id}`);
  }
  if (candidate.engagementScore !== undefined && (
    !Number.isFinite(candidate.engagementScore) || candidate.engagementScore < 0 || candidate.engagementScore > 1
  )) {
    throw new RangeError("engagementScore must be between 0 and 1");
  }

  const invariants = fixture.expectedInvariants.map((invariant) => ({
    id: invariant.id,
    dimension: invariant.dimension,
    description: invariant.description,
    passed: evaluateTextRule(invariant.rule, candidate.response)
  }));
  const factual = dimensionScore("factual", invariants, thresholds.factual);
  const teaching = dimensionScore("teaching", invariants, thresholds.teaching);
  const safety = dimensionScore("safety", invariants, thresholds.safety);
  const status = factual.passedGate && teaching.passedGate && safety.passedGate ? "pass" : "fail";

  return {
    fixtureId: fixture.id,
    discipline: fixture.discipline,
    kind: fixture.kind,
    status,
    factual,
    teaching,
    safety,
    ...(candidate.engagementScore === undefined ? {} : { engagementScore: candidate.engagementScore }),
    invariants
  };
}

export function evaluateSuite(
  candidates: readonly EvaluationCandidate[],
  fixtures: readonly ScienceEvalFixture[] = scienceEvalFixtures,
  thresholds: EvaluationThresholds = defaultThresholds
): SuiteEvaluation {
  validateThresholds(thresholds);
  const candidatesById = new Map<string, EvaluationCandidate>();
  for (const candidate of candidates) {
    if (candidatesById.has(candidate.fixtureId)) {
      throw new Error(`Duplicate candidate for fixture ${candidate.fixtureId}`);
    }
    candidatesById.set(candidate.fixtureId, candidate);
  }

  const fixtureIds = new Set(fixtures.map((fixture) => fixture.id));
  const unknownFixtureIds = [...candidatesById.keys()].filter((fixtureId) => !fixtureIds.has(fixtureId));
  if (unknownFixtureIds.length > 0) {
    throw new Error(`Unknown fixture IDs: ${unknownFixtureIds.join(", ")}`);
  }

  const results = fixtures.map((fixture) => evaluateFixture(
    fixture,
    candidatesById.get(fixture.id) ?? { fixtureId: fixture.id, response: "" },
    thresholds
  ));
  const engagementScores = results.flatMap((result) =>
    result.engagementScore === undefined ? [] : [result.engagementScore]
  );

  return {
    generatedBy: "deterministic-local-science-eval",
    retrievalUsed: false,
    citationsUsed: false,
    results,
    summary: {
      total: results.length,
      passed: results.filter((result) => result.status === "pass").length,
      failed: results.filter((result) => result.status === "fail").length,
      factualFailures: results.filter((result) => !result.factual.passedGate).length,
      teachingFailures: results.filter((result) => !result.teaching.passedGate).length,
      safetyFailures: results.filter((result) => !result.safety.passedGate).length,
      ...(engagementScores.length === 0
        ? {}
        : { meanEngagement: engagementScores.reduce((sum, score) => sum + score, 0) / engagementScores.length })
    }
  };
}
