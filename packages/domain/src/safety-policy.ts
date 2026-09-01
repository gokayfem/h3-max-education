import type { VisualSpec } from "@axiom/protocol";

export type SafetyCategory = "dangerous_experiment" | "medical_claim" | "weapons" | "self_harm" | "explicit_content";
export type SafetyDecision = { allowed: true } | { allowed: false; category: SafetyCategory; guidance: string };

export interface SafetyPolicy { assess(spec: VisualSpec): SafetyDecision }

const RULES: readonly { category: SafetyCategory; pattern: RegExp; guidance: string }[] = [
  { category: "self_harm", pattern: /\b(suicide|self[- ]?harm|cut myself|kill myself)\b/i, guidance: "Use a supportive, non-graphic wellbeing response and direct the learner to trusted help." },
  { category: "explicit_content", pattern: /\b(porn|explicit sex|sexual act|genital)\b/i, guidance: "Keep explanations age-appropriate and non-explicit." },
  { category: "dangerous_experiment", pattern: /(?:\b(step[- ]by[- ]step|instructions?|recipe|how to)\b.{0,80}\b(explosive|poison|toxic gas|electrocute|firework)\b|\b(mix(?:ing)?|combin(?:e|ing)|pour(?:ing)?|add(?:ing)?|heat(?:ing)?)\b.{0,80}\b(bleach|ammonia|chlorine gas|toxic gas|thermite|explosive|strong acid)\b)/i, guidance: "Replace the procedure with a safe conceptual diagram or supervised classroom alternative." },
  { category: "weapons", pattern: /\b(build|make|assemble|improvise)\b.{0,40}\b(bomb|weapon|gun|explosive)\b|\b(bomb|weapon|gun|explosive)\b.{0,40}\b(build|make|assemble|improvise)\b/i, guidance: "Discuss high-level science and safety without actionable weapon instructions." },
  { category: "medical_claim", pattern: /\b(cure|diagnose|prescribe|dose|treatment plan)\b.{0,50}\b(disease|cancer|infection|medicine|drug|illness)\b/i, guidance: "Explain general biology without diagnosis or treatment advice." }
];

export class AgeAppropriateSafetyPolicy implements SafetyPolicy {
  assess(spec: VisualSpec): SafetyDecision {
    const subject = `${spec.concept}\n${spec.teachingIntent}\n${spec.visualDescription}`;
    for (const rule of RULES) {
      if (rule.pattern.test(subject)) return { allowed: false, category: rule.category, guidance: rule.guidance };
    }
    return { allowed: true };
  }
}
