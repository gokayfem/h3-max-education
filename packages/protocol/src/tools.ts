import { z } from "zod";
import { cardPurposeSchema } from "./cards";
import { nonBlankStringSchema } from "./strings";

export const visualDurationSchema = z.literal(5);

export const visualSpecSchema = z.strictObject({
  concept: nonBlankStringSchema(160),
  teachingIntent: nonBlankStringSchema(500),
  visualDescription: nonBlankStringSchema(2_000),
  durationSeconds: visualDurationSchema.default(5),
  continuityKey: nonBlankStringSchema(120)
});

export const preferenceSignalsSchema = z.strictObject({
  explanationMode: z.enum(["analogy", "visual", "mathematical", "concise", "stepwise"]).optional(),
  pace: z.enum(["slower", "steady", "faster"]).optional(),
  challenge: z.enum(["supportive", "balanced", "stretch"]).optional(),
  interests: z.array(nonBlankStringSchema(80)).max(8).optional()
});

export const showVisualArgumentsSchema = visualSpecSchema;

export const presentCardArgumentsSchema = z.strictObject({
  title: nonBlankStringSchema(120),
  description: nonBlankStringSchema(280),
  spokenAliases: z.array(nonBlankStringSchema(80)).max(6).default([]),
  order: z.number().int().nonnegative().optional()
});

export const presentCardsArgumentsSchema = z.strictObject({
  purpose: cardPurposeSchema,
  prompt: nonBlankStringSchema(300),
  cards: z.array(presentCardArgumentsSchema).min(1).max(3)
});

export const recordLearningEvidenceArgumentsSchema = z.strictObject({
  concept: nonBlankStringSchema(160),
  evidence: nonBlankStringSchema(1_000),
  confidenceDelta: z.number().min(-1).max(1),
  misconception: nonBlankStringSchema(500).nullable().optional(),
  preferenceSignals: preferenceSignalsSchema.default({})
});

export const stopVisualArgumentsSchema = z.strictObject({
  reason: z.enum(["complete", "interrupted", "topic_changed", "budget"])
});

export const tutorToolCallSchema = z.discriminatedUnion("name", [
  z.strictObject({ name: z.literal("show_visual"), arguments: showVisualArgumentsSchema }),
  z.strictObject({ name: z.literal("present_cards"), arguments: presentCardsArgumentsSchema }),
  z.strictObject({ name: z.literal("record_learning_evidence"), arguments: recordLearningEvidenceArgumentsSchema }),
  z.strictObject({ name: z.literal("stop_visual"), arguments: stopVisualArgumentsSchema })
]);

export type VisualDuration = z.infer<typeof visualDurationSchema>;
export type VisualSpec = z.infer<typeof visualSpecSchema>;
export type PreferenceSignals = z.infer<typeof preferenceSignalsSchema>;
export type TutorToolCall = z.infer<typeof tutorToolCallSchema>;
