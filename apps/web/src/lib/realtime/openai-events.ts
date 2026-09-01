import { tutorToolCallSchema, type TutorToolCall } from "@axiom/protocol";
import { z } from "zod";

const identifierSchema = z.string().min(1).max(256);

const realtimeServerEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("session.created") }).passthrough(),
  z.object({ type: z.literal("session.updated") }).passthrough(),
  z.object({
    type: z.literal("input_audio_buffer.speech_started"),
    audio_start_ms: z.number().int().nonnegative(),
    item_id: identifierSchema
  }).passthrough(),
  z.object({
    type: z.literal("input_audio_buffer.speech_stopped"),
    audio_end_ms: z.number().int().nonnegative(),
    item_id: identifierSchema
  }).passthrough(),
  z.object({
    type: z.literal("conversation.item.input_audio_transcription.delta"),
    item_id: identifierSchema,
    content_index: z.number().int().nonnegative(),
    delta: z.string()
  }).passthrough(),
  z.object({
    type: z.literal("conversation.item.input_audio_transcription.completed"),
    item_id: identifierSchema,
    transcript: z.string()
  }).passthrough(),
  z.object({
    type: z.literal("response.output_item.added"),
    item: z.object({ id: identifierSchema, type: z.string() }).passthrough()
  }).passthrough(),
  z.object({
    type: z.literal("response.output_audio_transcript.delta"),
    item_id: identifierSchema,
    delta: z.string()
  }).passthrough(),
  z.object({
    type: z.literal("response.output_audio_transcript.done"),
    item_id: identifierSchema,
    transcript: z.string()
  }).passthrough(),
  z.object({
    type: z.literal("response.output_text.delta"),
    item_id: identifierSchema,
    delta: z.string()
  }).passthrough(),
  z.object({
    type: z.literal("response.output_text.done"),
    item_id: identifierSchema,
    text: z.string()
  }).passthrough(),
  z.object({ type: z.literal("response.created") }).passthrough(),
  z.object({ type: z.literal("response.done") }).passthrough(),
  z.object({ type: z.literal("response.cancelled") }).passthrough(),
  z.object({ type: z.literal("output_audio_buffer.started") }).passthrough(),
  z.object({ type: z.literal("output_audio_buffer.stopped") }).passthrough(),
  z.object({ type: z.literal("output_audio_buffer.cleared") }).passthrough(),
  z.object({
    type: z.literal("response.function_call_arguments.done"),
    item_id: identifierSchema,
    call_id: identifierSchema,
    name: z.string().min(1).max(80),
    arguments: z.string().max(20_000)
  }).passthrough(),
  z.object({
    type: z.literal("error"),
    error: z.object({ type: z.string().optional(), code: z.string().optional(), message: z.string().optional() }).passthrough()
  }).passthrough()
]);

export type RealtimeServerEvent = z.infer<typeof realtimeServerEventSchema>;

export function parseRealtimeServerEvent(raw: unknown): RealtimeServerEvent | null {
  if (typeof raw !== "string") return null;

  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    return null;
  }

  const result = realtimeServerEventSchema.safeParse(decoded);
  return result.success ? result.data : null;
}

export function parseTutorToolCall(event: RealtimeServerEvent): TutorToolCall | null {
  if (event.type !== "response.function_call_arguments.done") return null;

  let decodedArguments: unknown;
  try {
    decodedArguments = JSON.parse(event.arguments);
  } catch {
    return null;
  }

  const result = tutorToolCallSchema.safeParse({ name: event.name, arguments: decodedArguments });
  return result.success ? result.data : null;
}
