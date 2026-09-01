import { describe, expect, it } from "vitest";
import { InMemoryLearningMemory } from "./learning-memory";

describe("InMemoryLearningMemory", () => {
  it("accumulates bounded mastery and misconception evidence", async () => {
    const memory = new InMemoryLearningMemory();
    await memory.recordEvidence("learner", { concept: "Gravity", evidence: "Predicted falling", confidenceDelta: 0.8, misconception: "Heavier objects fall faster" });
    const profile = await memory.recordEvidence("learner", { concept: "gravity", evidence: "Revised prediction", confidenceDelta: 0.4, misconception: "heavier objects fall faster" });
    expect(profile.mastery).toEqual([{ concept: "Gravity", confidence: 1, evidenceCount: 2 }]);
    expect(profile.misconceptions).toEqual([{ concept: "Gravity", description: "Heavier objects fall faster", evidenceCount: 2 }]);
  });

  it("merges and deduplicates compact preference signals", async () => {
    const memory = new InMemoryLearningMemory();
    await memory.recordEvidence("learner", { concept: "cells", evidence: "Asked for a diagram", confidenceDelta: 0, preferenceSignals: { explanationMode: "visual", interests: ["Biology", "biology", "Microscopy"] } });
    const profile = await memory.recordEvidence("learner", { concept: "cells", evidence: "Requested slower pacing", confidenceDelta: 0, preferenceSignals: { pace: "slower", interests: ["Genetics"] } });
    expect(profile.preferences).toEqual({ explanationMode: "visual", pace: "slower", interests: ["Biology", "Microscopy", "Genetics"] });
  });

  it("replaces a summary for the same session and caps retained summaries", async () => {
    const memory = new InMemoryLearningMemory();
    for (let index = 0; index < 9; index += 1) {
      await memory.recordSessionSummary("learner", { sessionId: `s-${index}`, summary: `Summary ${index}`, concepts: ["orbit", "orbit"], explorationEdges: [], completedAt: new Date(2026, 0, index + 1) });
    }
    await memory.recordSessionSummary("learner", { sessionId: "s-8", summary: "Updated", concepts: ["gravity"], explorationEdges: [{ from: "orbit", to: "gravity" }], completedAt: new Date(2026, 1, 1) });
    const profile = await memory.load("learner");
    expect(profile.recentSummaries).toHaveLength(8);
    expect(profile.recentSummaries.at(-1)).toMatchObject({ sessionId: "s-8", summary: "Updated", concepts: ["gravity"] });
  });

  it("rejects invalid evidence without modifying a profile", async () => {
    const memory = new InMemoryLearningMemory();
    await expect(memory.recordEvidence("learner", { concept: "orbit", evidence: "prediction", confidenceDelta: 2 })).rejects.toThrow("confidenceDelta");
    expect((await memory.load("learner")).mastery).toEqual([]);
  });
});
