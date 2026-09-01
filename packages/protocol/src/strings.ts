import { z } from "zod";

export function nonBlankStringSchema(maxLength: number): z.ZodString {
  return z.string().regex(/\S/u).trim().min(1).max(maxLength);
}
