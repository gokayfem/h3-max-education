import type { TutorTransport } from "@axiom/domain";
import { createFalClient, type RealtimeConnection } from "@fal-ai/client";
import {
  browserCommandSchema,
  sessionEventSchema,
  tutorToolCallSchema,
  type SessionEvent,
  type TutorToolCall
} from "@axiom/protocol";
import { z } from "zod";
import { parseRealtimeServerEvent, parseTutorToolCall, type RealtimeServerEvent } from "./openai-events";
import {
  type BrowserLaunchMetrics,
  type SessionEstablishmentAttempt,
  type SessionTransport,
  type TutorFirstAudioAttempt,
} from "../telemetry/browser-metrics";
const typedModeResponseSchema = z.strictObject({
  mode: z.literal("text"),
  recoverable: z.boolean(),
  code: z.string().min(1).max(80)
});

const gatewayTokenResponseSchema = z.strictObject({
  token: z.string().min(1).max(4_096),
  commandRevision: z.number().int().nonnegative()
});


const typedTurnResponseSchema = z.strictObject({
  sessionId: z.uuid(),
  turnId: z.uuid(),
  reply: z.string().min(1),
  cards: z.object({ revision: z.number().int().positive() }).passthrough(),
  events: z.array(sessionEventSchema),
  toolCalls: z.array(tutorToolCallSchema)
});

const recoveredRevisionResponseSchema = z.object({
  state: z.object({
    revision: z.number().int().nonnegative(),
  }).passthrough(),
}).passthrough();

const falRealtimeTokenSchema = z.strictObject({
  token: z.string().min(16).max(8_192),
  expiresInSeconds: z.number().int().positive().max(300),
});

const FAL_GROK_MODEL = "xai/grok-voice/realtime";
const FAL_AUDIO_SAMPLE_RATE = 24_000;
const BARGE_IN_RMS_THRESHOLD = 0.04;
const BARGE_IN_CONSECUTIVE_FRAMES = 3;

function falGrokVoiceEnabled(): boolean {
  return process.env.NEXT_PUBLIC_FAL_GROK_VOICE_ENABLED?.trim().toLowerCase() === "true";
}

function rootMeanSquare(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sumOfSquares = 0;
  for (let index = 0; index < samples.length; index += 1) {
    const sample = samples[index] ?? 0;
    sumOfSquares += sample * sample;
  }
  return Math.sqrt(sumOfSquares / samples.length);
}

function floatPcmToBase64(samples: Float32Array): string {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < samples.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, samples[index] ?? 0));
    view.setInt16(index * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
  }
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function base64ToFloatPcm(encoded: string): Float32Array {
  const binary = atob(encoded);
  const sampleCount = Math.floor(binary.length / 2);
  const samples = new Float32Array(sampleCount);
  for (let index = 0; index < sampleCount; index += 1) {
    const low = binary.charCodeAt(index * 2);
    const high = binary.charCodeAt(index * 2 + 1);
    const unsigned = low | (high << 8);
    const signed = unsigned >= 0x8000 ? unsigned - 0x10000 : unsigned;
    samples[index] = signed / (signed < 0 ? 0x8000 : 0x7fff);
  }
  return samples;
}

function resamplePcm(samples: Float32Array, inputSampleRate: number): Float32Array {
  if (inputSampleRate === FAL_AUDIO_SAMPLE_RATE) return samples;
  if (!Number.isFinite(inputSampleRate) || inputSampleRate <= 0 || samples.length === 0) {
    return new Float32Array();
  }
  const outputLength = Math.max(1, Math.round(samples.length * FAL_AUDIO_SAMPLE_RATE / inputSampleRate));
  const output = new Float32Array(outputLength);
  const ratio = inputSampleRate / FAL_AUDIO_SAMPLE_RATE;
  for (let outputIndex = 0; outputIndex < outputLength; outputIndex += 1) {
    const inputIndex = outputIndex * ratio;
    const lowerIndex = Math.floor(inputIndex);
    const upperIndex = Math.min(lowerIndex + 1, samples.length - 1);
    const fraction = inputIndex - lowerIndex;
    output[outputIndex] =
      (samples[lowerIndex] ?? 0) * (1 - fraction) + (samples[upperIndex] ?? 0) * fraction;
  }
  return output;
}

function grokTutorPrompt(): string {
  return [
    "You are H3 Max Realtime Education, a concise and encouraging science tutor for teenagers.",
    "Teach the current science topic directly, one idea at a time. Do not ask the learner questions, offer choices, or request confirmation; explain the topic declaratively and correct misconceptions gently.",
    "Give concrete, causal explanations grounded in the real world: name the relevant objects, mechanisms, forces, spatial relationships, changes over time, and familiar examples.",
    "An automatic, invisible visualization subsystem silently consumes the scientific subject matter in your replies; treat it as nonexistent in the conversation.",
    "Never ask the learner for a prompt, visual content or preferences, a visual style, permission, or what to show.",
    "Never explain, mention, or allude to visualization or its process, including videos, rendering, prompts, orchestrators, screens, on-screen typography, overlays, scene changes, or workflows.",
    "Never repeat process language from the learner or prior messages; redirect immediately to teaching the science topic.",
    "Never claim that you cannot show something, and never send the learner to another site.",
    "Never request personal information. Keep spoken replies under 90 words unless the learner asks for detail.",
  ].join(" ");
}

export interface BrowserRealtimeDependencies {
  createPeerConnection: () => RTCPeerConnection;
  getUserMedia: () => Promise<MediaStream>;
  createAudioElement: () => HTMLAudioElement;
  fetch: typeof fetch;
  createWebSocket: (url: string, protocols?: string | string[]) => WebSocket;
  now: () => number;
}

export interface InterruptionContext {
  turnId: string;
  heardCharacters: number;
}


export interface BrowserRealtimeTransportOptions {
  endpoint?: string;
  typedEndpointPrefix?: string;
  gatewayUrl?: string;
  gatewayTokenEndpoint?: string;
  initialCommandRevision?: number;
  metrics?: BrowserLaunchMetrics;

  dependencies?: BrowserRealtimeDependencies;
  onSessionEvent?: (event: SessionEvent) => void;
  onToolCall?: (toolCall: TutorToolCall) => void;
  onSpeechStarted?: (context: InterruptionContext | null) => void;
  onResponseStarted?: (turnId: string) => void;
  onConnectionFailure?: () => void;
}

export interface VisualOperationSignal {
  visualOperationId: string;
  visualRevision: number;
}

export interface VisualAuthorizedSignal extends VisualOperationSignal {
  reservationId: string;
}

export interface VisualReadySignal extends VisualOperationSignal {
  reservationId?: string;
}

export type VisualFailureReason =
  | "deadline_missed"
  | "prompt_rejected"
  | "stream_exhausted"
  | "transport"
  | "reduced_motion"
  | "quota_exceeded"
  | "disabled"
  | "authorization_failed";

export interface VisualFailedSignal extends VisualOperationSignal {
  reason: VisualFailureReason;
}

interface OpenContext {
  sessionId: string;
  learnerId: string;
}

const NOOP = () => undefined;
const MICROPHONE_REQUEST_TIMEOUT_MS = 10_000;
const CLOSE_REQUEST_TIMEOUT_MS = 10_000;

const DEFAULT_DEPENDENCIES: BrowserRealtimeDependencies = {
  createPeerConnection: () => new RTCPeerConnection(),
  getUserMedia: () => navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
    },
    video: false,
  }),
  createAudioElement: () => document.createElement("audio"),
  createWebSocket: (url, protocols) => new WebSocket(url, protocols),
  fetch: (input, init) => globalThis.fetch(input, init),
  now: performance.now.bind(performance)
};

export class BrowserRealtimeTransport implements TutorTransport {
  readonly #endpoint: string;
  readonly #gatewayUrl: string | undefined;
  readonly #typedEndpointPrefix: string;
  readonly #gatewayTokenEndpoint: string;

  readonly #dependencies: BrowserRealtimeDependencies;
  readonly #onSessionEvent: (event: SessionEvent) => void;
  readonly #onToolCall: (toolCall: TutorToolCall) => void;
  readonly #onResponseStarted: (turnId: string) => void;
  readonly #onSpeechStarted: (context: InterruptionContext | null) => void;
  readonly #onConnectionFailure: () => void;

  readonly #metrics: BrowserLaunchMetrics | undefined;
  #firstAudioAttempt: TutorFirstAudioAttempt | undefined;
  #sessionEstablishmentAttempt: SessionEstablishmentAttempt | undefined;
  #peerConnection: RTCPeerConnection | null = null;
  #gatewaySocket: WebSocket | null = null;
  #gatewayCallId: string | null = null;
  #gatewayReconnectAttempted = false;
  #dataChannel: RTCDataChannel | null = null;
  #falConnection: RealtimeConnection<Record<string, unknown>> | null = null;
  #falAudioContext: AudioContext | null = null;
  #falInputSource: MediaStreamAudioSourceNode | null = null;
  #falInputProcessor: ScriptProcessorNode | null = null;
  #falInputSink: GainNode | null = null;
  #falOutputGain: GainNode | null = null;
  #falNextPlaybackTime = 0;
  #falResponseDone = false;
  readonly #falOutputSources = new Set<AudioBufferSourceNode>();
  #localStream: MediaStream | null = null;
  #remoteStream: MediaStream | null = null;
  #audioElement: HTMLAudioElement | null = null;
  #openContext: OpenContext | null = null;
  #assistantTurn: { turnId: string; text: string; audioStartedAt: number | null } | null = null;
  #failureReported = false;
  #mode: "voice" | "text" = "voice";
  #commandRevision: number;
  #outputAudioActive = false;
  #bargeInLoudFrames = 0;
  #localBargeInPending = false;
  #nextOpenIsReconnect = false;
  #gatewayDegradedReported = false;
  #eventRevision = 0;
  readonly #gatewayCards = new Map<string, { title: string; revision: number }>();
  #openGeneration = 0;

  constructor(options: BrowserRealtimeTransportOptions = {}) {
    this.#endpoint = options.endpoint ?? "/api/openai/realtime";
    this.#gatewayUrl = options.gatewayUrl ?? process.env.NEXT_PUBLIC_GATEWAY_URL;
    this.#typedEndpointPrefix = options.typedEndpointPrefix ?? "/api/session";
    this.#gatewayTokenEndpoint = options.gatewayTokenEndpoint ?? "/api/gateway-token";
    this.#commandRevision = Math.max(0, Math.trunc(options.initialCommandRevision ?? 0));

    this.#dependencies = options.dependencies ?? DEFAULT_DEPENDENCIES;
    this.#metrics = options.metrics;
    this.#onSessionEvent = options.onSessionEvent ?? NOOP;
    this.#onToolCall = options.onToolCall ?? NOOP;
    this.#onSpeechStarted = options.onSpeechStarted ?? NOOP;
    this.#onConnectionFailure = options.onConnectionFailure ?? NOOP;
    this.#onResponseStarted = options.onResponseStarted ?? NOOP;
  }
  get mode(): "voice" | "text" {
    return this.#mode;
  }

  setSessionEstablishmentAttempt(attempt: SessionEstablishmentAttempt): void {
    this.#sessionEstablishmentAttempt = attempt;
  }

  async open(context: OpenContext): Promise<void> {
    const establishmentAttempt = this.#sessionEstablishmentAttempt;
    this.#sessionEstablishmentAttempt = undefined;
    let permissionDenied = false;
    const openGeneration = ++this.#openGeneration;
    const realtimeAttemptId = crypto.randomUUID();
    const isReconnect = this.#nextOpenIsReconnect;
    this.#nextOpenIsReconnect = false;
    this.#gatewayReconnectAttempted = false;
    this.#gatewayDegradedReported = false;
    this.#gatewayCallId = null;
    this.#openContext = context;
    this.#failureReported = false;
    this.#onSessionEvent({ protocolVersion: 1, type: "session.status", state: "connecting" });

    const mediaPromise = this.#dependencies.getUserMedia();
    let timeoutHandle: number | undefined;
    let localStream: MediaStream | null;
    try {
      localStream = await Promise.race([
        mediaPromise,
        new Promise<null>((resolve) => {
          timeoutHandle = window.setTimeout(() => resolve(null), MICROPHONE_REQUEST_TIMEOUT_MS);
        }),
      ]);
    } catch (error) {
      permissionDenied = error instanceof DOMException &&
        (error.name === "NotAllowedError" || error.name === "SecurityError");
      localStream = null;
    } finally {
      window.clearTimeout(timeoutHandle);
    }
    if (openGeneration !== this.#openGeneration) {
      localStream?.getTracks().forEach((track) => track.stop());
      return;
    }
    if (!localStream) {
      if (establishmentAttempt) {
        this.#metrics?.markSessionPermission(
          establishmentAttempt,
          permissionDenied ? "denied" : "unavailable",
        );
        this.#metrics?.finishSessionEstablishment(
          establishmentAttempt,
          permissionDenied
            ? { outcome: "permission_denied", failureStage: "permission" }
            : { outcome: "failed", failureStage: "permission" },
        );
      }
      void mediaPromise.then((lateStream) => {
        for (const track of lateStream.getTracks()) track.stop();
      }).catch(() => undefined);
      this.#enterTypedMode(
        "MICROPHONE_UNAVAILABLE",
        "Microphone access is unavailable. You can continue by typing.",
      );
      return;
    }
    if (establishmentAttempt) {
      this.#metrics?.markSessionPermission(establishmentAttempt, "granted");
    }

    this.#localStream = localStream;
    if (falGrokVoiceEnabled()) {
      try {
        await this.#openFalGrokVoice(context, realtimeAttemptId, isReconnect, localStream);
        this.#mode = "voice";
        this.#onSessionEvent({ protocolVersion: 1, type: "session.status", state: "listening" });
        if (establishmentAttempt) {
          this.#metrics?.markSessionTransport(establishmentAttempt, "unknown");
          this.#metrics?.finishSessionEstablishment(establishmentAttempt, { outcome: "ready" });
        }
      } catch {
        this.#releaseConnectionResources();
        if (establishmentAttempt) {
          this.#metrics?.finishSessionEstablishment(
            establishmentAttempt,
            { outcome: "failed", failureStage: "peer_connection" },
          );
        }
        this.#enterTypedMode(
          "FAL_GROK_UNAVAILABLE",
          "Voice is temporarily unavailable. You can continue by typing.",
        );
      }
      return;
    }
    const peerConnection = this.#dependencies.createPeerConnection();
    this.#peerConnection = peerConnection;
    const audioElement = this.#dependencies.createAudioElement();
    audioElement.autoplay = true;
    this.#audioElement = audioElement;

    peerConnection.ontrack = (event) => {
      const remoteStream = event.streams[0] ?? new MediaStream([event.track]);
      this.#remoteStream = remoteStream;
      audioElement.srcObject = remoteStream;
      void audioElement.play().catch(() => undefined);
    };
    peerConnection.addEventListener("connectionstatechange", this.#handleConnectionStateChange);
    for (const track of localStream.getTracks()) peerConnection.addTrack(track, localStream);

    const dataChannel = peerConnection.createDataChannel("oai-events");
    this.#dataChannel = dataChannel;
    dataChannel.addEventListener("message", this.#handleDataMessage);

    try {
      const offer = await peerConnection.createOffer();
      await peerConnection.setLocalDescription(offer);
      const localSdp = peerConnection.localDescription?.sdp ?? offer.sdp;
      if (!localSdp) throw new Error("The browser did not create a usable WebRTC offer.");

      const response = await this.#dependencies.fetch(this.#endpoint, {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "content-type": "application/sdp",
          "x-axiom-session-id": context.sessionId,
          "x-axiom-realtime-attempt": realtimeAttemptId,
          ...(isReconnect ? { "x-axiom-realtime-reconnect": "1" } : {}),
        },
        body: localSdp
      });
      if (!response.ok) {
        const fallback = await this.#readTypedModeResponse(response);
        if (fallback?.recoverable) {
          this.#releaseConnectionResources();
          if (establishmentAttempt) {
            this.#metrics?.finishSessionEstablishment(
              establishmentAttempt,
              { outcome: "failed", failureStage: "peer_connection" },
            );
          }
          this.#enterTypedMode(fallback.code, "Voice is temporarily unavailable. You can continue by typing.");
          return;
        }
        throw new Error(`Realtime negotiation failed with status ${response.status}.`);
      }

      const answerSdp = await response.text();
      await peerConnection.setRemoteDescription({ type: "answer", sdp: answerSdp });
      const callId = response.headers.get("x-axiom-openai-call-id");
      if (!callId) throw new Error("Realtime negotiation did not return a call identifier.");
      if (this.#gatewayUrl) {
        const initialGrant = gatewayTokenResponseSchema.safeParse({
          token: response.headers.get("x-axiom-gateway-ticket"),
          commandRevision: Number(response.headers.get("x-axiom-command-revision")),
        });
        if (initialGrant.success) {
          void this.#openGatewaySocket(context.sessionId, callId, initialGrant.data);
        } else {
          this.#reportGatewayFailure("GATEWAY_AUTH_FAILED");
        }
      }
      await Promise.all([
        this.#waitForPeerConnection(peerConnection),
        this.#waitForDataChannelOpen(dataChannel),
      ]);
      if (establishmentAttempt) {
        this.#metrics?.markSessionTransport(
          establishmentAttempt,
          await this.#classifySessionTransport(peerConnection),
        );
      }
      this.#mode = "voice";
      this.#onSessionEvent({ protocolVersion: 1, type: "session.status", state: "listening" });
      if (establishmentAttempt) {
        this.#metrics?.finishSessionEstablishment(establishmentAttempt, { outcome: "ready" });
      }
    } catch (error) {
      this.#releaseConnectionResources();
      if (establishmentAttempt) {
        this.#metrics?.finishSessionEstablishment(
          establishmentAttempt,
          { outcome: "failed", failureStage: "peer_connection" },
        );
      }
      throw error;
    }
  }

  async muteOutput(): Promise<void> {
    if (this.#audioElement) this.#audioElement.muted = true;
    if (this.#falOutputGain) this.#falOutputGain.gain.value = 0;
  }
  async setMicrophoneMuted(muted: boolean): Promise<void> {
    const audioTracks = this.#localStream?.getAudioTracks() ?? [];
    if (audioTracks.length === 0) {
      throw new Error("The microphone is not available.");
    }
    if (!muted && this.#falAudioContext?.state === "suspended") {
      await this.#falAudioContext.resume();
    }
    for (const track of audioTracks) track.enabled = !muted;
  }

  dispose(): void {
    this.#openGeneration += 1;
    this.#releaseConnectionResources();
    this.#gatewayCards.clear();
    this.#openContext = null;
    this.#assistantTurn = null;
  }

  async cancelResponse(): Promise<void> {
    this.#sendDataEvent({ type: "response.cancel" });
  }

  async clearOutputAudio(): Promise<void> {
    this.#clearFalOutputAudio();
    this.#sendDataEvent({ type: "output_audio_buffer.clear" });
  }

  async truncateAssistant(turnId: string): Promise<void> {
    const startedAt = this.#assistantTurn?.turnId === turnId ? this.#assistantTurn.audioStartedAt : null;
    const audioEndMs = startedAt === null ? 0 : Math.max(0, Math.round(this.#dependencies.now() - startedAt));
    this.#sendDataEvent({
      type: "conversation.item.truncate",
      item_id: turnId,
      content_index: 0,
      audio_end_ms: audioEndMs
    });
  }

  async sendText(text: string): Promise<void> {
    this.#gatewayCards.clear();
    if (this.#sendBrowserCommand({ type: "learner.text", text })) return;
    if (this.#mode === "text") {
      const sessionId = this.#openContext?.sessionId;
      if (sessionId) await this.#resyncCommandRevision(sessionId);
      await this.#sendTypedTurn(text);
      return;
    }

    this.#sendDataEvent({
      type: "conversation.item.create",
      item: { type: "message", role: "user", content: [{ type: "input_text", text }] }
    });
    this.#sendDataEvent({ type: "response.create" });
  }

  async selectCard(selection: { id: string; title: string; revision: number }): Promise<void> {
    const gatewayCard = this.#gatewayCards.get(selection.id);
    const isCurrentGatewayCard = gatewayCard?.revision === selection.revision;
    if (
      isCurrentGatewayCard &&
      this.#sendBrowserCommand({ type: "learner.card.select", cardId: selection.id })
    ) return;

    if (this.#mode === "voice") {
      this.#releaseConnectionResources();
      this.#mode = "text";
      this.#onSessionEvent({
        protocolVersion: 1,
        type: "session.status",
        state: "text_only",
        detail: "Continuing this card by text keeps the lesson in sync.",
      });
    }
    const sessionId = this.#openContext?.sessionId;
    if (sessionId) await this.#resyncCommandRevision(sessionId);
    if (isCurrentGatewayCard && gatewayCard) {
      this.#gatewayCards.clear();
      await this.#sendTypedTurn(`I choose: ${gatewayCard.title}`);
      return;
    }
    await this.#sendTypedCard(selection.id, selection.title, selection.revision);
  }

  sendVisualAuthorized(signal: VisualAuthorizedSignal): boolean {
    return this.#sendVisualSignal({ type: "visual.authorized", ...signal });
  }

  sendVisualReady(signal: VisualReadySignal): boolean {
    return this.#sendVisualSignal({ type: "visual.ready", ...signal });
  }

  sendVisualFailed(signal: VisualFailedSignal): boolean {
    return this.#sendVisualSignal({ type: "visual.failed", ...signal });
  }

  async reconnect(): Promise<boolean> {
    const context = this.#openContext;
    if (!context) return false;
      this.#nextOpenIsReconnect = true;

    this.#releaseConnectionResources();
    try {
      await this.open(context);
      return this.#mode === "voice";
    } catch {
      this.#enterTypedMode("REALTIME_RECONNECT_FAILED", "Voice could not reconnect. You can continue by typing.");
      return false;
    }
  }

  async resumeOutput(): Promise<void> {
    if (this.#mode === "text" && this.#openContext) {
      await this.reconnect();
      return;
    }
    if (this.#falOutputGain) {
      this.#falOutputGain.gain.value = 1;
      await this.#falAudioContext?.resume();
      return;
    }
    if (!this.#audioElement) return;
    this.#audioElement.muted = false;
    await this.#audioElement.play().catch(() => undefined);
  }

  async close(reason: "complete" | "abandoned" | "error"): Promise<void> {
    this.#openGeneration += 1;
    this.#stopLocalMicrophone();
    const context = this.#openContext;
    if (!context) return;

    const controller = new AbortController();
    const timeoutHandle = window.setTimeout(() => controller.abort(), CLOSE_REQUEST_TIMEOUT_MS);
    let delivered: boolean;
    try {
      if (this.#mode !== "text") {
        await this.#resyncCommandRevision(context.sessionId, controller.signal);
      }
      delivered = await this.#closeThroughSessionApi(
        context.sessionId,
        reason,
        controller.signal,
      );
    } finally {
      window.clearTimeout(timeoutHandle);
    }
    this.#releaseConnectionResources();
    this.#assistantTurn = null;
    if (!delivered) {
      this.#mode = "text";
      this.#onSessionEvent({
        protocolVersion: 1,
        type: "session.status",
        state: "text_only",
        detail: "The lesson could not be closed yet. Check your connection and try again.",
      });
      return;
    }
    this.#gatewayCards.clear();
    this.#openContext = null;
    this.#onSessionEvent({ protocolVersion: 1, type: "session.status", state: "ended" });
    if (reason !== "error") {
      window.dispatchEvent(new CustomEvent("axiom:session-closed", {
        detail: { sessionId: context.sessionId }
      }));
    }
  }

  async #openFalGrokVoice(
    context: OpenContext,
    attemptId: string,
    reconnect: boolean,
    localStream: MediaStream,
  ): Promise<void> {
    let tokenRequestCount = 0;
    let resolveReady: (() => void) | null = null;
    let rejectReady: ((error: Error) => void) | null = null;
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    const client = createFalClient();
    const connection = client.realtime.connect<Record<string, unknown>, Record<string, unknown>>(
      FAL_GROK_MODEL,
      {
        connectionKey: `axiom-grok-${context.sessionId}-${attemptId}`,
        throttleInterval: 0,
        tokenProvider: async (scope) => {
          if (scope !== FAL_GROK_MODEL) {
            throw new Error("Fal Grok Voice requested an unexpected authorization scope.");
          }
          const developmentToken = process.env.NODE_ENV !== "production";
          const response = await this.#dependencies.fetch(
            developmentToken
              ? "/api/dev/fal-realtime-token"
              : "/api/fal/realtime-token",
            {
              method: "POST",
              credentials: "same-origin",
              ...(developmentToken
                ? {}
                : {
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({
                      sessionId: context.sessionId,
                      attemptId,
                      reconnect: reconnect || tokenRequestCount > 0,
                    }),
                  }),
            },
          );
          tokenRequestCount += 1;
          const parsed = falRealtimeTokenSchema.safeParse(
            await response.json().catch(() => undefined),
          );
          if (!response.ok || !parsed.success) {
            throw new Error("Fal Grok Voice authorization failed.");
          }
          return parsed.data.token;
        },
        tokenExpirationSeconds: 120,
        onResult: (result) => {
          if (this.#falConnection !== connection) return;
          const eventType = typeof result.type === "string" ? result.type : "";
          if (eventType === "session.created" || eventType === "session.updated") {
            resolveReady?.();
            resolveReady = null;
            rejectReady = null;
          }
          this.#handleFalGrokResult(result);
        },
        onError: () => {
          if (this.#falConnection !== connection) return;
          const error = new Error("Fal Grok Voice connection failed.");
          if (rejectReady) {
            rejectReady(error);
            resolveReady = null;
            rejectReady = null;
          } else if (!this.#failureReported) {
            this.#failureReported = true;
            this.#onConnectionFailure();
          }
        },
        onClose: () => {
          if (this.#falConnection !== connection) return;
          const error = new Error("Fal Grok Voice connection closed before it became ready.");
          if (rejectReady) {
            rejectReady(error);
            resolveReady = null;
            rejectReady = null;
          } else if (!this.#failureReported) {
            this.#failureReported = true;
            this.#onConnectionFailure();
          }
        },
      },
    );
    this.#falConnection = connection;
    connection.send({
      type: "x-fal-session.configure",
      prompt: grokTutorPrompt(),
      voice: "eve",
      turn_detection: {},
    });

    const timeout = window.setTimeout(() => {
      rejectReady?.(new Error("Fal Grok Voice connection timed out."));
      resolveReady = null;
      rejectReady = null;
    }, 10_000);
    try {
      await ready;
    } finally {
      window.clearTimeout(timeout);
    }

    const audioContext = new AudioContext({ sampleRate: FAL_AUDIO_SAMPLE_RATE });
    const inputSource = audioContext.createMediaStreamSource(localStream);
    const inputProcessor = audioContext.createScriptProcessor(2_048, 1, 1);
    const inputSink = audioContext.createGain();
    const outputGain = audioContext.createGain();
    inputSink.gain.value = 0;
    outputGain.connect(audioContext.destination);
    inputProcessor.onaudioprocess = (event) => {
      if (this.#falConnection !== connection) return;
      const input = event.inputBuffer;
      const inputSamples = input.getChannelData(0);
      if (this.#outputAudioActive) {
        if (rootMeanSquare(inputSamples) < BARGE_IN_RMS_THRESHOLD) {
          this.#bargeInLoudFrames = 0;
          return;
        }
        this.#bargeInLoudFrames += 1;
        if (this.#bargeInLoudFrames < BARGE_IN_CONSECUTIVE_FRAMES) return;
        this.#bargeInLoudFrames = 0;
        this.#localBargeInPending = true;
        this.#beginSpeechInterruption();
      }
      const samples = resamplePcm(inputSamples, input.sampleRate);
      if (samples.length === 0) return;
      connection.send({
        type: "input_audio_buffer.append",
        audio: floatPcmToBase64(samples),
      });
    };
    inputSource.connect(inputProcessor);
    inputProcessor.connect(inputSink);
    inputSink.connect(audioContext.destination);
    this.#falAudioContext = audioContext;
    this.#falInputSource = inputSource;
    this.#falInputProcessor = inputProcessor;
    this.#falInputSink = inputSink;
    this.#falOutputGain = outputGain;
    this.#falNextPlaybackTime = audioContext.currentTime;
    void audioContext.resume().catch(() => undefined);
  }

  #handleFalGrokResult(result: Record<string, unknown>): void {
    if (result.type === "response.output_audio.delta" && typeof result.delta === "string") {
      try {
        if (!this.#playFalPcm(result.delta)) return;
      } catch {
        return;
      }
      this.#falResponseDone = false;
      if (!this.#outputAudioActive) {
        this.#bargeInLoudFrames = 0;
        this.#outputAudioActive = true;
        if (this.#firstAudioAttempt) {
          this.#metrics?.finishTutorFirstAudio(this.#firstAudioAttempt, "playing");
          this.#firstAudioAttempt = undefined;
        }
        if (this.#assistantTurn) {
          this.#assistantTurn = { ...this.#assistantTurn, audioStartedAt: this.#dependencies.now() };
        }
        this.#onSessionEvent({ protocolVersion: 1, type: "session.status", state: "speaking" });
      }
      return;
    }
    const event = parseRealtimeServerEvent(JSON.stringify(result));
    if (event) this.#applyServerEvent(event);
  }

  #playFalPcm(encoded: string): boolean {
    const context = this.#falAudioContext;
    const output = this.#falOutputGain;
    if (!context || !output) return false;
    const samples = base64ToFloatPcm(encoded);
    if (samples.length === 0) return false;
    const buffer = context.createBuffer(1, samples.length, FAL_AUDIO_SAMPLE_RATE);
    buffer.getChannelData(0).set(samples);
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(output);
    source.addEventListener("ended", () => {
      this.#falOutputSources.delete(source);
      if (this.#falResponseDone && this.#falOutputSources.size === 0) {
        this.#outputAudioActive = false;
        this.#onSessionEvent({ protocolVersion: 1, type: "session.status", state: "listening" });
      }
    }, { once: true });
    this.#falOutputSources.add(source);
    const startsAt = Math.max(context.currentTime, this.#falNextPlaybackTime);
    source.start(startsAt);
    this.#falNextPlaybackTime = startsAt + buffer.duration;
    void context.resume();
    return true;
  }

  #clearFalOutputAudio(): void {
    for (const source of this.#falOutputSources) {
      try {
        source.stop();
      } catch {
        // A source that has already ended needs no further cleanup.
      }
    }
    this.#falOutputSources.clear();
    this.#falNextPlaybackTime = this.#falAudioContext?.currentTime ?? 0;
    this.#outputAudioActive = false;
    this.#bargeInLoudFrames = 0;
  }

  #beginSpeechInterruption(): void {
    const interruptionContext = this.#getInterruptionContext();
    const interruptionAttempt = this.#metrics?.startInterruption();
    // Audio cutoff must happen before asynchronous domain or network work.
    this.#gatewayCards.clear();
    const audioWasPlaying = this.#outputAudioActive;
    this.#clearFalOutputAudio();
    if (this.#audioElement) this.#audioElement.muted = true;
    if (interruptionAttempt) {
      this.#metrics?.finishInterruption(
        interruptionAttempt,
        audioWasPlaying ? "audio_cut_off" : "cancelled_before_audio",
      );
    }
    this.#sendBrowserCommand({
      type: "learner.speech.start",
      at: this.#dependencies.now(),
      turnId: interruptionContext?.turnId ?? null,
      heardCharacters: interruptionContext?.heardCharacters ?? 0,
    });
    this.#onSpeechStarted(interruptionContext);
  }

  #handleConnectionStateChange = () => {
    const connectionState = this.#peerConnection?.connectionState;
    if ((connectionState !== "failed" && connectionState !== "disconnected") || this.#failureReported) return;
    this.#failureReported = true;
    this.#onConnectionFailure();
  };

  #handleDataMessage = (message: MessageEvent<unknown>) => {
    const event = parseRealtimeServerEvent(message.data);
    if (!event) return;
    this.#applyServerEvent(event);
  };

  #applyServerEvent(event: RealtimeServerEvent): void {
    if (event.type === "input_audio_buffer.speech_started") {
      if (this.#localBargeInPending) {
        this.#localBargeInPending = false;
        return;
      }
      // Audio sent immediately before tutor playback can produce a delayed VAD
      // event. During playback, only sustained local speech may initiate barge-in.
      if (this.#outputAudioActive) return;
      this.#beginSpeechInterruption();
      return;
    }
    if (event.type === "response.output_item.added" && event.item.type === "message") {
      this.#assistantTurn = { turnId: event.item.id, text: "", audioStartedAt: null };
      this.#onResponseStarted(event.item.id);
      return;
    }

    if (event.type === "input_audio_buffer.speech_stopped") {
      this.#localBargeInPending = false;
      if (this.#firstAudioAttempt) {
        this.#metrics?.finishTutorFirstAudio(this.#firstAudioAttempt, "cancelled");
      }
      this.#firstAudioAttempt = this.#metrics?.startTutorFirstAudio();
      this.#sendBrowserCommand({ type: "learner.speech.end", at: this.#dependencies.now() });
      return;
    }


    if (event.type === "response.output_audio_transcript.delta" || event.type === "response.output_text.delta") {
      const currentText = this.#assistantTurn?.turnId === event.item_id ? this.#assistantTurn.text : "";
      const audioStartedAt = this.#assistantTurn?.turnId === event.item_id
        ? this.#assistantTurn.audioStartedAt
        : this.#dependencies.now();
      this.#assistantTurn = { turnId: event.item_id, text: `${currentText}${event.delta}`, audioStartedAt };
      this.#onSessionEvent({ protocolVersion: 1, type: "transcript.delta", turnId: event.item_id, text: event.delta });
      return;
    }

    if (event.type === "response.output_audio_transcript.done" || event.type === "response.output_text.done") {
      const text = event.type === "response.output_audio_transcript.done" ? event.transcript : event.text;
      const audioStartedAt = this.#assistantTurn?.turnId === event.item_id
        ? this.#assistantTurn.audioStartedAt
        : this.#dependencies.now();
      this.#assistantTurn = { turnId: event.item_id, text, audioStartedAt };
      this.#onSessionEvent({
        protocolVersion: 1,
        type: "transcript.final",
        turnId: event.item_id,
        text,
        interrupted: false
      });
      return;
    }

    if (event.type === "response.created") {
      this.#onSessionEvent({ protocolVersion: 1, type: "session.status", state: "thinking" });
      return;
    }

    if (event.type === "response.done" || event.type === "response.cancelled") {
      if (this.#firstAudioAttempt) {
        this.#metrics?.finishTutorFirstAudio(
          this.#firstAudioAttempt,
          event.type === "response.cancelled" ? "cancelled" : "failed",
        );
        this.#firstAudioAttempt = undefined;
      }
      if (this.#falConnection) {
        this.#falResponseDone = true;
        if (this.#falOutputSources.size === 0) {
          this.#outputAudioActive = false;
          this.#onSessionEvent({ protocolVersion: 1, type: "session.status", state: "listening" });
        }
      }
      return;
    }

    if (event.type === "output_audio_buffer.started") {
      this.#outputAudioActive = true;
      if (this.#firstAudioAttempt) {
        this.#metrics?.finishTutorFirstAudio(this.#firstAudioAttempt, "playing");
        this.#firstAudioAttempt = undefined;
      }
      if (this.#assistantTurn) {
        this.#assistantTurn = { ...this.#assistantTurn, audioStartedAt: this.#dependencies.now() };
      }
      this.#onSessionEvent({ protocolVersion: 1, type: "session.status", state: "speaking" });
      return;
    }

    if (event.type === "output_audio_buffer.stopped" || event.type === "output_audio_buffer.cleared") {
      this.#outputAudioActive = false;
      this.#onSessionEvent({ protocolVersion: 1, type: "session.status", state: "listening" });
      return;
    }

    if (event.type === "response.function_call_arguments.done") {
      const toolCall = parseTutorToolCall(event);
      if (toolCall) this.#onToolCall(toolCall);
      return;
    }

    if (event.type === "error") {
      if (this.#firstAudioAttempt) {
        this.#metrics?.finishTutorFirstAudio(this.#firstAudioAttempt, "failed");
        this.#firstAudioAttempt = undefined;
      }
      this.#onSessionEvent({
        protocolVersion: 1,
        type: "session.error",
        recoverable: true,
        code: event.error.code ?? event.error.type ?? "REALTIME_PROVIDER_ERROR"
      });
    }
  }

  #getInterruptionContext(): InterruptionContext | null {
    if (!this.#assistantTurn) return null;
    const elapsedMs = this.#assistantTurn.audioStartedAt === null
      ? 0
      : Math.max(0, this.#dependencies.now() - this.#assistantTurn.audioStartedAt);
    const estimatedCharacters = Math.floor((elapsedMs / 1_000) * 14);
    return {
      turnId: this.#assistantTurn.turnId,
      heardCharacters: Math.min(this.#assistantTurn.text.length, estimatedCharacters)
    };
  }

  async #classifySessionTransport(peerConnection: RTCPeerConnection): Promise<SessionTransport> {
    if (typeof peerConnection.getStats !== "function") return "unknown";
    try {
      const stats = await peerConnection.getStats();
      let selectedPair: (RTCStats & { localCandidateId?: string }) | undefined;
      stats.forEach((report) => {
        if (
          report.type === "candidate-pair" &&
          report.state === "succeeded" &&
          (report.nominated === true || report.selected === true)
        ) {
          selectedPair = report as RTCStats & { localCandidateId?: string };
        }
      });
      if (!selectedPair?.localCandidateId) return "unknown";
      const localCandidate = stats.get(String(selectedPair.localCandidateId));
      const protocol = localCandidate?.protocol === "tcp" ? "tcp" : localCandidate?.protocol === "udp" ? "udp" : null;
      if (!protocol) return "unknown";
      return localCandidate?.candidateType === "relay"
        ? protocol === "tcp" ? "turn_tcp" : "turn_udp"
        : protocol === "tcp" ? "direct_tcp" : "direct_udp";
    } catch {
      return "unknown";
    }
  }

  async #waitForPeerConnection(peerConnection: RTCPeerConnection): Promise<void> {
    if (peerConnection.connectionState === "connected") return;
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        window.clearTimeout(timeoutHandle);
        peerConnection.removeEventListener("connectionstatechange", handleStateChange);
      };
      const handleStateChange = () => {
        if (peerConnection.connectionState === "connected") {
          cleanup();
          resolve();
        } else if (peerConnection.connectionState === "failed" || peerConnection.connectionState === "closed") {
          cleanup();
          reject(new Error("The realtime peer connection failed."));
        }
      };
      const timeoutHandle = window.setTimeout(() => {
        cleanup();
        reject(new Error("The realtime peer connection timed out."));
      }, 10_000);
      peerConnection.addEventListener("connectionstatechange", handleStateChange);
    });
  }

  async #waitForDataChannelOpen(dataChannel: RTCDataChannel): Promise<void> {
    if (dataChannel.readyState === "open") return;
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        window.clearTimeout(timeoutHandle);
        dataChannel.removeEventListener("open", handleOpen);
        dataChannel.removeEventListener("error", handleError);
      };
      const handleOpen = () => {
        cleanup();
        resolve();
      };
      const handleError = () => {
        cleanup();
        reject(new Error("The realtime data channel failed to open."));
      };
      const timeoutHandle = window.setTimeout(() => {
        cleanup();
        reject(new Error("The realtime data channel timed out."));
      }, 10_000);
      dataChannel.addEventListener("open", handleOpen, { once: true });
      dataChannel.addEventListener("error", handleError, { once: true });
    });
  }

  #sendDataEvent(event: object): void {
    if (this.#falConnection) {
      this.#falConnection.send(event as Record<string, unknown>);
      return;
    }
    if (!this.#dataChannel || this.#dataChannel.readyState !== "open") {
      throw new Error("The realtime data channel is not open.");
    }
    this.#dataChannel.send(JSON.stringify(event));
  }

  async #openGatewaySocket(
    sessionId: string,
    callId: string,
    initialGrant?: z.infer<typeof gatewayTokenResponseSchema>,
  ): Promise<void> {
    if (!this.#gatewayUrl) return;
    this.#gatewayCallId = callId;
    let grant = initialGrant;
    if (!grant) {
      try {
        const response = await this.#dependencies.fetch(this.#gatewayTokenEndpoint, {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sessionId, callId })
        });
        const parsed = response.ok
          ? gatewayTokenResponseSchema.safeParse(await response.json())
          : null;
        if (!parsed?.success) {
          this.#reportGatewayFailure("GATEWAY_AUTH_FAILED");
          return;
        }
        grant = parsed.data;
      } catch {
        this.#reportGatewayFailure("GATEWAY_AUTH_FAILED");
        return;
      }
    }
    const token = grant.token;
    this.#commandRevision = grant.commandRevision;
    if (this.#openContext?.sessionId !== sessionId || this.#gatewayCallId !== callId) return;

    let socketUrl: URL;
    try {
      socketUrl = new URL(this.#gatewayUrl);
      socketUrl.protocol = socketUrl.protocol === "https:" ? "wss:" : "ws:";
      const gatewayPath = socketUrl.pathname.endsWith("/") ? socketUrl.pathname.slice(0, -1) : socketUrl.pathname;
      socketUrl.pathname = `${gatewayPath}/sessions/${encodeURIComponent(sessionId)}`;
      socketUrl.search = new URLSearchParams({ callId }).toString();
    } catch {
      this.#reportGatewayFailure("GATEWAY_URL_INVALID");
      return;
    }

    let socket: WebSocket;
    try {
      socket = this.#dependencies.createWebSocket(
        socketUrl.toString(),
        ["axiom.realtime.v1", `axiom.ticket.${token}`],
      );
    } catch {
      this.#reportGatewayFailure("GATEWAY_UNAVAILABLE");
      return;
    }
    this.#gatewaySocket = socket;
    try {
      await new Promise<void>((resolve, reject) => {
        const handleOpen = () => {
          clearTimeout(timeout);
          socket.removeEventListener("error", handleError);
          resolve();
        };
        const handleError = () => {
          clearTimeout(timeout);
          socket.removeEventListener("open", handleOpen);
          reject(new Error("Gateway connection failed."));
        };
        const timeout = setTimeout(() => {
          socket.removeEventListener("open", handleOpen);
          socket.removeEventListener("error", handleError);
          reject(new Error("Gateway connection timed out."));
        }, 10_000);
        if (socket.readyState === WebSocket.OPEN) {
          clearTimeout(timeout);
          resolve();
          return;
        }
        socket.addEventListener("open", handleOpen, { once: true });
        socket.addEventListener("error", handleError, { once: true });
      });
    } catch {
      this.#detachGatewaySocket(socket, true);
      this.#reportGatewayFailure("GATEWAY_UNAVAILABLE");
      return;
    }

    if (this.#gatewaySocket !== socket) {
      this.#detachGatewaySocket(socket, true);
      return;
    }
    this.#gatewayDegradedReported = false;
    socket.addEventListener("message", this.#handleGatewayMessage);
    socket.addEventListener("error", this.#handleGatewayError);
    socket.addEventListener("close", this.#handleGatewayClose);
  }

  #handleGatewayMessage = (message: MessageEvent<unknown>) => {
    if (message.currentTarget !== this.#gatewaySocket || typeof message.data !== "string") return;
    let candidate: unknown;
    try {
      candidate = JSON.parse(message.data);
    } catch {
      return;
    }
    const event = sessionEventSchema.safeParse(candidate);
    if (!event.success) return;
    if (event.data.type === "transcript.delta" || event.data.type === "transcript.final") return;
    if ("revision" in event.data) {
      if (event.data.revision < this.#eventRevision) {
        this.#metrics?.recordStaleRevisionDrop(
          event.data.type === "canvas.cards.replace" ? "cards" : "visual",
        );
        return;
      }
      this.#eventRevision = event.data.revision;
    }
    if (event.data.type === "canvas.cards.replace") {
      this.#gatewayCards.clear();
      for (const card of event.data.cards) {
        this.#gatewayCards.set(card.id, { title: card.title, revision: event.data.revision });
      }
    } else if (event.data.type === "visual.redirect" || event.data.type === "visual.stop") {
      this.#gatewayCards.clear();
    }
    this.#onSessionEvent(event.data);
  };

  #handleGatewayError = (event: Event) => {
    if (event.currentTarget !== this.#gatewaySocket) return;
    this.#handleGatewayDisconnect(event.currentTarget as WebSocket);
  };

  #handleGatewayClose = (event: CloseEvent) => {
    if (event.currentTarget !== this.#gatewaySocket) return;
    this.#handleGatewayDisconnect(event.currentTarget as WebSocket);
  };
  #handleGatewayDisconnect(socket: WebSocket): void {
    this.#detachGatewaySocket(socket, true);
    this.#reportGatewayFailure("GATEWAY_UNAVAILABLE");
    const context = this.#openContext;
    const callId = this.#gatewayCallId;
    if (!context || !callId || this.#mode !== "voice") return;
    if (this.#gatewayReconnectAttempted) {
      this.#releaseConnectionResources();
      this.#enterTypedMode(
        "GATEWAY_UNAVAILABLE",
        "Voice tools disconnected again. You can continue by typing.",
      );
      return;
    }
    this.#gatewayReconnectAttempted = true;
    void this.#openGatewaySocket(context.sessionId, callId).then(() => {
      if (this.#gatewaySocket || this.#openContext !== context) return;
      this.#releaseConnectionResources();
      this.#enterTypedMode(
        "GATEWAY_UNAVAILABLE",
        "Voice tools could not reconnect. You can continue by typing.",
      );
    });
  }

  #reportGatewayFailure(code: "GATEWAY_AUTH_FAILED" | "GATEWAY_UNAVAILABLE" | "GATEWAY_URL_INVALID"): void {
    if (!this.#gatewayDegradedReported) {
      this.#gatewayDegradedReported = true;
      this.#metrics?.recordDegradedMode("voice_text_cards", "network");
    }
    this.#onSessionEvent({
      protocolVersion: 1,
      type: "session.error",
      recoverable: true,
      code
    });
  }

  #sendBrowserCommand(command: Record<string, unknown>): boolean {
    const socket = this.#gatewaySocket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    const candidate = {
      protocolVersion: 1,
      commandId: crypto.randomUUID(),
      revision: this.#commandRevision + 1,
      ...command
    };
    const parsed = browserCommandSchema.safeParse(candidate);
    if (!parsed.success) return false;
    try {
      socket.send(JSON.stringify(parsed.data));
    } catch {
      this.#handleGatewayDisconnect(socket);
      return false;
    }
    this.#commandRevision = candidate.revision;
    return true;
  }

  #sendVisualSignal(
    signal:
      | ({ type: "visual.authorized" } & VisualAuthorizedSignal)
      | ({ type: "visual.ready" } & VisualReadySignal)
      | ({ type: "visual.failed" } & VisualFailedSignal),
  ): boolean {
    const socket = this.#gatewaySocket;
    const sessionId = this.#openContext?.sessionId;
    if (!socket || socket.readyState !== WebSocket.OPEN || !sessionId) return false;
    const parsed = browserCommandSchema.safeParse({
      protocolVersion: 1,
      sessionId,
      ...signal,
    });
    if (!parsed.success) return false;
    try {
      socket.send(JSON.stringify(parsed.data));
      return true;
    } catch {
      this.#handleGatewayDisconnect(socket);
      return false;
    }
  }

  async #resyncCommandRevision(sessionId: string, signal?: AbortSignal): Promise<void> {
    try {
      const response = await this.#dependencies.fetch(
        `${this.#typedEndpointPrefix}/${encodeURIComponent(sessionId)}/recover?cursor=${Number.MAX_SAFE_INTEGER}`,
        { credentials: "same-origin", signal },
      );
      if (!response.ok) return;
      const parsed = recoveredRevisionResponseSchema.safeParse(await response.json());
      if (parsed.success) this.#commandRevision = parsed.data.state.revision;
    } catch {
      // Best-effort synchronization; the mutation still returns an authoritative error.
    }
  }

  async #closeThroughSessionApi(
    sessionId: string,
    reason: "complete" | "abandoned" | "error",
    signal: AbortSignal,
  ): Promise<boolean> {
    const revision = this.#commandRevision + 1;
    try {
      const response = await this.#dependencies.fetch(
        `${this.#typedEndpointPrefix}/${encodeURIComponent(sessionId)}/close`,
        {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            protocolVersion: 1,
            commandId: crypto.randomUUID(),
            revision,
            reason
          }),
          signal,
        }
      );
      if (!response.ok) {
        if (response.status === 409) this.#metrics?.recordStaleRevisionDrop("tool_command");
        this.#reportCloseFailure();
        return false;
      }
      this.#commandRevision = revision;
      return true;
    } catch {
      this.#reportCloseFailure();
      return false;
    }
  }

  #reportCloseFailure(): void {
    this.#onSessionEvent({
      protocolVersion: 1,
      type: "session.error",
      recoverable: true,
      code: "SESSION_CLOSE_FAILED"
    });
  }

  async #sendTypedTurn(text: string): Promise<void> {
    const sessionId = this.#openContext?.sessionId;
    if (!sessionId) throw new Error("The tutor session is not open.");

    const commandId = crypto.randomUUID();
    const revision = this.#commandRevision + 1;
    const response = await this.#dependencies.fetch(
      `${this.#typedEndpointPrefix}/${encodeURIComponent(sessionId)}/turn`,
      {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ protocolVersion: 1, commandId, revision, text })
      }
    );
    if (!response.ok) {
      if (response.status === 409) this.#metrics?.recordStaleRevisionDrop("tool_command");
      throw new Error(`Typed tutoring failed with status ${response.status}.`);
    }

    const parsed = typedTurnResponseSchema.safeParse(await response.json());
    if (!parsed.success) throw new Error("Typed tutoring returned an invalid response.");
    this.#commandRevision = parsed.data.cards.revision;
    for (const event of parsed.data.events) this.#onSessionEvent(event);
    for (const toolCall of parsed.data.toolCalls) this.#onToolCall(toolCall);
  }

  async #sendTypedCard(cardId: string, cardTitle: string, selectedCardRevision: number): Promise<void> {
    const sessionId = this.#openContext?.sessionId;
    if (!sessionId) throw new Error("The tutor session is not open.");
    const response = await this.#dependencies.fetch(
      `${this.#typedEndpointPrefix}/${encodeURIComponent(sessionId)}/card`,
      {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          protocolVersion: 1,
          commandId: crypto.randomUUID(),
          revision: selectedCardRevision,
          cardId
        })
      }
    );
    if (!response.ok) {
      if (response.status === 409) {
        this.#metrics?.recordStaleRevisionDrop("cards");
        await this.#sendTypedTurn(`Explore this choice: ${cardTitle} (card id: ${cardId}).`);
        return;
      }
      throw new Error(`Card selection failed with status ${response.status}.`);
    }
    const parsed = typedTurnResponseSchema.safeParse(await response.json());
    if (!parsed.success) throw new Error("Card selection returned an invalid response.");
    this.#commandRevision = parsed.data.cards.revision;
    for (const event of parsed.data.events) this.#onSessionEvent(event);
    for (const toolCall of parsed.data.toolCalls) this.#onToolCall(toolCall);
  }

  async #readTypedModeResponse(response: Response): Promise<z.infer<typeof typedModeResponseSchema> | null> {
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("application/json")) return null;
    const parsed = typedModeResponseSchema.safeParse(await response.json());
    return parsed.success ? parsed.data : null;
  }

  #enterTypedMode(code: string, detail: string): void {
    this.#mode = "text";
    this.#metrics?.recordDegradedMode(
      "text_cards",
      code === "MICROPHONE_UNAVAILABLE" ? "microphone_denied" : "realtime_unavailable",
    );
    this.#onSessionEvent({ protocolVersion: 1, type: "session.error", recoverable: true, code });
    this.#onSessionEvent({ protocolVersion: 1, type: "session.status", state: "text_only", detail });
  }

  #stopLocalMicrophone(): void {
    const localStream = this.#localStream;
    this.#localStream = null;
    for (const track of localStream?.getTracks() ?? []) {
      track.enabled = false;
      track.stop();
    }
  }

  #detachGatewaySocket(socket: WebSocket, close: boolean): void {
    socket.removeEventListener("message", this.#handleGatewayMessage);
    socket.removeEventListener("error", this.#handleGatewayError);
    socket.removeEventListener("close", this.#handleGatewayClose);
    if (this.#gatewaySocket === socket) this.#gatewaySocket = null;
    if (close && socket.readyState < WebSocket.CLOSING) {
      socket.close(1000, "client closing");
    }
  }

  #releaseConnectionResources(): void {
    if (this.#firstAudioAttempt) {
      this.#metrics?.finishTutorFirstAudio(this.#firstAudioAttempt, "cancelled");
      this.#firstAudioAttempt = undefined;
    }
    this.#gatewayCallId = null;
    const gatewaySocket = this.#gatewaySocket;
    if (gatewaySocket) this.#detachGatewaySocket(gatewaySocket, true);

    const falConnection = this.#falConnection;
    this.#falConnection = null;
    falConnection?.close();
    this.#falResponseDone = false;
    this.#clearFalOutputAudio();
    if (this.#falInputProcessor) {
      this.#falInputProcessor.onaudioprocess = null;
      this.#falInputProcessor.disconnect();
      this.#falInputProcessor = null;
    }
    this.#falInputSource?.disconnect();
    this.#falInputSource = null;
    this.#falInputSink?.disconnect();
    this.#falInputSink = null;
    this.#falOutputGain?.disconnect();
    this.#falOutputGain = null;
    const falAudioContext = this.#falAudioContext;
    this.#falAudioContext = null;
    if (falAudioContext && falAudioContext.state !== "closed") {
      void falAudioContext.close();
    }
    this.#falNextPlaybackTime = 0;

    this.#outputAudioActive = false;
    const dataChannel = this.#dataChannel;
    this.#dataChannel = null;
    if (dataChannel) {
      dataChannel.removeEventListener("message", this.#handleDataMessage);
      dataChannel.close();
    }

    const peerConnection = this.#peerConnection;
    this.#peerConnection = null;
    if (peerConnection) {
      peerConnection.removeEventListener("connectionstatechange", this.#handleConnectionStateChange);
      peerConnection.ontrack = null;
      peerConnection.close();
    }

    this.#localStream?.getTracks().forEach((track) => track.stop());
    this.#remoteStream?.getTracks().forEach((track) => track.stop());
    this.#localStream = null;
    this.#remoteStream = null;

    if (this.#audioElement) {
      this.#audioElement.pause();
      this.#audioElement.srcObject = null;
      this.#audioElement = null;
    }
  }
}
