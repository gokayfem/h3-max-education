/**
 * Browser-only launch-gate telemetry.
 *
 * The public API deliberately accepts only bounded enums, booleans, and opaque
 * attempt handles. Learner text, provider payloads, credentials, identifiers,
 * URLs, and error messages have no place in the metric schema and cannot be
 * forwarded by this module.
 */

export type SessionPermissionOutcome = "granted" | "denied" | "unavailable" | "not_requested";
export type SessionEstablishmentOutcome = "ready" | "permission_denied" | "failed";
export type SessionFailureStage = "permission" | "session_token" | "peer_connection" | "data_channel";
export type SessionTransport = "direct_udp" | "direct_tcp" | "turn_udp" | "turn_tcp" | "unknown";
export type SessionEstablishmentResult =
  | { outcome: "ready" }
  | { outcome: "permission_denied"; failureStage: "permission" }
  | { outcome: "failed"; failureStage: SessionFailureStage };
export type TypedFirstTokenOutcome = "received" | "cancelled" | "failed";
export type TutorFirstAudioOutcome = "playing" | "cancelled" | "failed";
export type VisualResultCategory =
  | "displayed"
  | "reduced_motion_static"
  | "prompt_rejected"
  | "deadline_missed"
  | "stream_exhausted"
  | "transport_failed"
  | "cancelled"
  | "stale_revision"
  | "quota_denied";
export type StaleRevisionSurface = "cards" | "visual" | "transcript" | "tool_command";
export type InterruptionOutcome = "audio_cut_off" | "cancelled_before_audio" | "failed";
export type PostInterruptionSurface = "cards" | "visual";
export type PostInterruptionSurfaceOutcome = "clean" | "stale";
export type VisualFailureContinuationOutcome = "continued" | "lesson_terminated";
export type DegradedMode = "voice_text_cards" | "text_cards" | "held_frame";
export type DegradedModeReason =
  | "microphone_denied"
  | "realtime_unavailable"
  | "visual_unavailable"
  | "network"
  | "reduced_motion"
  | "quota_exhausted";
export type QuotaOutcome =
  | "reserved"
  | "denied_daily"
  | "denied_concurrency"
  | "denied_entitlement"
  | "released"
  | "exhausted";

export type BrowserMetricEvent =
  | {
      name: "session_establishment_ms";
      unit: "milliseconds";
      value: number;
      labels: {
        outcome: SessionEstablishmentOutcome;
        permission: SessionPermissionOutcome;
        failureStage: SessionFailureStage | "none";
        transport: SessionTransport;
      };
    }
  | {
      name: "session_permission_to_ready_ms";
      unit: "milliseconds";
      value: number;
      labels: { permission: Exclude<SessionPermissionOutcome, "not_requested"> };
    }
  | {
      name: "typed_first_token_ms";
      unit: "milliseconds";
      value: number;
      labels: { outcome: TypedFirstTokenOutcome };
    }
  | {
      name: "turn_end_to_first_audio_ms";
      unit: "milliseconds";
      value: number;
      labels: { outcome: TutorFirstAudioOutcome };
    }
  | {
      name: "card_replacement_ms";
      unit: "milliseconds";
      value: number;
      labels: { outcome: "committed" };
    }
  | {
      name: "first_generated_frame_ms";
      unit: "milliseconds";
      value: number;
      labels: { result: "displayed" };
    }
  | {
      name: "visual_result_total";
      unit: "count";
      value: 1;
      labels: { result: VisualResultCategory };
    }
  | {
      name: "stale_revision_drop_total";
      unit: "count";
      value: 1;
      labels: { surface: StaleRevisionSurface };
    }
  | {
      name: "interruption_audio_cutoff_ms";
      unit: "milliseconds";
      value: number;
      labels: { outcome: InterruptionOutcome };
    }
  | {
      name: "interruption_total";
      unit: "count";
      value: 1;
      labels: { outcome: InterruptionOutcome };
    }
  | {
      name: "post_interruption_surface_audit_total";
      unit: "count";
      value: 1;
      labels: { surface: PostInterruptionSurface; outcome: PostInterruptionSurfaceOutcome };
    }
  | {
      name: "visual_failure_continuation_total";
      unit: "count";
      value: 1;
      labels: { outcome: VisualFailureContinuationOutcome };
    }
  | {
      name: "degraded_mode_total";
      unit: "count";
      value: 1;
      labels: { mode: DegradedMode; reason: DegradedModeReason };
    }
  | {
      name: "quota_outcome_total";
      unit: "count";
      value: 1;
      labels: { outcome: QuotaOutcome };
    };

export interface BrowserMetricSink {
  record(event: BrowserMetricEvent): void;
}

export interface MonotonicClock {
  now(): number;
}

export interface SessionEstablishmentAttempt {
  readonly kind: "session_establishment";
}

export interface TypedFirstTokenAttempt {
  readonly kind: "typed_first_token";
}

export interface TutorFirstAudioAttempt {
  readonly kind: "tutor_first_audio";
}


export interface VisualGenerationAttempt {
  readonly kind: "visual_generation";
}

export interface InterruptionAttempt {
  readonly kind: "interruption";
}

interface TimedAttempt {
  startedAt: number;
  permission?: {
    outcome: Exclude<SessionPermissionOutcome, "not_requested">;
    resolvedAt: number;
  };
  transport?: SessionTransport;
}

const MAX_DURATION_MS = 10 * 60 * 1_000;
const MAX_CARD_REPLACEMENT_ATTEMPTS = 32;

function elapsedMilliseconds(clock: MonotonicClock, startedAt: number): number {
  const elapsed = clock.now() - startedAt;
  if (!Number.isFinite(elapsed)) return 0;
  return Math.min(MAX_DURATION_MS, Math.max(0, Math.round(elapsed)));
}

function createHandle<Kind extends string>(kind: Kind): { readonly kind: Kind } {
  return Object.freeze({ kind });
}

/**
 * Records bounded, content-free browser launch metrics.
 *
 * Timing starts are explicit so owners can place them on the observable browser
 * boundary rather than after an async request has already begun. Every finish
 * consumes its handle; duplicate or foreign handles are ignored.
 */
export class BrowserLaunchMetrics {
  private readonly attempts = new WeakMap<object, TimedAttempt>();
  private readonly cardReplacementStartedAt = new Map<number, number>();

  constructor(
    private readonly sink: BrowserMetricSink,
    private readonly clock: MonotonicClock = performance
  ) {}

  /** Start synchronously in the learner's connect click handler, before requesting microphone permission. */
  startSessionEstablishment(): SessionEstablishmentAttempt {
    const attempt = createHandle("session_establishment");
    this.attempts.set(attempt, { startedAt: this.clock.now() });
    return attempt;
  }

  /** Mark when the browser permission request settles; this does not finish establishment. */
  markSessionPermission(
    attempt: SessionEstablishmentAttempt,
    outcome: Exclude<SessionPermissionOutcome, "not_requested">
  ): void {
    const state = this.attempts.get(attempt);
    if (!state || state.permission) return;
    this.attempts.set(attempt, {
      ...state,
      permission: { outcome, resolvedAt: this.clock.now() }
    });
  }

  /**
   * Mark the selected ICE transport derived from RTCPeerConnection stats.
   * Candidate addresses, IDs, protocols outside this enum, and raw stats never
   * enter telemetry.
   */
  markSessionTransport(attempt: SessionEstablishmentAttempt, transport: SessionTransport): void {
    const state = this.attempts.get(attempt);
    if (!state || state.transport) return;
    this.attempts.set(attempt, { ...state, transport });
  }

  /**
   * Finish when both the realtime media path and command channel are ready, or
   * at the terminal establishment failure. Ready measures click-to-ready and,
   * when permission settled, permission-to-ready.
   */
  finishSessionEstablishment(
    attempt: SessionEstablishmentAttempt,
    result: SessionEstablishmentResult
  ): void {
    const state = this.consume(attempt);
    if (!state) return;
    const permission = state.permission?.outcome ?? "not_requested";
    const failureStage = result.outcome === "ready" ? "none" : result.failureStage;
    this.sink.record({
      name: "session_establishment_ms",
      unit: "milliseconds",
      value: elapsedMilliseconds(this.clock, state.startedAt),
      labels: {
        outcome: result.outcome,
        permission,
        failureStage,
        transport: state.transport ?? "unknown"
      }
    });
    if (result.outcome === "ready" && state.permission) {
      this.sink.record({
        name: "session_permission_to_ready_ms",
        unit: "milliseconds",
        value: elapsedMilliseconds(this.clock, state.permission.resolvedAt),
        labels: { permission: state.permission.outcome }
      });
    }
  }

  /** Start when a typed learner turn is accepted for sending, before network work begins. */
  startTypedFirstToken(): TypedFirstTokenAttempt {
    return this.start("typed_first_token");
  }

  /** Finish on the first non-empty assistant text delta, or when the turn terminates without one. */
  finishTypedFirstToken(attempt: TypedFirstTokenAttempt, outcome: TypedFirstTokenOutcome): void {
    const state = this.consume(attempt);
    if (!state) return;
    this.sink.record({
      name: "typed_first_token_ms",
      unit: "milliseconds",
      value: elapsedMilliseconds(this.clock, state.startedAt),
      labels: { outcome }
    });
  }

  /** Start when the browser observes the learner turn-completion boundary that permits a tutor response. */
  startTutorFirstAudio(): TutorFirstAudioAttempt {
    return this.start("tutor_first_audio");
  }

  /** Finish when remote tutor audio first becomes observably playing, or at a terminal no-audio outcome. */
  finishTutorFirstAudio(attempt: TutorFirstAudioAttempt, outcome: TutorFirstAudioOutcome): void {
    const state = this.consume(attempt);
    if (!state) return;
    this.sink.record({
      name: "turn_end_to_first_audio_ms",
      unit: "milliseconds",
      value: elapsedMilliseconds(this.clock, state.startedAt),
      labels: { outcome }
    });
  }

  /**
   * Start immediately when a validated card replacement arrives. Revision is
   * used only as an in-memory correlation key and is never emitted. At most 32
   * attempts are retained; the oldest is evicted before accepting another.
   */
  startCardReplacement(revision: number): void {
    if (!Number.isSafeInteger(revision) || revision < 0 || this.cardReplacementStartedAt.has(revision)) return;
    if (this.cardReplacementStartedAt.size >= MAX_CARD_REPLACEMENT_ATTEMPTS) {
      const oldestRevision = this.cardReplacementStartedAt.keys().next().value;
      if (oldestRevision !== undefined) this.cardReplacementStartedAt.delete(oldestRevision);
    }
    this.cardReplacementStartedAt.set(revision, this.clock.now());
  }

  /** Finish after React commits the matching replacement revision; unknown or evicted revisions are ignored. */
  finishCardReplacement(revision: number): void {
    if (!Number.isSafeInteger(revision) || revision < 0) return;
    const startedAt = this.cardReplacementStartedAt.get(revision);
    if (startedAt === undefined) return;
    this.cardReplacementStartedAt.delete(revision);
    this.sink.record({
      name: "card_replacement_ms",
      unit: "milliseconds",
      value: elapsedMilliseconds(this.clock, startedAt),
      labels: { outcome: "committed" }
    });
  }

  /** Start after a visual reservation is atomically accepted and immediately before generation is requested. */
  startVisualGeneration(): VisualGenerationAttempt {
    return this.start("visual_generation");
  }

  /**
   * Finish when the first generated frame is decoded and renderable, or when
   * the attempt reaches a terminal bounded result. Only displayed generated
   * video contributes first-frame latency; every terminal result increments
   * the visual result counter.
   */
  finishVisualGeneration(attempt: VisualGenerationAttempt, result: VisualResultCategory): void {
    const state = this.consume(attempt);
    if (!state) return;
    if (result === "displayed") {
      this.sink.record({
        name: "first_generated_frame_ms",
        unit: "milliseconds",
        value: elapsedMilliseconds(this.clock, state.startedAt),
        labels: { result }
      });
    }
    this.sink.record({ name: "visual_result_total", unit: "count", value: 1, labels: { result } });
  }

  /** Record a revision-rejected browser update at the point it is dropped, grouped only by bounded surface. */
  recordStaleRevisionDrop(surface: StaleRevisionSurface): void {
    this.sink.record({ name: "stale_revision_drop_total", unit: "count", value: 1, labels: { surface } });
  }

  /** Start on browser speech detection, before response cancellation or output-buffer clearing. */
  startInterruption(): InterruptionAttempt {
    return this.start("interruption");
  }

  /** Finish when audio is observably cut off, or when the cutoff attempt terminates unsuccessfully. */
  finishInterruption(attempt: InterruptionAttempt, outcome: InterruptionOutcome): void {
    const state = this.consume(attempt);
    if (!state) return;
    const value = elapsedMilliseconds(this.clock, state.startedAt);
    this.sink.record({
      name: "interruption_audio_cutoff_ms",
      unit: "milliseconds",
      value,
      labels: { outcome }
    });
    this.sink.record({ name: "interruption_total", unit: "count", value: 1, labels: { outcome } });
  }

  /**
   * Audit each card/visual surface after React commits an interruption revision.
   * `clean` means no prior-revision surface survived; `stale` is the launch-gate violation.
   */
  recordPostInterruptionSurfaceAudit(
    surface: PostInterruptionSurface,
    outcome: PostInterruptionSurfaceOutcome
  ): void {
    this.sink.record({
      name: "post_interruption_surface_audit_total",
      unit: "count",
      value: 1,
      labels: { surface, outcome }
    });
  }

  /**
   * Resolve one pending visual failure after the shell either demonstrates a
   * healthy lesson continuation or reaches a terminal lesson state.
   */
  recordVisualFailureContinuation(outcome: VisualFailureContinuationOutcome): void {
    this.sink.record({
      name: "visual_failure_continuation_total",
      unit: "count",
      value: 1,
      labels: { outcome }
    });
  }

  /** Record entry into a reduced-capability lesson mode; call once for each actual mode transition. */
  recordDegradedMode(mode: DegradedMode, reason: DegradedModeReason): void {
    this.sink.record({ name: "degraded_mode_total", unit: "count", value: 1, labels: { mode, reason } });
  }

  /** Record the terminal outcome of a quota operation without amounts, learner identity, or reservation identifiers. */
  recordQuotaOutcome(outcome: QuotaOutcome): void {
    this.sink.record({ name: "quota_outcome_total", unit: "count", value: 1, labels: { outcome } });
  }

  private start<
    Kind extends
      | "typed_first_token"
      | "tutor_first_audio"
      | "visual_generation"
      | "interruption"
  >(kind: Kind): { readonly kind: Kind } {
    const attempt = createHandle(kind);
    this.attempts.set(attempt, { startedAt: this.clock.now() });
    return attempt;
  }

  private consume(attempt: object): TimedAttempt | undefined {
    const state = this.attempts.get(attempt);
    if (state) this.attempts.delete(attempt);
    return state;
  }
}

const BROWSER_METRIC_ENDPOINT = "/api/telemetry/browser-metrics";

export interface BeaconNavigator {
  sendBeacon?: (url: string, data?: BodyInit | null) => boolean;
}

export type BrowserMetricFetch = (
  input: RequestInfo | URL,
  init?: RequestInit
) => Promise<Response>;

/**
 * Production transport for the bounded browser metric schema. Beacon keeps
 * telemetry alive across navigation; fetch is the same-origin fallback.
 * Delivery failures never affect the learner's active lesson.
 */
export class SameOriginBrowserMetricSink implements BrowserMetricSink {
  constructor(
    private readonly beaconNavigator: BeaconNavigator | undefined =
      typeof navigator === "undefined" ? undefined : navigator,
    private readonly fetchMetric: BrowserMetricFetch | undefined =
      typeof fetch === "undefined" ? undefined : fetch
  ) {}

  record(event: BrowserMetricEvent): void {
    const body = JSON.stringify(event);
    let beaconAccepted = false;
    try {
      beaconAccepted =
        this.beaconNavigator?.sendBeacon?.(
          BROWSER_METRIC_ENDPOINT,
          new Blob([body], { type: "application/json" })
        ) ?? false;
    } catch {
      beaconAccepted = false;
    }
    if (beaconAccepted || !this.fetchMetric) return;

    try {
      void this.fetchMetric(BROWSER_METRIC_ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        keepalive: true,
        credentials: "same-origin"
      }).catch(() => undefined);
    } catch {
      // Telemetry is best-effort and must not degrade lesson behavior.
    }
  }
}

let browserMetrics: BrowserLaunchMetrics | undefined;

/**
 * Returns the production browser singleton. This intentionally fails on the
 * server rather than silently discarding launch-gate telemetry at the wrong
 * runtime boundary.
 */
export function getBrowserLaunchMetrics(): BrowserLaunchMetrics {
  if (typeof window === "undefined") {
    throw new Error("Browser launch metrics are only available in the browser.");
  }
  browserMetrics ??= new BrowserLaunchMetrics(new SameOriginBrowserMetricSink());
  return browserMetrics;
}
