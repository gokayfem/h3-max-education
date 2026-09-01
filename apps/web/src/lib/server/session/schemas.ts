import {
  browserCommandSchema,
  cardSchema,
  commandIdSchema,
  gatewayProtocolVersionSchema,
  revisionSchema,
  sessionEventSchema,
  tutorToolCallSchema,
  visualSpecSchema,
} from "@axiom/protocol";
import type { ConceptMastery, ExplorationEdge } from "@axiom/domain";
import { z } from "zod";

const conceptMasterySchema: z.ZodType<ConceptMastery> = z.strictObject({
  concept: z.string().trim().min(1).max(160),
  confidence: z.number().min(0).max(1),
  evidenceCount: z.number().int().nonnegative(),
});
const explorationEdgeSchema: z.ZodType<ExplorationEdge> = z.strictObject({
  from: z.string().trim().min(1).max(160),
  to: z.string().trim().min(1).max(160),
});

const idempotencyKeySchema = z.string().min(8).max(200).regex(/^[A-Za-z0-9._:-]+$/);
export const sessionIdSchema = z.string().uuid();

export const createSessionInputSchema = z.strictObject({
  question: z.string().trim().min(1).max(2_000).optional(),
  idempotencyKey: idempotencyKeySchema,
});
const browserMutationEnvelope = {
  protocolVersion: gatewayProtocolVersionSchema,
  commandId: commandIdSchema,
  revision: revisionSchema,
} as const;

export const turnInputSchema = z.strictObject({
  ...browserMutationEnvelope,
  text: z.string().trim().min(1).max(2_000),
});

export const cardInputSchema = z.strictObject({
  ...browserMutationEnvelope,
  cardId: z.string().min(1).max(80),
});

export const closeInputSchema = z.strictObject({
  ...browserMutationEnvelope,
  reason: z.enum(["complete", "abandoned", "error"]),
});

export const recoverQuerySchema = z.strictObject({
  cursor: z.coerce.number().int().nonnegative().default(0),
});

export const sessionCardSetSchema = z.strictObject({
  purpose: z.enum(["branch", "predict", "compare", "sequence", "check"]),
  prompt: z.string().min(1).max(300),
  cards: z.array(cardSchema).min(1).max(3),
  revision: z.number().int().nonnegative(),
});
const activeVisualSchema = z.strictObject({
  visualOperationId: z.string().trim().min(1).max(200),
  spec: visualSpecSchema,
});


export const activeLessonStateSchema = z.strictObject({
  revision: z.number().int().nonnegative(),
  status: z.enum(["text_only", "thinking", "ended"]),
  learnerId: z.string().min(1).max(200),
  startedAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  turnCount: z.number().int().nonnegative(),
  concepts: z.array(z.string().min(1).max(160)).max(40),
  explorationEdges: z.array(explorationEdgeSchema).max(24),
  mastery: z.array(conceptMasterySchema).max(50),
  cards: sessionCardSetSchema.nullable(),
  visual: activeVisualSchema.nullable(),
  lastEvents: z.array(sessionEventSchema).max(12),
});

export const sessionTurnResponseSchema = z.strictObject({
  sessionId: sessionIdSchema,
  turnId: z.string().uuid(),
  reply: z.string().min(1),
  cards: sessionCardSetSchema,
  events: z.array(sessionEventSchema),
  toolCalls: z.array(tutorToolCallSchema),
});

export const createSessionResponseSchema = z.strictObject({
  sessionId: sessionIdSchema,
  state: z.literal("text_only"),
  events: z.array(sessionEventSchema),
  initialTurn: sessionTurnResponseSchema.optional(),
});

export const closeSessionResponseSchema = z.strictObject({
  sessionId: sessionIdSchema,
  summary: z.string().min(1).max(2_000),
  deleted: z.literal(true),
});

export const browserLessonCommandSchema = browserCommandSchema;

export type CreateSessionInput = z.infer<typeof createSessionInputSchema>;
export type TurnInput = z.infer<typeof turnInputSchema>;
export type CardInput = z.infer<typeof cardInputSchema>;
export type CloseInput = z.infer<typeof closeInputSchema>;
export type ActiveLessonState = z.infer<typeof activeLessonStateSchema>;
export type SessionTurnResponse = z.infer<typeof sessionTurnResponseSchema>;
export type CreateSessionResponse = z.infer<typeof createSessionResponseSchema>;
export type CloseSessionResponse = z.infer<typeof closeSessionResponseSchema>;
