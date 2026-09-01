import { z } from "zod";
import { nonBlankStringSchema } from "./strings";

export const cardPurposeSchema = z.enum(["branch", "predict", "compare", "sequence", "check"]);

export const cardSchema = z.strictObject({
  id: nonBlankStringSchema(80),
  title: nonBlankStringSchema(120),
  description: nonBlankStringSchema(280),
  spokenAliases: z.array(nonBlankStringSchema(80)).max(6).default([]),
  order: z.number().int().nonnegative().optional()
});

export type CardPurpose = z.infer<typeof cardPurposeSchema>;
export type Card = z.infer<typeof cardSchema>;
