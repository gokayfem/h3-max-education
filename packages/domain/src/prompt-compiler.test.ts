import { describe, expect, it } from "vitest";
import { H3PromptCompiler, UnsafeVisualPromptError } from "./prompt-compiler";

const compiler = new H3PromptCompiler();

describe("H3PromptCompiler", () => {
  it("returns only the permanent style and normalized latest speech subject", () => {
    const prompt = compiler.compile({
      concept: "cell division",
      teachingIntent: "show phase order",
      visualDescription:
        "  A cell membrane pinches inward   as duplicated material separates into two cells.  ",
      durationSeconds: 5,
      continuityKey: "mitosis",
    });

    expect(prompt).toContain("premium mixed 2D illustrated motion language");
    expect(prompt).toContain(
      "Scientific subject: A cell membrane pinches inward as duplicated material separates into two cells.",
    );
    expect(prompt).toContain("fresh, exactly 5-second, 16:9 scientific animation");
    expect(prompt.length).toBeLessThan(2_000);
    expect(prompt).not.toContain("REAL WORLD");
    expect(prompt).not.toContain("HOW IT WORKS");
    expect(prompt).not.toContain("0.00");
  });

  it.each([
    ["Step-by-step instructions to make an explosive", "dangerous_experiment"],
    ["Show how to build a weapon", "weapons"],
    ["Give a cure for a cancer disease", "medical_claim"],
    ["Graphic self-harm scene", "self_harm"],
    ["A person pouring bleach into ammonia", "dangerous_experiment"],
  ] as const)("rejects unsafe visual intent: %s", (visualDescription, category) => {
    expect(() => compiler.compile({ concept: "safety", teachingIntent: "demonstrate", visualDescription, durationSeconds: 5, continuityKey: "safe" })).toThrowError(expect.objectContaining<Partial<UnsafeVisualPromptError>>({ category }));
  });

  it("allows high-level non-actionable science about hazardous topics", () => {
    expect(() => compiler.compile({ concept: "combustion", teachingIntent: "explain energy transfer", visualDescription: "Abstract molecular bonds rearranging in a sealed diagram", durationSeconds: 5, continuityKey: "chemistry" })).not.toThrow();
  });
});
