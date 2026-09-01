import { type VisualSpec } from "@axiom/protocol";
import { H3PromptCompiler, UnsafeVisualPromptError } from "@axiom/domain";
import { z } from "zod";
import { readActiveSessionId } from "@/lib/session-storage";

const promptCompiler = new H3PromptCompiler();
const MAX_PREFETCH_CLIPS = 6;

const reservationResponseSchema = z.strictObject({
  reservationId: z.uuid(),
  expiresInSeconds: z.number().int().positive(),
  remainingSeconds: z.number().int().nonnegative(),
  dailyLimitSeconds: z.number().int().positive()
});
const allowanceResponseSchema = z.strictObject({
  remainingSeconds: z.number().int().nonnegative(),
  dailyLimitSeconds: z.number().int().positive()
});
const reservationErrorResponseSchema = z.object({
  error: z.object({
    code: z.string().min(1),
    message: z.string().min(1)
  }),
  remainingSeconds: z.number().int().nonnegative().optional(),
  dailyLimitSeconds: z.number().int().positive().optional()
});
const queuedVideoResponseSchema = z.strictObject({
  videoUrl: z.url().refine((value) => value.startsWith("https://")),
  remainingSeconds: z.number().int().nonnegative(),
  dailyLimitSeconds: z.number().int().positive()
});

export interface VisualAllowance {
  remainingSeconds: number;
  dailyLimitSeconds: number;
}

export interface VisualAuthorization extends VisualAllowance {
  sessionId: string;
  reservationId: string;
  durationSeconds: VisualSpec["durationSeconds"];
}

export type VisualFailureReason =
  | "authorization"
  | "quota_denied"
  | "content_policy"
  | "transport"
  | "protocol";

export type VisualDirectorStatus =
  | "idle"
  | "connecting"
  | "generating"
  | "redirecting"
  | "holding"
  | "stopped"
  | "failed";

export interface VisualDirectorSnapshot {
  status: VisualDirectorStatus;
  promptVersion: number | null;
  failure: { reason: VisualFailureReason; message: string } | null;
  preservedPromptVersion?: number | null;
  remainingSeconds: number | null;
  dailyLimitSeconds: number | null;
  reservationId: string | null;
}

type VisualDirectorUpdate =
  & Omit<
    VisualDirectorSnapshot,
    "remainingSeconds" | "dailyLimitSeconds" | "reservationId" | "preservedPromptVersion"
  >
  & Partial<
    Pick<
      VisualDirectorSnapshot,
      "remainingSeconds" | "dailyLimitSeconds" | "reservationId" | "preservedPromptVersion"
    >
  >;

export type VisualAuthorizationProvider = (
  durationSeconds: VisualSpec["durationSeconds"],
  signal: AbortSignal
) => Promise<VisualAuthorization>;
export type VisualReleaseProvider = (
  authorization: VisualAuthorization
) => Promise<VisualAllowance | null>;
export interface QueuedVideoResult extends VisualAllowance {
  videoUrl: string;
}
export type QueuedVideoGenerator = (
  authorization: VisualAuthorization,
  prompt: string,
  signal: AbortSignal,
) => Promise<QueuedVideoResult>;
export type QueuedVideoHandoff = (
  video: HTMLVideoElement,
  videoUrl: string,
  signal: AbortSignal,
) => Promise<void>;
export interface VideoPipelineTiming {
  promptVersion: number;
  triggerToGenerationStartMs: number | null;
  generationMs: number | null;
  triggerToReadyMs: number | null;
  readyToDisplayMs: number | null;
  triggerToDisplayMs: number | null;
}

interface MutableVideoPipelineTiming {
  promptVersion: number;
  queuedAtMs: number;
  generationStartedAtMs: number | null;
  readyAtMs: number | null;
  displayedAtMs: number | null;
}

interface QueuedPlaybackClip {
  videoUrl: string;
  promptVersion: number;
}


export interface FalVideoDirectorOptions {
  getAuthorization?: VisualAuthorizationProvider;
  releaseAuthorization?: VisualReleaseProvider;
  generateVideo?: QueuedVideoGenerator;
  handoffQueuedVideo?: QueuedVideoHandoff;
  onGenerationAccepted?(reservationId: string): void;
  now?: () => number;
}

const INITIAL_SNAPSHOT: VisualDirectorSnapshot = {
  status: "idle",
  promptVersion: null,
  failure: null,
  preservedPromptVersion: null,
  remainingSeconds: null,
  dailyLimitSeconds: null,
  reservationId: null
};

class VisualAuthorizationError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly allowance: VisualAllowance | null
  ) {
    super(message);
    this.name = "VisualAuthorizationError";
  }
}

export class FalVideoDirector {
  private readonly getAuthorization: VisualAuthorizationProvider;
  private readonly releaseAuthorizationProvider: VisualReleaseProvider;
  private readonly generateVideo: QueuedVideoGenerator;
  private readonly handoffQueuedVideo: QueuedVideoHandoff;
  private onGenerationAccepted: ((reservationId: string) => void) | undefined;
  private readonly listeners = new Set<(snapshot: VisualDirectorSnapshot) => void>();
  private snapshotValue = INITIAL_SNAPSHOT;
  private videoElement: HTMLVideoElement | null = null;
  private queuedVideoUrl: string | null = null;
  private queuedPromptVersion: number | null = null;
  private readonly playbackQueue: QueuedPlaybackClip[] = [];
  private readonly preloadedVideos = new Map<string, HTMLVideoElement>();
  private playbackAdvancing = false;
  private playbackHandoffController: AbortController | null = null;
  private playbackPreemptionPending = false;
  private readonly onQueuedVideoEnded = () => {
    void this.advanceQueuedPlayback();
  };
  private readonly onQueuedVideoLoaded = () => {
    if (this.queuedPromptVersion !== null) {
      this.markPipelineDisplayed(this.queuedPromptVersion);
    }
  };
  private queuedRequestVersion = 0;
  private operationController: AbortController | null = null;
  private latestPromptVersion = 0;
  private appliedPromptVersionValue: number | null = null;
  private pendingPromptVersion: number | null = null;
  private sessionGeneration = 0;
  private authorization: VisualAuthorization | null = null;
  private authorizationGeneration: number | null = null;
  private startQueue: Promise<void> = Promise.resolve();
  private startQueueEpoch = 0;
  private readonly replacementPromptVersions = new Set<number>();
  private readonly pendingStartVersions = new Set<number>();
  private readonly now: () => number;
  private readonly pipelineTimings = new Map<number, MutableVideoPipelineTiming>();
  private readonly pipelineOrder: number[] = [];

  constructor(options: FalVideoDirectorOptions = {}) {
    this.now = options.now ?? (() => performance.now());
    this.onGenerationAccepted = options.onGenerationAccepted;
    this.getAuthorization = options.getAuthorization ?? fetchVisualAuthorization;
    this.releaseAuthorizationProvider = options.releaseAuthorization ?? releaseVisualAuthorization;
    this.generateVideo = options.generateVideo ?? generateQueuedVideo;
    this.handoffQueuedVideo = options.handoffQueuedVideo ?? crossfadeQueuedVideo;
  }

  get snapshot(): VisualDirectorSnapshot {
    return this.snapshotValue;
  }
  get appliedPromptVersion(): number | null {
    return this.appliedPromptVersionValue;
  }
  getPipelineTimings(): readonly VideoPipelineTiming[] {
    return this.pipelineOrder.flatMap((promptVersion) => {
      const timing = this.pipelineTimings.get(promptVersion);
      if (!timing) return [];
      const {
        queuedAtMs,
        generationStartedAtMs,
        readyAtMs,
        displayedAtMs,
      } = timing;
      return [{
        promptVersion,
        triggerToGenerationStartMs:
          generationStartedAtMs === null ? null : generationStartedAtMs - queuedAtMs,
        generationMs:
          generationStartedAtMs === null || readyAtMs === null
            ? null
            : readyAtMs - generationStartedAtMs,
        triggerToReadyMs: readyAtMs === null ? null : readyAtMs - queuedAtMs,
        readyToDisplayMs:
          readyAtMs === null || displayedAtMs === null
            ? null
            : displayedAtMs - readyAtMs,
        triggerToDisplayMs:
          displayedAtMs === null ? null : displayedAtMs - queuedAtMs,
      }];
    });
  }
  canAcceptGeneration(): boolean {
    return this.playbackQueue.length + this.pendingStartVersions.size < MAX_PREFETCH_CLIPS;
  }

  setGenerationAcceptedListener(listener: ((reservationId: string) => void) | undefined): void {
    this.onGenerationAccepted = listener;
  }


  subscribe(listener: (snapshot: VisualDirectorSnapshot) => void): () => void {
    this.listeners.add(listener);
    listener(this.snapshotValue);
    return () => this.listeners.delete(listener);
  }


  attachVideoElement(element: HTMLVideoElement | null): void {
    if (this.videoElement && this.videoElement !== element) {
      this.videoElement.removeEventListener?.("ended", this.onQueuedVideoEnded);
      this.videoElement.removeEventListener?.("loadeddata", this.onQueuedVideoLoaded);
      this.videoElement.pause();
      this.videoElement.srcObject = null;
      this.videoElement.removeAttribute?.("src");
    }
    this.videoElement = element;
    if (!element) return;
    element.crossOrigin = "anonymous";
    element.autoplay = true;
    element.muted = true;
    element.playsInline = true;
    element.addEventListener?.("ended", this.onQueuedVideoEnded);
    element.addEventListener?.("loadeddata", this.onQueuedVideoLoaded);
    element.srcObject = null;
    element.loop = this.playbackQueue.length === 0;
    if (this.queuedVideoUrl) {
      element.src = this.queuedVideoUrl;
      void element.play().catch(() => undefined);
    } else {
      element.removeAttribute?.("src");
    }
  }

  async start(spec: VisualSpec, promptVersion: number): Promise<boolean> {
    if (
      !Number.isSafeInteger(promptVersion)
      || promptVersion < 1
      || this.pendingStartVersions.has(promptVersion)
      || (
        promptVersion === this.latestPromptVersion
        && this.snapshotValue.status !== "failed"
      )
      || promptVersion < this.latestPromptVersion
      || !this.canAcceptGeneration()
    ) return false;
    this.recordPipelineQueued(promptVersion);
    this.pendingStartVersions.add(promptVersion);
    const previousStart = this.startQueue;
    const startQueueEpoch = this.startQueueEpoch;
    const startGate = Promise.withResolvers<void>();
    this.startQueue = startGate.promise;
    await previousStart;
    try {
      if (startQueueEpoch !== this.startQueueEpoch) return false;
      await this.releaseOperation(false);
      this.keepQueuedVideoPlaying();
      const generation = ++this.sessionGeneration;
      const controller = new AbortController();
      this.operationController = controller;
      this.latestPromptVersion = promptVersion;
      this.pendingPromptVersion = promptVersion;
      this.publish({
        status: "connecting",
        promptVersion,
        failure: null,
        preservedPromptVersion: null,
        reservationId: null,
      });

      try {
        const prompt = promptCompiler.compile(spec);
        const authorization = await this.getAuthorization(spec.durationSeconds, controller.signal);
        if (controller.signal.aborted || generation !== this.sessionGeneration) {
          await this.releaseAuthorizationProvider(authorization).catch(() => null);
          return false;
        }
        this.authorization = authorization;
        this.authorizationGeneration = generation;
        this.publish({
          status: "connecting",
          promptVersion,
          failure: null,
          remainingSeconds: authorization.remainingSeconds,
          dailyLimitSeconds: authorization.dailyLimitSeconds,
          reservationId: authorization.reservationId
        });

        const queuedRequestVersion = ++this.queuedRequestVersion;
        this.markPipelineGenerationStarted(promptVersion);
        const generated = await this.generateVideo(
          authorization,
          prompt,
          controller.signal,
        );
        if (
          controller.signal.aborted
          || generation !== this.sessionGeneration
          || queuedRequestVersion !== this.queuedRequestVersion
        ) {
          await this.releaseAuthorizationProvider(authorization).catch(() => null);
          return false;
        }
        this.markPipelineReady(promptVersion);
        this.authorization = null;
        this.authorizationGeneration = null;
        this.enqueueQueuedVideo(generated.videoUrl, promptVersion);
        this.pendingPromptVersion = null;
        this.publish({
          status: "generating",
          promptVersion,
          failure: null,
          remainingSeconds: generated.remainingSeconds,
          dailyLimitSeconds: generated.dailyLimitSeconds,
          reservationId: authorization.reservationId
        });
        this.onGenerationAccepted?.(authorization.reservationId);
        return true;
      } catch (error) {
        if (controller.signal.aborted) return false;
        if (error instanceof VisualAuthorizationError && error.allowance) {
          this.publish({
            status: "connecting",
            promptVersion,
            failure: null,
            ...error.allowance
          });
        }
        if (this.continueQueuedPlayback(generation)) return false;
        const authorizationFailure = error instanceof VisualAuthorizationError;
        const quotaDenied = authorizationFailure && [
          "daily_limit",
          "global_limit",
          "concurrency_limit"
        ].includes(error.code);
        this.fail(
          error instanceof UnsafeVisualPromptError
            ? "content_policy"
            : quotaDenied
              ? "quota_denied"
              : authorizationFailure
                ? "authorization"
                : "transport",
          error instanceof UnsafeVisualPromptError
            ? "The visual was omitted by the content safety policy"
            : errorMessage(error),
          generation
        );
        return false;
      }
    } finally {
      startGate.resolve();
      this.pendingStartVersions.delete(promptVersion);
    }
  }

  async replace(spec: VisualSpec, promptVersion: number): Promise<boolean> {
    if (
      !Number.isSafeInteger(promptVersion)
      || promptVersion < 1
      || promptVersion <= this.latestPromptVersion
    ) return false;
    this.startQueueEpoch++;
    this.pendingStartVersions.clear();
    this.queuedRequestVersion++;
    this.operationController?.abort();
    this.discardPrefetchedPlayback();
    this.replacementPromptVersions.add(promptVersion);
    const accepted = await this.start(spec, promptVersion);
    if (!accepted) this.replacementPromptVersions.delete(promptVersion);
    return accepted;
  }

  redirect(spec: VisualSpec, promptVersion: number): boolean {
    if (
      !Number.isSafeInteger(promptVersion)
      || promptVersion < 1
      || promptVersion <= this.latestPromptVersion
    ) return false;
    void this.start(spec, promptVersion);
    return true;
  }

  async continuePlaybackUntilReplacement(): Promise<void> {
    this.queuedRequestVersion++;
    this.startQueueEpoch++;
    this.pendingStartVersions.clear();
    this.replacementPromptVersions.clear();
    this.pendingPromptVersion = null;
    this.discardPrefetchedPlayback();
    this.keepQueuedVideoPlaying();
    this.publish({
      status: this.queuedVideoUrl ? "holding" : "stopped",
      promptVersion: this.latestPromptVersion || null,
      failure: null,
    });
    await this.releaseOperation(false);
    this.keepQueuedVideoPlaying();
  }

  async stop(): Promise<void> {
    this.queuedRequestVersion++;
    this.startQueueEpoch++;
    this.pendingStartVersions.clear();
    this.replacementPromptVersions.clear();
    this.pendingPromptVersion = null;
    this.discardPrefetchedPlayback();
    this.holdFrame();
    this.publish({
      status: this.queuedVideoUrl ? "holding" : "stopped",
      promptVersion: this.latestPromptVersion || null,
      failure: null
    });
    this.appliedPromptVersionValue = null;
    this.latestPromptVersion = 0;
    await this.releaseOperation(false);
  }

  async dispose(): Promise<void> {
    this.queuedRequestVersion++;
    this.startQueueEpoch++;
    this.pendingStartVersions.clear();
    this.replacementPromptVersions.clear();
    this.latestPromptVersion = 0;
    await this.releaseOperation(true);
    this.listeners.clear();
    this.snapshotValue = INITIAL_SNAPSHOT;
  }

  private holdFrame(): void {
    this.videoElement?.pause();
  }
  private enqueueQueuedVideo(videoUrl: string, promptVersion: number): void {
    const replacesCurrentConversation = this.replacementPromptVersions.delete(promptVersion);
    if (!this.queuedVideoUrl) {
      this.queuedVideoUrl = videoUrl;
      this.queuedPromptVersion = promptVersion;
      if (this.videoElement) {
        this.videoElement.srcObject = null;
        this.videoElement.src = videoUrl;
        this.videoElement.loop = this.playbackQueue.length === 0;
        void this.videoElement.play().catch(() => undefined);
      }
      return;
    }
    if (replacesCurrentConversation) {
      this.discardPrefetchedPlayback();
      this.playbackPreemptionPending = true;
      this.playbackQueue.push({ videoUrl, promptVersion });
      this.preloadQueuedVideo(videoUrl);
      if (this.videoElement) this.videoElement.loop = false;
      void this.advanceQueuedPlayback();
      return;
    }

    this.playbackQueue.push({ videoUrl, promptVersion });
    this.preloadQueuedVideo(videoUrl);
    if (this.videoElement) this.videoElement.loop = false;
  }

  private preloadQueuedVideo(videoUrl: string): void {
    if (typeof document === "undefined" || this.preloadedVideos.has(videoUrl)) return;
    const preload = document.createElement("video");
    preload.crossOrigin = "anonymous";
    preload.muted = true;
    preload.playsInline = true;
    preload.preload = "auto";
    preload.src = videoUrl;
    this.preloadedVideos.set(videoUrl, preload);
  }

  private async advanceQueuedPlayback(): Promise<void> {
    if (this.playbackAdvancing || !this.videoElement) return;
    const nextClip = this.playbackQueue.shift();
    if (!nextClip) {
      this.videoElement.loop = true;
      void this.videoElement.play().catch(() => undefined);
      return;
    }
    this.playbackPreemptionPending = false;

    const video = this.videoElement;
    this.playbackAdvancing = true;
    const controller = new AbortController();
    this.playbackHandoffController = controller;
    try {
      await this.handoffQueuedVideo(video, nextClip.videoUrl, controller.signal);
      if (this.videoElement !== video || controller.signal.aborted) return;
      this.queuedVideoUrl = nextClip.videoUrl;
      this.queuedPromptVersion = nextClip.promptVersion;
      this.markPipelineDisplayed(nextClip.promptVersion);
      this.preloadedVideos.delete(nextClip.videoUrl);
      video.loop = this.playbackQueue.length === 0;
      if (!video.loop) void video.play().catch(() => undefined);
    } catch {
      if (!controller.signal.aborted && this.videoElement === video) {
        this.playbackQueue.unshift(nextClip);
        video.loop = false;
        video.currentTime = 0;
        void video.play().catch(() => undefined);
      }
    } finally {
      if (this.playbackHandoffController === controller) {
        this.playbackHandoffController = null;
      }
      this.playbackAdvancing = false;
      if (this.playbackPreemptionPending) void this.advanceQueuedPlayback();
    }
  }

  private keepQueuedVideoPlaying(): void {
    if (!this.queuedVideoUrl || !this.videoElement) return;
    this.videoElement.loop = this.playbackQueue.length === 0;
    void this.videoElement.play().catch(() => undefined);
  }

  private continueQueuedPlayback(generation: number): boolean {
    if (generation !== this.sessionGeneration || !this.queuedVideoUrl) {
      return false;
    }
    this.pendingPromptVersion = null;
    if (this.videoElement) {
      this.videoElement.loop = this.playbackQueue.length === 0;
      void this.videoElement.play().catch(() => undefined);
    }
    this.publish({
      status: "generating",
      promptVersion: this.appliedPromptVersionValue ?? this.snapshotValue.promptVersion,
      failure: null,
      reservationId: null,
      preservedPromptVersion: this.latestPromptVersion,
    });
    void this.releaseOperation(false);
    return true;
  }

  private fail(reason: VisualFailureReason, message: string, generation: number): void {
    if (generation !== this.sessionGeneration) return;
    this.pendingPromptVersion = null;
    this.holdFrame();
    this.publish({
      status: "failed",
      promptVersion: this.latestPromptVersion || null,
      failure: { reason, message }
    });
    void this.releaseOperation(false);
  }
  private publish(snapshot: VisualDirectorUpdate): void {
    if (snapshot.status === "generating" && snapshot.promptVersion !== null) {
      this.appliedPromptVersionValue = snapshot.promptVersion;
    }
    this.snapshotValue = {
      ...snapshot,
      preservedPromptVersion: snapshot.preservedPromptVersion === undefined
        ? this.snapshotValue.preservedPromptVersion
        : snapshot.preservedPromptVersion,
      remainingSeconds: snapshot.remainingSeconds ?? this.snapshotValue.remainingSeconds,
      dailyLimitSeconds: snapshot.dailyLimitSeconds ?? this.snapshotValue.dailyLimitSeconds,
      reservationId: snapshot.reservationId === undefined
        ? this.snapshotValue.reservationId
        : snapshot.reservationId
    };
    for (const listener of this.listeners) listener(this.snapshotValue);
  }

  private async releaseAuthorization(expectedGeneration?: number): Promise<void> {
    if (
      expectedGeneration !== undefined
      && this.authorizationGeneration !== expectedGeneration
    ) {
      return;
    }
    const authorization = this.authorization;
    this.authorization = null;
    this.authorizationGeneration = null;
    if (!authorization) return;
    const allowance = await this.releaseAuthorizationProvider(authorization).catch(() => null);
    if (allowance) {
      this.publish({
        status: this.snapshotValue.status,
        promptVersion: this.snapshotValue.promptVersion,
        failure: this.snapshotValue.failure,
        ...allowance,
        reservationId: null
      });
    }
  }

  private discardPrefetchedPlayback(): void {
    this.playbackHandoffController?.abort();
    this.playbackHandoffController = null;
    this.playbackPreemptionPending = false;
    this.playbackQueue.length = 0;
    for (const preload of this.preloadedVideos.values()) {
      preload.removeAttribute("src");
    }
    this.preloadedVideos.clear();
    if (this.videoElement && this.queuedVideoUrl) this.videoElement.loop = true;
  }

  private async releaseOperation(clearFrame: boolean): Promise<void> {
    this.sessionGeneration++;
    this.operationController?.abort();
    this.operationController = null;
    await this.releaseAuthorization();
    if (clearFrame) {
      this.discardPrefetchedPlayback();
      this.queuedVideoUrl = null;
      this.queuedPromptVersion = null;
      if (this.videoElement) {
        this.videoElement.srcObject = null;
        this.videoElement.removeAttribute?.("src");
      }
    }
  }

  private recordPipelineQueued(promptVersion: number): void {
    if (this.pipelineTimings.has(promptVersion)) return;
    this.pipelineTimings.set(promptVersion, {
      promptVersion,
      queuedAtMs: this.now(),
      generationStartedAtMs: null,
      readyAtMs: null,
      displayedAtMs: null,
    });
    this.pipelineOrder.push(promptVersion);
    if (this.pipelineOrder.length > 32) {
      const evictedVersion = this.pipelineOrder.shift();
      if (evictedVersion !== undefined) this.pipelineTimings.delete(evictedVersion);
    }
  }

  private markPipelineGenerationStarted(promptVersion: number): void {
    const timing = this.pipelineTimings.get(promptVersion);
    if (timing && timing.generationStartedAtMs === null) {
      timing.generationStartedAtMs = this.now();
    }
  }

  private markPipelineReady(promptVersion: number): void {
    const timing = this.pipelineTimings.get(promptVersion);
    if (timing && timing.readyAtMs === null) timing.readyAtMs = this.now();
  }

  private markPipelineDisplayed(promptVersion: number): void {
    const timing = this.pipelineTimings.get(promptVersion);
    if (timing && timing.displayedAtMs === null) timing.displayedAtMs = this.now();
  }
}

function waitForVideoEvent(
  video: HTMLVideoElement,
  eventName: "loadedmetadata" | "loadeddata" | "seeked",
  signal: AbortSignal,
  timeoutMs = 20_000,
): Promise<void> {
  if (signal.aborted) return Promise.reject(new DOMException("Aborted", "AbortError"));
  if (eventName === "loadedmetadata" && video.readyState >= HTMLMediaElement.HAVE_METADATA) {
    return Promise.resolve();
  }
  if (eventName === "loadeddata" && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timeout);
      video.removeEventListener(eventName, handleReady);
      video.removeEventListener("error", handleError);
      signal.removeEventListener("abort", handleAbort);
    };
    const handleReady = () => {
      cleanup();
      resolve();
    };
    const handleError = () => {
      cleanup();
      reject(new Error("The continuation video could not be decoded."));
    };
    const handleAbort = () => {
      cleanup();
      reject(new DOMException("Aborted", "AbortError"));
    };
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("The continuation video did not become ready."));
    }, timeoutMs);
    video.addEventListener(eventName, handleReady, { once: true });
    video.addEventListener("error", handleError, { once: true });
    signal.addEventListener("abort", handleAbort, { once: true });
  });
}

function waitForDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new DOMException("Aborted", "AbortError"));
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", handleAbort);
    };
    const handleAbort = () => {
      cleanup();
      reject(new DOMException("Aborted", "AbortError"));
    };
    const timeout = setTimeout(() => {
      cleanup();
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", handleAbort, { once: true });
  });
}

function waitForAnimationFrame(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new DOMException("Aborted", "AbortError"));
  return new Promise<void>((resolve, reject) => {
    const handleAbort = () => {
      cancelAnimationFrame(frame);
      reject(new DOMException("Aborted", "AbortError"));
    };
    const frame = requestAnimationFrame(() => {
      signal.removeEventListener("abort", handleAbort);
      resolve();
    });
    signal.addEventListener("abort", handleAbort, { once: true });
  });
}

async function restoreQueuedVideoSource(
  video: HTMLVideoElement,
  source: string,
  currentTime: number,
): Promise<void> {
  video.srcObject = null;
  video.src = source;
  video.loop = true;
  video.load();
  const recoverySignal = new AbortController().signal;
  await waitForVideoEvent(video, "loadeddata", recoverySignal, 5_000);
  const restoredTime = Math.min(currentTime, Math.max(0, video.duration - 0.05));
  if (restoredTime > 0.01) {
    video.currentTime = restoredTime;
    await waitForVideoEvent(video, "seeked", recoverySignal, 5_000);
  }
  await video.play();
}

async function crossfadeQueuedVideo(
  video: HTMLVideoElement,
  videoUrl: string,
  signal: AbortSignal,
): Promise<void> {
  const parent = video.parentElement;
  const originalSource = video.currentSrc || video.src;
  const originalTime = video.currentTime;
  if (!parent) {
    try {
      video.srcObject = null;
      video.src = videoUrl;
      video.load();
      await video.play();
      return;
    } catch (error) {
      if (originalSource) {
        await restoreQueuedVideoSource(video, originalSource, originalTime).catch(() => undefined);
      }
      throw error;
    }
  }

  const overlay = document.createElement("video");
  const originalOpacity = video.style.opacity;
  const originalTransition = video.style.transition;
  let primarySourceReplaced = false;
  let primaryPlaybackReady = false;
  try {
    overlay.className = video.className;
    overlay.crossOrigin = "anonymous";
    overlay.autoplay = true;
    overlay.loop = true;
    overlay.muted = true;
    overlay.playsInline = true;
    overlay.preload = "auto";
    Object.assign(overlay.style, {
      position: "absolute",
      inset: "0",
      width: "100%",
      height: "100%",
      opacity: "0",
      transition: "opacity 320ms ease",
      zIndex: "2",
      pointerEvents: "none",
    });
    overlay.src = videoUrl;
    parent.append(overlay);
    overlay.load();
    await waitForVideoEvent(overlay, "loadeddata", signal);
    await overlay.play();
    await waitForAnimationFrame(signal);

    video.style.transition = "opacity 320ms ease";
    overlay.style.opacity = "1";
    video.style.opacity = "0";
    await waitForDelay(340, signal);

    video.srcObject = null;
    video.src = videoUrl;
    video.load();
    primarySourceReplaced = true;
    await waitForVideoEvent(video, "loadeddata", signal);
    const synchronizedTime = Math.min(
      overlay.currentTime,
      Math.max(0, video.duration - 0.05),
    );
    if (synchronizedTime > 0.01) {
      video.currentTime = synchronizedTime;
      await waitForVideoEvent(video, "seeked", signal);
    }
    await video.play();
    video.style.transition = "none";
    video.style.opacity = "1";
    await waitForAnimationFrame(signal);
    primaryPlaybackReady = true;
  } catch (error) {
    if (primarySourceReplaced && !primaryPlaybackReady && originalSource) {
      await restoreQueuedVideoSource(video, originalSource, originalTime).catch(() => undefined);
    }
    throw error;
  } finally {
    overlay.pause();
    overlay.removeAttribute("src");
    overlay.load();
    overlay.remove();
    video.style.opacity = originalOpacity;
    video.style.transition = originalTransition;
  }
}

async function fetchVisualAuthorization(
  durationSeconds: VisualSpec["durationSeconds"],
  signal: AbortSignal
): Promise<VisualAuthorization> {
  const sessionId = readActiveSessionId();
  if (!sessionId) {
    throw new VisualAuthorizationError(
      "session_unavailable",
      "No active lesson session is available for visual generation",
      null,
    );
  }
  const response = await fetch("/api/fal/reserve", {
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId, durationSeconds }),
    signal
  });
  if (!response.ok) {
    let parsed: z.infer<typeof reservationErrorResponseSchema> | null = null;
    try {
      parsed = reservationErrorResponseSchema.parse(await response.json());
    } catch {
      parsed = null;
    }
    const allowance = parsed?.remainingSeconds === undefined || parsed.dailyLimitSeconds === undefined
      ? null
      : {
          remainingSeconds: parsed.remainingSeconds,
          dailyLimitSeconds: parsed.dailyLimitSeconds
        };
    throw new VisualAuthorizationError(
      parsed?.error.code ?? "authorization_failed",
      parsed?.error.message ?? `Unable to authorize visual generation (${response.status})`,
      allowance
    );
  }
  const authorization = reservationResponseSchema.parse(await response.json());
  return {
    reservationId: authorization.reservationId,
    sessionId,
    durationSeconds,
    remainingSeconds: authorization.remainingSeconds,
    dailyLimitSeconds: authorization.dailyLimitSeconds
  };
}
async function generateQueuedVideo(
  authorization: VisualAuthorization,
  prompt: string,
  signal: AbortSignal,
): Promise<QueuedVideoResult> {
  const response = await fetch("/api/fal/generate", {
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sessionId: authorization.sessionId,
      reservationId: authorization.reservationId,
      durationSeconds: authorization.durationSeconds,
      prompt,
    }),
    signal
  });
  if (!response.ok) throw new Error(`Queued visual generation failed (${response.status})`);
  const payload: unknown = await response.json();
  return queuedVideoResponseSchema.parse(payload);
}

async function releaseVisualAuthorization(
  authorization: VisualAuthorization
): Promise<VisualAllowance | null> {
  const response = await fetch("/api/fal/release", {
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
    keepalive: true,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sessionId: authorization.sessionId,
      reservationId: authorization.reservationId
    })
  });
  if (!response.ok) return null;
  return allowanceResponseSchema.parse(await response.json());
}


function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "The visual connection failed";
}
