#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { evaluateSuite } from "./evaluator.js";
import { scienceEvalFixtures } from "./fixtures.js";
import type { EvaluationCandidate, SuiteEvaluation } from "./types.js";

interface CliStreams {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

function usage(): string {
  return [
    "Usage: axiom-science-eval --responses <file> [--format text|json]",
    "       axiom-science-eval --list [--format text|json]",
    "",
    "Response file: a JSON array of { fixtureId, response, engagementScore? }.",
    "Every omitted fixture is evaluated as unanswered and fails its gates."
  ].join("\n");
}

function parseCandidates(value: unknown): EvaluationCandidate[] {
  if (!Array.isArray(value)) {
    throw new TypeError("Response file must contain a JSON array");
  }

  return value.map((candidate, index) => {
    if (typeof candidate !== "object" || candidate === null) {
      throw new TypeError(`Candidate at index ${index} must be an object`);
    }
    const record = candidate as Record<string, unknown>;
    if (typeof record.fixtureId !== "string" || typeof record.response !== "string") {
      throw new TypeError(`Candidate at index ${index} requires string fixtureId and response`);
    }
    if (record.engagementScore !== undefined && typeof record.engagementScore !== "number") {
      throw new TypeError(`Candidate at index ${index} engagementScore must be a number`);
    }
    return {
      fixtureId: record.fixtureId,
      response: record.response,
      ...(record.engagementScore === undefined ? {} : { engagementScore: record.engagementScore })
    };
  });
}

function percentage(value: number): string {
  return `${Math.round(value * 100)}%`;
}

export function formatTextReport(report: SuiteEvaluation): string {
  const rows = report.results.map((result) => [
    result.fixtureId,
    result.status.toUpperCase(),
    percentage(result.factual.score),
    percentage(result.teaching.score),
    percentage(result.safety.score),
    result.engagementScore === undefined ? "—" : percentage(result.engagementScore)
  ]);
  const headers = ["Fixture", "Status", "Factual", "Teaching", "Safety", "Engagement"];
  const widths = headers.map((header, column) => Math.max(
    header.length,
    ...rows.map((row) => row[column]?.length ?? 0)
  ));
  const renderRow = (row: readonly string[]) => row
    .map((cell, column) => cell.padEnd(widths[column] ?? cell.length))
    .join("  ");
  const summary = report.summary;
  const failureDetails = report.results.flatMap((result) => {
    const failed = result.invariants.filter((invariant) => !invariant.passed);
    return failed.length === 0
      ? []
      : [
          `${result.fixtureId} failed invariants:`,
          ...failed.map((invariant) => `  [${invariant.dimension}] ${invariant.id}: ${invariant.description}`)
        ];
  });

  return [
    "Deterministic local science evaluation (retrieval: no; citations: no)",
    renderRow(headers),
    renderRow(widths.map((width) => "-".repeat(width))),
    ...rows.map(renderRow),
    "",
    `Passed ${summary.passed}/${summary.total}; factual failures ${summary.factualFailures}; teaching failures ${summary.teachingFailures}; safety failures ${summary.safetyFailures}.`,
    ...(failureDetails.length === 0 ? [] : ["", ...failureDetails]),
    ...(summary.meanEngagement === undefined ? [] : [`Mean engagement (informational only): ${percentage(summary.meanEngagement)}.`])
  ].join("\n");
}

export async function runCli(
  args: readonly string[],
  streams: CliStreams = {
    stdout: (text) => process.stdout.write(`${text}\n`),
    stderr: (text) => process.stderr.write(`${text}\n`)
  }
): Promise<number> {
  try {
    if (args.includes("--help") || args.includes("-h")) {
      streams.stdout(usage());
      return 0;
    }
    const formatIndex = args.indexOf("--format");
    const format = formatIndex === -1 ? "text" : args[formatIndex + 1];
    if (format !== "text" && format !== "json") {
      throw new Error("--format must be text or json");
    }
    if (args.includes("--list")) {
      const fixtures = scienceEvalFixtures.map(({ id, discipline, kind, prompt, misconception, expectedInvariants }) => ({
        id,
        discipline,
        kind,
        prompt,
        ...(misconception === undefined ? {} : { misconception }),
        expectedInvariants: expectedInvariants.map(({ id: invariantId, dimension, description }) => ({
          id: invariantId,
          dimension,
          description
        }))
      }));
      streams.stdout(format === "json"
        ? JSON.stringify(fixtures, null, 2)
        : fixtures.map((fixture) => `${fixture.id}\t${fixture.discipline}\t${fixture.kind}\t${fixture.prompt}`).join("\n"));
      return 0;
    }

    const responsesIndex = args.indexOf("--responses");
    const responsesPath = responsesIndex === -1 ? undefined : args[responsesIndex + 1];
    if (responsesPath === undefined) {
      streams.stderr(usage());
      return 2;
    }
    const candidates = parseCandidates(JSON.parse(await readFile(responsesPath, "utf8")) as unknown);
    const report = evaluateSuite(candidates);
    streams.stdout(format === "json" ? JSON.stringify(report, null, 2) : formatTextReport(report));
    return report.summary.failed === 0 ? 0 : 1;
  } catch (error) {
    streams.stderr(error instanceof Error ? error.message : String(error));
    return 2;
  }
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) {
  process.exitCode = await runCli(process.argv.slice(2));
}
