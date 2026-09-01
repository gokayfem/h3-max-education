import type { VisualSpec } from "@axiom/protocol";
import { AgeAppropriateSafetyPolicy, type SafetyCategory, type SafetyPolicy } from "./safety-policy";
export const PERMANENT_VIDEO_STYLE = [
  "STYLE BIBLE: apply a premium mixed 2D illustrated motion language to every frame.",
  "Use hand-drawn cel animation with rough black ink contours, 1970s jazz-record editorial design, cream paper grain, restrained screen-print texture, halftone shadows, torn graphic shapes, sharp negative space, and shallow layered parallax.",
  "Use deep cobalt, dry crimson, tobacco brown, muted ochre, warm ivory, and hard black as the stable palette, adjusting only local emphasis for scientific clarity.",
  "Use limited animation on twos, graphic smear drawings during the fastest moves, decisive impact frames, fast acceleration with controlled deceleration, and brief stillness when an important scientific state lands.",
  "Keep every frame illustrated: no photorealism, live action, glossy 3D, generic anime faces, modern app graphics, fake interfaces, or text-like marks.",
  "The style controls rendering only. Do not import recurring props, clue inventories, signature paths, transformation chains, camera routes, shot order, characters, story material, or layouts from any reference. Derive every subject, object, movement, and transition solely from the current scientific explanation.",
].join(" ");

export class UnsafeVisualPromptError extends Error {
  constructor(readonly category: SafetyCategory, readonly guidance: string) {
    super(`Visual request rejected by safety policy: ${category}`);
    this.name = "UnsafeVisualPromptError";
  }
}

export interface VisualPromptCompiler { compile(spec: VisualSpec): string }

export class H3PromptCompiler implements VisualPromptCompiler {
  constructor(private readonly safetyPolicy: SafetyPolicy = new AgeAppropriateSafetyPolicy()) {}

  compile(spec: VisualSpec): string {
    const decision = this.safetyPolicy.assess(spec);
    if (!decision.allowed) throw new UnsafeVisualPromptError(decision.category, decision.guidance);
    const concept = normalize(spec.concept);
    const intent = normalize(spec.teachingIntent);
    const description = normalize(spec.visualDescription);
    const continuityKey = normalize(spec.continuityKey);
    if (!concept || !intent || !description || !continuityKey) throw new Error("Visual prompt fields must not be blank");

    return [
      PERMANENT_VIDEO_STYLE,
      `Scientific subject: ${description}`,
      `Create a fresh, exactly ${spec.durationSeconds}-second, 16:9 scientific animation of only this subject. Keep the film text-free, centered, and fully illustrated. Use subject-specific composition and motion instead of repeating earlier props, layouts, or camera paths.`,
    ].join(" ");
  }
}

function normalize(value: string): string { return value.trim().replace(/\s+/g, " "); }
