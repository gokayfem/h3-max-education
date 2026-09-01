import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { formatTextReport, runCli } from "./cli.js";
import { evaluateSuite } from "./evaluator.js";
import { scienceEvalFixtures } from "./fixtures.js";
import {
  deterministicAdversarialCandidates,
  deterministicPassCandidates
} from "./provider-test-fixtures.js";
import type { ScienceEvalFixture } from "./types.js";

const fixture: ScienceEvalFixture = {
  id: "cli-fixture",
  discipline: "chemistry",
  kind: "adversarial",
  prompt: "Explain this.",
  expectedInvariants: [
    { id: "fact", dimension: "factual", description: "Fact", rule: { allOf: ["fact"] } },
    { id: "teach", dimension: "teaching", description: "Teach", rule: { allOf: ["compare"] } }
  ]
};

function captureStreams() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    streams: {
      stdout: (text: string) => { stdout.push(text); },
      stderr: (text: string) => { stderr.push(text); }
    }
  };
}

describe("CLI report", () => {
  it("prints factual and teaching scores in separate columns", () => {
    const report = evaluateSuite([
      { fixtureId: fixture.id, response: "fact", engagementScore: 1 }
    ], [fixture]);
    const output = formatTextReport(report);
    expect(output).toContain("Factual");
    expect(output).toContain("Teaching");
    expect(output).toContain("Engagement");
    expect(output).toContain("factual failures 0; teaching failures 1");
    expect(output).toContain("informational only");
  });

  it("returns a failing exit code and JSON report when any fixture gate fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "axiom-science-eval-"));
    const responsesPath = join(directory, "responses.json");
    await writeFile(responsesPath, JSON.stringify([]), "utf8");
    const capture = captureStreams();

    const exitCode = await runCli(["--responses", responsesPath, "--format", "json"], capture.streams);

    expect(exitCode).toBe(1);
    const report = JSON.parse(capture.stdout.join("")) as { summary: { factualFailures: number; teachingFailures: number } };
    expect(report.summary.factualFailures).toBeGreaterThan(0);
    expect(report.summary.teachingFailures).toBeGreaterThan(0);
    expect(capture.stderr).toEqual([]);
  });

  it("lists the complete deterministic corpus", async () => {
    const capture = captureStreams();
    const exitCode = await runCli(["--list", "--format", "json"], capture.streams);
    const fixtures = JSON.parse(capture.stdout.join("")) as Array<{ discipline: string; expectedInvariants: unknown[] }>;

    expect(exitCode).toBe(0);
    expect(new Set(fixtures.map((item) => item.discipline)).size).toBe(6);
    expect(fixtures.every((item) => item.expectedInvariants.length > 0)).toBe(true);
  });

  it("executes deterministic passing provider output for every real fixture", async () => {
    const directory = await mkdtemp(join(tmpdir(), "axiom-science-eval-"));
    const responsesPath = join(directory, "responses.json");
    await writeFile(responsesPath, JSON.stringify(deterministicPassCandidates), "utf8");
    const capture = captureStreams();

    const exitCode = await runCli(["--responses", responsesPath, "--format", "json"], capture.streams);

    expect(exitCode).toBe(0);
    const report = JSON.parse(capture.stdout.join("")) as {
      results: Array<{ fixtureId: string; status: string }>;
      summary: { total: number; factualFailures: number; teachingFailures: number };
    };
    expect(report.summary).toMatchObject({
      total: scienceEvalFixtures.length,
      factualFailures: 0,
      teachingFailures: 0
    });
    expect(report.results.map((result) => result.fixtureId).sort()).toEqual(
      scienceEvalFixtures.map((item) => item.id).sort()
    );
    expect(report.results.every((result) => result.status === "pass")).toBe(true);
  });

  it("reports factual and teaching failures independently for real adversarial outputs", async () => {
    const directory = await mkdtemp(join(tmpdir(), "axiom-science-eval-"));
    const responsesPath = join(directory, "responses.json");
    await writeFile(responsesPath, JSON.stringify(deterministicAdversarialCandidates), "utf8");
    const capture = captureStreams();

    const exitCode = await runCli(["--responses", responsesPath, "--format", "text"], capture.streams);

    expect(exitCode).toBe(1);
    const output = capture.stdout.join("");
    expect(output).toContain("Factual");
    expect(output).toContain("Teaching");
    expect(output).toMatch(/factual failures [1-9]\d*; teaching failures [1-9]\d*/u);
    expect(output).toContain("Safety");
    expect(capture.stderr).toEqual([]);
  });

  it("reports malformed response input without evaluating it", async () => {
    const directory = await mkdtemp(join(tmpdir(), "axiom-science-eval-"));
    const responsesPath = join(directory, "responses.json");
    await writeFile(responsesPath, JSON.stringify([{ fixtureId: 3, response: null }]), "utf8");
    const capture = captureStreams();

    const exitCode = await runCli(["--responses", responsesPath], capture.streams);

    expect(exitCode).toBe(2);
    expect(capture.stdout).toEqual([]);
    expect(capture.stderr.join(" ")).toContain("requires string fixtureId and response");
  });

  it("shows usage for missing arguments and rejects invalid formats", async () => {
    const missing = captureStreams();
    expect(await runCli([], missing.streams)).toBe(2);
    expect(missing.stderr.join(" ")).toContain("Usage:");

    const invalid = captureStreams();
    expect(await runCli(["--list", "--format", "xml"], invalid.streams)).toBe(2);
    expect(invalid.stderr.join(" ")).toContain("text or json");
  });
});
