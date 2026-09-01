import { z } from "zod";
import { cardPurposeSchema, cardSchema } from "./cards";
import { visualSpecSchema } from "./tools";

export const gatewayProtocolVersionSchema = z.literal(1);
export const revisionSchema = z.number().int().positive();
export const commandIdSchema = z.uuid();

const eventEnvelope = { protocolVersion: gatewayProtocolVersionSchema } as const;
const commandEnvelope = {
  protocolVersion: gatewayProtocolVersionSchema,
  commandId: commandIdSchema,
  revision: revisionSchema
} as const;

export const sessionStateSchema = z.enum([
  "connecting",
  "listening",
  "thinking",
  "speaking",
  "redirecting",
  "text_only",
  "reconnecting",
  "ended"
]);

export const masteryViewSchema = z.strictObject({
  concept: z.string().trim().min(1).max(160),
  mastery: z.number().min(0).max(1),
  evidenceCount: z.number().int().nonnegative()
});

export const sessionEventSchema = z.discriminatedUnion("type", [
  z.strictObject({
    ...eventEnvelope,
    type: z.literal("transcript.delta"),
    turnId: z.string().min(1).max(120),
    text: z.string().max(16_384)
  }),
  z.strictObject({
    ...eventEnvelope,
    type: z.literal("transcript.final"),
    turnId: z.string().min(1).max(120),
    text: z.string().max(16_384),
    interrupted: z.boolean().default(false)
  }),
  z.strictObject({
    ...eventEnvelope,
    type: z.literal("canvas.cards.replace"),
    revision: revisionSchema,
    purpose: cardPurposeSchema,
    prompt: z.string().trim().min(1).max(300),
    cards: z.array(cardSchema).max(3)
  }),
  z.strictObject({
    ...eventEnvelope,
    type: z.literal("visual.start"),
    revision: revisionSchema,
    visualOperationId: z.string().trim().min(1).max(200),
    spec: visualSpecSchema
  }),
  z.strictObject({
    ...eventEnvelope,
    type: z.literal("visual.redirect"),
    revision: revisionSchema,
    visualOperationId: z.string().trim().min(1).max(200),
    spec: visualSpecSchema
  }),
  z.strictObject({
    ...eventEnvelope,
    type: z.literal("visual.stop"),
    revision: revisionSchema,
    reason: z.enum(["complete", "interrupted", "topic_changed", "budget", "failed"])
  }),
  z.strictObject({
    ...eventEnvelope,
    type: z.literal("learning.progress"),
    concepts: z.array(masteryViewSchema).max(20)
  }),
  z.strictObject({
    ...eventEnvelope,
    type: z.literal("session.status"),
    state: sessionStateSchema,
    detail: z.string().max(160).optional()
  }),
  z.strictObject({
    ...eventEnvelope,
    type: z.literal("session.error"),
    recoverable: z.boolean(),
    code: z.string().trim().min(1).max(80)
  })
]);

export const browserCommandSchema = z.discriminatedUnion("type", [
  z.strictObject({
    ...commandEnvelope,
    type: z.literal("learner.text"),
    text: z.string().trim().min(1).max(2_000)
  }),
  z.strictObject({
    ...commandEnvelope,
    type: z.literal("learner.card.select"),
    cardId: z.string().trim().min(1).max(80)
  }),
  z.strictObject({
    ...commandEnvelope,
    type: z.literal("learner.speech.start"),
    at: z.number().nonnegative(),
    turnId: z.string().min(1).max(256).nullable(),
    heardCharacters: z.number().int().nonnegative()
  }),
  z.strictObject({
    ...commandEnvelope,
    type: z.literal("learner.speech.end"),
    at: z.number().nonnegative()
  }),
  z.strictObject({
    ...eventEnvelope,
    type: z.literal("visual.authorized"),
    sessionId: z.string().trim().min(1).max(200).regex(/^[A-Za-z0-9_-]+$/),
    visualOperationId: z.string().trim().min(1).max(200),
    visualRevision: revisionSchema,
    reservationId: z.string().trim().min(1).max(200)
  }),
  z.strictObject({
    ...eventEnvelope,
    type: z.literal("visual.ready"),
    sessionId: z.string().trim().min(1).max(200).regex(/^[A-Za-z0-9_-]+$/),
    visualOperationId: z.string().trim().min(1).max(200),
    visualRevision: revisionSchema,
    reservationId: z.string().trim().min(1).max(200).optional()
  }),
  z.strictObject({
    ...eventEnvelope,
    type: z.literal("visual.failed"),
    sessionId: z.string().trim().min(1).max(200).regex(/^[A-Za-z0-9_-]+$/),
    visualOperationId: z.string().trim().min(1).max(200),
    visualRevision: revisionSchema,
    reason: z.enum([
      "deadline_missed",
      "prompt_rejected",
      "stream_exhausted",
      "transport",
      "reduced_motion",
      "quota_exceeded",
      "disabled",
      "authorization_failed"
    ])
  })
]);

export type GatewayProtocolVersion = z.infer<typeof gatewayProtocolVersionSchema>;
export type SessionState = z.infer<typeof sessionStateSchema>;
export type MasteryView = z.infer<typeof masteryViewSchema>;
export type SessionEvent = z.infer<typeof sessionEventSchema>;
export type BrowserCommand = z.infer<typeof browserCommandSchema>;
