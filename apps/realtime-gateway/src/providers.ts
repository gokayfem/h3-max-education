import WebSocket from "ws";
import { z } from "zod";
import {
  buildLearnerMemoryMessage,
  buildTutorInstructions,
  TUTOR_TOOL_DEFINITIONS,
  tutorToolCallSchema,
  type TutorToolCall
} from "@axiom/protocol";
const MAX_PROVIDER_FRAME_BYTES = 131_072;

const responseIdentity = {
  item_id: z.string().optional(),
  response_id: z.string().optional()
} as const;

const providerToolCallDoneSchema = z.object({
  type: z.literal("response.function_call_arguments.done"),
  ...responseIdentity,
  call_id: z.string().min(1),
  name: z.string().min(1),
  arguments: z.string().max(65_536)
}).passthrough();

const providerMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("response.output_audio_transcript.delta"),
    ...responseIdentity,
    delta: z.string().max(16_384)
  }).passthrough(),
  z.object({
    type: z.literal("response.output_audio_transcript.done"),
    ...responseIdentity,
    transcript: z.string().max(16_384)
  }).passthrough(),
  z.object({ type: z.literal("response.created"), ...responseIdentity }).passthrough(),
  z.object({ type: z.literal("response.output_audio.delta"), ...responseIdentity }).passthrough(),
  z.object({ type: z.literal("response.done"), ...responseIdentity }).passthrough(),
  z.object({
    type: z.literal("error"),
    ...responseIdentity,
    error: z.object({ code: z.string().optional() }).passthrough()
  }).passthrough(),
  providerToolCallDoneSchema
]);

const malformedToolCallEnvelopeSchema = z.object({
  type: z.literal("response.function_call_arguments.done"),
  call_id: z.string().min(1).optional()
}).passthrough();

const textResponseSchema = z.object({
  output_text: z.string().optional(),
  output: z.array(z.object({
    content: z.array(z.object({ text: z.string().optional() }).passthrough()).optional()
  }).passthrough()).optional()
}).passthrough();

export interface SidebandCallbacks {
  readonly onTranscriptDelta: (turnId: string, text: string) => void;
  readonly onTranscriptFinal: (turnId: string, text: string) => void;
  readonly onToolCall: (callId: string, call: TutorToolCall, responseId?: string) => Promise<unknown>;
  readonly onState: (state: "listening" | "thinking" | "speaking") => void;
  readonly onDisconnect: () => void;
  readonly onProviderError: (code: string) => void;
}

export interface RealtimeSideband {
  connect(): Promise<void>;
  sendLearnerText(text: string, operationId?: string): boolean;
  cancelResponse(): void;
  clearOutputAudio(): void;
  truncateAssistant(turnId: string, heardCharacters: number): void;
  selectCard(cardId: string, title: string, operationId?: string): boolean;
  close(): Promise<void>;
}


export class OpenAiRealtimeSideband implements RealtimeSideband {
  private socket?: WebSocket;
  private closing = false;
  private activeResponseId?: string;
  private readonly canceledResponseIds = new Set<string>();

  constructor(
    private readonly callId: string,
    private readonly apiKey: string,
    private readonly callbacks: SidebandCallbacks,
    private readonly learnerContext = ""
  ) {}

  connect(): Promise<void> {
    this.closing = false;
    this.activeResponseId = undefined;
    this.canceledResponseIds.clear();
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    const url = new URL("wss://api.openai.com/v1/realtime");
    url.searchParams.set("call_id", this.callId);
    const socket = new WebSocket(url, {
      headers: { Authorization: `Bearer ${this.apiKey}` },
      handshakeTimeout: 10_000,
      maxPayload: MAX_PROVIDER_FRAME_BYTES
    });
    this.socket = socket;
    const timeout = setTimeout(() => {
      socket.terminate();
      reject(new Error("Realtime sideband connection timed out"));
    }, 10_000);
    socket.once("open", () => {
      clearTimeout(timeout);
      socket.send(JSON.stringify({
        type: "session.update",
        session: {
          type: "realtime",
          instructions: buildTutorInstructions(this.learnerContext),
          tools: TUTOR_TOOL_DEFINITIONS,
          tool_choice: "auto"
        }
      }));
      const learnerMemory = buildLearnerMemoryMessage(this.learnerContext);
      if (learnerMemory) {
        socket.send(JSON.stringify({
          type: "conversation.item.create",
          item: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: learnerMemory }],
          },
        }));
      }
      resolve();
    });
    socket.on("message", (data, binary) => {
      if (binary || data.toString().length > MAX_PROVIDER_FRAME_BYTES) {
        this.callbacks.onProviderError("provider_frame_too_large");
        socket.close(1009, "provider frame too large");
        return;
      }
      this.handleMessage(data.toString());
    });
    socket.once("error", (error) => {
      clearTimeout(timeout);
      if (error.message.toLowerCase().includes("max payload")) {
        this.callbacks.onProviderError("provider_frame_too_large");
      } else if (socket.readyState === WebSocket.OPEN) {
        this.callbacks.onProviderError("provider_error");
      } else {
        reject(new Error("Realtime sideband connection failed"));
      }
    });
    socket.once("close", () => {
      clearTimeout(timeout);
      if (!this.closing) this.callbacks.onDisconnect();
    });
    return promise;
  }

  sendLearnerText(text: string, operationId?: string): boolean {
    const itemSent = this.send({
      type: "conversation.item.create",
      ...(operationId ? { event_id: operationId } : {}),
      item: { type: "message", role: "user", content: [{ type: "input_text", text }] }
    });
    return itemSent && this.send({ type: "response.create" });
  }

  cancelResponse(): void {
    if (this.activeResponseId) {
      this.canceledResponseIds.add(this.activeResponseId);
      if (this.canceledResponseIds.size > 64) {
        const oldestResponseId = this.canceledResponseIds.values().next().value;
        if (oldestResponseId) this.canceledResponseIds.delete(oldestResponseId);
      }
    }
    this.send({ type: "response.cancel" });
  }

  clearOutputAudio(): void {
    this.send({ type: "output_audio_buffer.clear" });
  }

  truncateAssistant(turnId: string, heardCharacters: number): void {
    this.send({
      type: "conversation.item.truncate",
      item_id: turnId,
      content_index: 0,
      audio_end_ms: Math.max(0, heardCharacters * 45)
    });
  }

  selectCard(cardId: string, title: string, operationId?: string): boolean {
    const itemSent = this.send({
      type: "conversation.item.create",
      ...(operationId ? { event_id: operationId } : {}),
      item: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: `I selected the learning card “${title}” (id: ${cardId}). Continue from that choice.` }]
      }
    });
    return itemSent && this.send({ type: "response.create" });
  }

  async close(): Promise<void> {
    this.closing = true;
    const socket = this.socket;
    if (!socket || socket.readyState === WebSocket.CLOSED) return;
    const { promise, resolve } = Promise.withResolvers<void>();
    const timeout = setTimeout(() => {
      socket.terminate();
      resolve();
    }, 1_000);
    socket.once("close", () => {
      clearTimeout(timeout);
      resolve();
    });
    socket.close(1000, "session ended");
    await promise;
  }

  private send(message: object): boolean {
    if (this.socket?.readyState !== WebSocket.OPEN) return false;
    this.socket.send(JSON.stringify(message));
    return true;
  }

  private handleMessage(raw: string): void {
    let candidate: unknown;
    try {
      candidate = JSON.parse(raw);
    } catch {
      return;
    }
    const parsed = providerMessageSchema.safeParse(candidate);
    if (!parsed.success) {
      const malformedToolCall = malformedToolCallEnvelopeSchema.safeParse(candidate);
      if (malformedToolCall.success) {
        if (malformedToolCall.data.call_id) {
          this.returnToolOutput(malformedToolCall.data.call_id, { ok: false, error: "invalid_arguments" });
        }
        this.callbacks.onProviderError("invalid_arguments");
      }
      return;
    }
    const message = parsed.data;
    const turnId = message.item_id ?? message.response_id ?? "provider-turn";
    if (message.type === "response.output_audio_transcript.delta" && message.delta) {
      this.callbacks.onTranscriptDelta(turnId, message.delta);
    } else if (message.type === "response.output_audio_transcript.done" && message.transcript !== undefined) {
      this.callbacks.onTranscriptFinal(turnId, message.transcript);
    } else if (message.type === "response.created") {
      this.activeResponseId = message.response_id;
      this.callbacks.onState("thinking");
    } else if (message.type === "response.output_audio.delta") {
      this.callbacks.onState("speaking");
    } else if (message.type === "response.done") {
      if (!message.response_id || message.response_id === this.activeResponseId) this.activeResponseId = undefined;
      this.callbacks.onState("listening");
    } else if (message.type === "error") {
      this.callbacks.onProviderError(message.error?.code ?? "provider_error");
    } else if (message.type === "response.function_call_arguments.done") {
      if (message.response_id && this.canceledResponseIds.has(message.response_id)) return;
      void this.executeTool(message.call_id, message.name, message.arguments, message.response_id);
    }
  }

  private async executeTool(callId: string, name: string, rawArguments: string, responseId?: string): Promise<void> {
    let candidate: unknown;
    try {
      candidate = { name, arguments: JSON.parse(rawArguments) };
    } catch {
      this.returnToolOutput(callId, { ok: false, error: "invalid_arguments" });
      return;
    }
    const parsed = tutorToolCallSchema.safeParse(candidate);
    if (!parsed.success) {
      this.returnToolOutput(callId, { ok: false, error: "invalid_arguments" });
      return;
    }
    try {
      const output = await this.callbacks.onToolCall(callId, parsed.data, responseId);
      this.returnToolOutput(callId, { ok: true, output });
    } catch {
      this.returnToolOutput(callId, { ok: false, error: "tool_unavailable" });
    }
  }

  private returnToolOutput(callId: string, output: unknown): void {
    this.send({
      type: "conversation.item.create",
      item: { type: "function_call_output", call_id: callId, output: JSON.stringify(output) }
    });
    this.send({ type: "response.create" });
  }
}

export interface TextTutor {
  respond(text: string, signal?: AbortSignal, idempotencyKey?: string): Promise<string>;
  summarize(turns: readonly string[], signal?: AbortSignal): Promise<string>;
}

export class OpenAiTextTutor implements TextTutor {
  constructor(
    private readonly apiKey: string | undefined,
    private readonly model: string,
    private readonly learnerContext = ""
  ) {}

  async respond(text: string, signal?: AbortSignal, idempotencyKey?: string): Promise<string> {
    if (!this.apiKey) return this.deterministicResponse(text);
    return this.request(
      buildTutorInstructions(this.learnerContext),
      text,
      signal,
      idempotencyKey
    );
  }

  async summarize(turns: readonly string[], signal?: AbortSignal): Promise<string> {
    if (turns.length === 0) return "The learner ended before a text exchange was completed.";
    if (!this.apiKey) return `The learner explored a science question through ${turns.length} text turn${turns.length === 1 ? "" : "s"}.`;
    return this.request(
      "Summarize this science tutoring session in under 120 words. Include concepts, evidence of understanding, misconceptions, and the best next step. Do not reproduce the transcript.",
      turns.join("\n"),
      signal
    );
  }

  private async request(
    instructions: string,
    input: string,
    signal?: AbortSignal,
    idempotencyKey?: string
  ): Promise<string> {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {})
      },
      body: JSON.stringify({ model: this.model, instructions, input, max_output_tokens: 500 }),
      signal
    });
    if (!response.ok) throw new Error("Text tutor provider unavailable");
    const parsed = textResponseSchema.parse(await response.json());
    const text = parsed.output_text ?? parsed.output?.flatMap((item) => item.content ?? []).map((content) => content.text).filter(Boolean).join("");
    if (!text) throw new Error("Text tutor returned no content");
    return text;
  }

  private deterministicResponse(text: string): string {
    const topic = text.replaceAll(/\s+/g, " ").trim().slice(0, 160);
    if (/\b(suicide|kill myself|want to die|end my life|take my life|end it all|(?:do not|don['’]t) want to (?:live|be alive)|self[- ]?harm)\b/iu.test(topic)) {
      return "I can’t help with self-harm instructions. Please move away from anything you could use to hurt yourself and tell a trusted adult now. If you may be in immediate danger, contact local emergency services or a crisis line.";
    }
    if (/\b(build|make|design|assemble|instructions?|steps?|recipe|guide|how to)\b.{0,80}\b(weapon|bomb|explosive|poison|gun|detonator)\b/iu.test(topic)) {
      return "I can’t provide instructions for weapons, explosives, or poisoning. We can safely study the underlying science, such as energy transfer, pressure, or protective engineering, without construction details.";
    }
    if (/\b(mix|combine|heat|make|produce|pour(?:ing)?|add(?:ing)?|synthesize)\b.{0,80}\b(bleach|ammonia|chlorine gas|toxic gas|thermite|explosive|strong acid)\b/iu.test(topic)) {
      return "I can’t provide steps for dangerous chemical reactions or experiments. Do not mix household chemicals. We can safely study reaction energy, gases, or laboratory risk assessment without actionable procedures.";
    }
    if (/\b(diagnose|dose|dosage|prescribe|overdose)\b/iu.test(topic)) {
      return "I can explain general health science, but I can’t diagnose you or provide individualized dosing. Ask a qualified clinician or pharmacist, and contact emergency services or poison control if there may be immediate danger.";
    }
    if (/\b(explicit sex|sexualize|sexual content|pornograph)/iu.test(topic)) {
      return "I can help with factual, age-appropriate, non-graphic human biology, but I can’t provide explicit or sexualized content.";
    }
    return `Let’s investigate “${topic}” scientifically. First identify what changes, what can be measured, and what should stay controlled. Then make a prediction and compare it with evidence. Which part would you like to define first: the mechanism, a measurable example, or a testable prediction?`;
  }
}
