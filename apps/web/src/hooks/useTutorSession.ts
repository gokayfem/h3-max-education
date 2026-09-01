"use client";

import { RealtimeTutorSession, type CardSelection, type TutorCloseReason } from "@axiom/domain";
import type { SessionEvent, SessionState, TutorToolCall } from "@axiom/protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  BrowserRealtimeTransport,
  type InterruptionContext,
  type VisualFailedSignal,
  type VisualAuthorizedSignal,
  type VisualReadySignal,
} from "@/lib/realtime/browser-realtime-transport";
import {
  type BrowserLaunchMetrics,
  type TypedFirstTokenAttempt,
} from "@/lib/telemetry/browser-metrics";

export interface TutorSessionError {
  code: string;
  recoverable: boolean;
  message: string;
}

export interface UseTutorSessionOptions {
  sessionId: string;
  learnerId: string;
  autoOpen?: boolean;
  onEvent?: (event: SessionEvent) => void;
  initialEvents?: SessionEvent[];
  initialState?: SessionState;
  onToolCall?: (toolCall: TutorToolCall) => void;
  initialCommandRevision?: number;
  metrics?: BrowserLaunchMetrics;
}

export interface UseTutorSessionResult {
  state: SessionState;
  mode: "voice" | "text";
  events: SessionEvent[];
  error: TutorSessionError | null;
  micMuted: boolean;
  open: () => Promise<void>;
  retry: () => Promise<void>;
  interrupt: (context: InterruptionContext) => Promise<void>;
  resume: () => Promise<void>;
  setMicrophoneMuted: (muted: boolean) => Promise<void>;
  sendText: (text: string) => Promise<void>;
  sendVisualReady: (signal: VisualReadySignal) => boolean;
  sendVisualAuthorized: (signal: VisualAuthorizedSignal) => boolean;
  sendVisualFailed: (signal: VisualFailedSignal) => boolean;
  selectCard: (selection: CardSelection) => Promise<void>;
  close: (reason?: TutorCloseReason) => Promise<void>;
}

const MAX_RETAINED_EVENTS = 200;
const CONNECTING_WATCHDOG_MS = 15_000;
const THINKING_WATCHDOG_MS = 30_000;

function recoveredSessionState(
  events: SessionEvent[],
  fallback: SessionState,
): SessionState {
  return events.reduce(
    (current, event) => event.type === "session.status" ? event.state : current,
    fallback,
  );
}

function sessionErrorMessage(code: string): string {
  if (/auth|unauthorized|401/i.test(code)) {
    return "Your session expired. Restarting the lesson…";
  }
  if (code === "connecting_timeout") {
    return "The connection stalled. Send a message to retry without losing this lesson.";
  }
  if (code === "thinking_timeout") {
    return "The tutor took too long to respond. Try sending your message again.";
  }
  if (code === "realtime_unavailable") {
    return "Voice is unavailable. You can continue by typing.";
  }
  return "The tutor connection hit a problem.";
}

function isStableTypedFallback(code: string): boolean {
  return code === "OPENAI_NOT_CONFIGURED" || code === "MICROPHONE_UNAVAILABLE";
}

function isUnauthorizedError(error: unknown): boolean {
  return error instanceof Error && /(?:status\s*)?401|unauthorized|authentication/i.test(error.message);
}

function restartGuestSession(): void {
  window.location.reload();
}

export function useTutorSession(options: UseTutorSessionOptions): UseTutorSessionResult {
  const initialEvents = options.initialEvents ?? [];
  const [state, setState] = useState<SessionState>(() =>
    recoveredSessionState(
      initialEvents,
      options.initialState ?? (options.autoOpen === false ? "ended" : "connecting"),
    ));
  const [events, setEvents] = useState<SessionEvent[]>(() =>
    initialEvents.slice(-MAX_RETAINED_EVENTS));
  const [mode, setMode] = useState<"voice" | "text">(
    options.initialState === "text_only" ? "text" : "voice",
  );
  const [error, setError] = useState<TutorSessionError | null>(null);
  const [micMuted, setMicMuted] = useState(false);
  const onEventRef = useRef(options.onEvent);
  const onToolCallRef = useRef(options.onToolCall);
  const sessionRef = useRef<RealtimeTutorSession | null>(null);
  const transportRef = useRef<BrowserRealtimeTransport | null>(null);
  const openPromiseRef = useRef<Promise<void> | null>(null);
  const isOpenRef = useRef(false);
  const runtimeGenerationRef = useRef(0);
  const installRuntimeRef = useRef<(() => void) | null>(null);
  const pendingRuntimeCleanupRef = useRef<object | null>(null);
  const typedAttemptRef = useRef<TypedFirstTokenAttempt | null>(null);
  const latestErrorCodeRef = useRef<string | null>(null);
  const degradedModeRef = useRef<"text_cards" | null>(null);
  const pendingCloseReasonRef = useRef<TutorCloseReason | null>(null);
  const applySessionEvent = useCallback((event: SessionEvent) => {
    setEvents((current) => [...current.slice(-(MAX_RETAINED_EVENTS - 1)), event]);
    if (
      typedAttemptRef.current &&
      (event.type === "transcript.delta" || event.type === "transcript.final")
    ) {
      options.metrics?.finishTypedFirstToken(
        typedAttemptRef.current,
        event.text.length > 0 ? "received" : "cancelled",
      );
      typedAttemptRef.current = null;
    }
    if (event.type === "session.status") {
      setState(event.state);
      if (event.state === "text_only") {
        setMode("text");
        if (degradedModeRef.current !== "text_cards") {
          const reason = /microphone/i.test(latestErrorCodeRef.current ?? "")
            ? "microphone_denied"
            : "realtime_unavailable";
          options.metrics?.recordDegradedMode("text_cards", reason);
          degradedModeRef.current = "text_cards";
        }
      } else if (event.state === "listening" || event.state === "speaking") {
        setError(null);
        degradedModeRef.current = null;
      }
    }
    if (event.type === "session.error") {
      latestErrorCodeRef.current = event.code;
      if (isStableTypedFallback(event.code)) {
        setError(null);
      } else {
        setError({
          code: event.code,
          recoverable: event.recoverable,
          message: sessionErrorMessage(event.code),
        });
      }
      if (/auth|unauthorized|401/i.test(event.code)) restartGuestSession();
    }
    onEventRef.current?.(event);
  }, [options.metrics]);

  useEffect(() => {
    onEventRef.current = options.onEvent;
    onToolCallRef.current = options.onToolCall;
  }, [options.onEvent, options.onToolCall]);

  useEffect(() => {
    const installRuntime = () => {
      transportRef.current?.dispose();
      const generation = runtimeGenerationRef.current + 1;
      runtimeGenerationRef.current = generation;
      isOpenRef.current = false;
      openPromiseRef.current = null;

      const runtime: { session: RealtimeTutorSession | null } = { session: null };
      const transport = new BrowserRealtimeTransport({
        metrics: options.metrics,
        initialCommandRevision: options.initialCommandRevision,
        onSessionEvent: (event) => {
          if (runtimeGenerationRef.current !== generation) return;
          if (event.type === "transcript.delta") {
            runtime.session?.appendAssistantTranscript(event.turnId, event.text);
          }
          applySessionEvent(event);
        },
        onToolCall: (toolCall) => {
          if (runtimeGenerationRef.current === generation) {
            onToolCallRef.current?.(toolCall);
          }
        },
        onResponseStarted: (turnId) => {
          if (runtimeGenerationRef.current !== generation) return;
          void runtime.session?.responseStarted(turnId).catch(() => undefined);
        },
        onSpeechStarted: (context) => {
          if (runtimeGenerationRef.current !== generation) return;
          if (context) {
            const pendingOpen = openPromiseRef.current;
            void (pendingOpen ?? Promise.resolve())
              .then(() => {
                if (!isOpenRef.current || runtimeGenerationRef.current !== generation) return;
                return runtime.session?.interrupt(context);
              })
              .catch(() => undefined);
            return;
          }
          void transport.cancelResponse()
            .then(() => transport.clearOutputAudio())
            .catch(() => undefined);
        },
        onConnectionFailure: () => {
          if (runtimeGenerationRef.current === generation) {
            void runtime.session?.handleConnectionFailure().catch(() => undefined);
          }
        },
      });
      const session = new RealtimeTutorSession(transport, (event) => {
        if (runtimeGenerationRef.current === generation) applySessionEvent(event);
      });
      runtime.session = session;
      transportRef.current = transport;
      sessionRef.current = session;
    };

    const pendingCleanup = pendingRuntimeCleanupRef.current;
    if (pendingCleanup) {
      pendingRuntimeCleanupRef.current = null;
    } else {
      installRuntime();
    }
    installRuntimeRef.current = installRuntime;
    return () => {
      const cleanupToken = {};
      pendingRuntimeCleanupRef.current = cleanupToken;
      window.setTimeout(() => {
        if (pendingRuntimeCleanupRef.current !== cleanupToken) return;
        pendingRuntimeCleanupRef.current = null;
        installRuntimeRef.current = null;
        runtimeGenerationRef.current += 1;
        transportRef.current?.dispose();
        transportRef.current = null;
        sessionRef.current = null;
        isOpenRef.current = false;
        openPromiseRef.current = null;
      });
    };
  }, [applySessionEvent, options.initialCommandRevision, options.metrics]);

  const reportOperationError = useCallback((operationError: unknown) => {
    if (isUnauthorizedError(operationError)) {
      setError({
        code: "unauthorized",
        recoverable: false,
        message: sessionErrorMessage("unauthorized"),
      });
      restartGuestSession();
      return;
    }
    setError({
      code: "operation_failed",
      recoverable: true,
      message: sessionErrorMessage("operation_failed"),
    });
  }, []);

  const open = useCallback((): Promise<void> => {
    if (isOpenRef.current) return Promise.resolve();
    if (openPromiseRef.current) return openPromiseRef.current;
    const session = sessionRef.current;
    const transport = transportRef.current;
    if (!session || !transport) return Promise.reject(new Error("Tutor session is unavailable."));
    const generation = runtimeGenerationRef.current;

    const pending = (async () => {
        const establishmentAttempt = options.metrics?.startSessionEstablishment() ?? null;
        if (establishmentAttempt) {
          transport.setSessionEstablishmentAttempt(establishmentAttempt);
        }
      try {
        await session.open({ sessionId: options.sessionId, learnerId: options.learnerId });
        if (runtimeGenerationRef.current !== generation) return;
        isOpenRef.current = true;
        setMode(transport.mode);
        if (transport.mode === "voice") {
          await transport.setMicrophoneMuted(false);
        }
        setMicMuted(false);
      } catch (openError) {
        if (runtimeGenerationRef.current !== generation) return;
        reportOperationError(openError);
        installRuntimeRef.current?.();
        setMode("text");
        if (degradedModeRef.current !== "text_cards" && !isUnauthorizedError(openError)) {
          options.metrics?.recordDegradedMode("text_cards", "network");
          degradedModeRef.current = "text_cards";
        }
        setState("text_only");
        throw openError;
      }
    })();
    openPromiseRef.current = pending;
    void pending.finally(() => {
      if (openPromiseRef.current === pending) openPromiseRef.current = null;
    }).catch(() => undefined);
    return pending;
  }, [options.learnerId, options.metrics, options.sessionId, reportOperationError]);

  const retry = useCallback(async () => {
    setError(null);
    const pendingCloseReason = pendingCloseReasonRef.current;
    if (pendingCloseReason) {
      try {
        await sessionRef.current?.close(pendingCloseReason);
        pendingCloseReasonRef.current = null;
        isOpenRef.current = false;
        return;
      } catch (closeError) {
        setError({
          code: "close_failed",
          recoverable: true,
          message: "The session could not be ended. Check your connection and retry.",
        });
        throw closeError;
      }
    }
    installRuntimeRef.current?.();
    setState("connecting");
    await open();
  }, [open]);

  const interrupt = useCallback(async (context: InterruptionContext) => {
    try {
      await open();
      const session = sessionRef.current;
      if (!session) throw new Error("Tutor session is unavailable.");
      await session.interrupt(context);
    } catch (operationError) {
      reportOperationError(operationError);
      throw operationError;
    }
  }, [open, reportOperationError]);

  const resume = useCallback(async () => {
    try {
      const session = sessionRef.current;
      if (!session) throw new Error("Tutor session is unavailable.");
      await session.resume();
      setMode(transportRef.current?.mode ?? "text");
      setMicMuted(false);
    } catch (operationError) {
      reportOperationError(operationError);
      throw operationError;
    }
  }, [reportOperationError]);

  const setMicrophoneMuted = useCallback(async (muted: boolean) => {
    try {
      const activeTransport = transportRef.current;
      if (activeTransport && isOpenRef.current) {
        // Invoke resume before any awaited work so the browser still considers
        // this part of the microphone button's user activation.
        await activeTransport.setMicrophoneMuted(muted);
      } else {
        await open();
        const transport = transportRef.current;
        if (!transport) throw new Error("Tutor session is unavailable.");
        await transport.setMicrophoneMuted(muted);
      }
      setMicMuted(muted);
      setError(null);
    } catch (operationError) {
      reportOperationError(operationError);
      throw operationError;
    }
  }, [open, reportOperationError]);

  const sendText = useCallback(async (text: string) => {
    let typedAttempt: TypedFirstTokenAttempt | null = null;
    try {
      await open();
      const session = sessionRef.current;
      const transport = transportRef.current;
      if (!session || !transport) throw new Error("Tutor session is unavailable.");
      if (transport.mode === "text") {
        if (typedAttemptRef.current) {
          options.metrics?.finishTypedFirstToken(typedAttemptRef.current, "cancelled");
        }
        typedAttempt = options.metrics?.startTypedFirstToken() ?? null;
        typedAttemptRef.current = typedAttempt;
      }
      await session.sendText(text);
    } catch (operationError) {
      if (typedAttempt) {
        options.metrics?.finishTypedFirstToken(typedAttempt, "failed");
        if (typedAttemptRef.current === typedAttempt) typedAttemptRef.current = null;
      }
      reportOperationError(operationError);
      setMode("text");
      setState("text_only");
      throw operationError;
    }
  }, [open, options.metrics, reportOperationError]);

  const selectCard = useCallback(async (selection: CardSelection) => {
    try {
      await open();
      const session = sessionRef.current;
      if (!session) throw new Error("Tutor session is unavailable.");
      await session.selectCard(selection);
    } catch (operationError) {
      reportOperationError(operationError);
      setMode("text");
      setState("text_only");
      throw operationError;
    }
  }, [open, reportOperationError]);

  const sendVisualReady = useCallback((signal: VisualReadySignal): boolean => {
    return transportRef.current?.sendVisualReady(signal) ?? false;
  }, []);

  const sendVisualFailed = useCallback((signal: VisualFailedSignal): boolean => {
    return transportRef.current?.sendVisualFailed(signal) ?? false;
  }, []);
  const sendVisualAuthorized = useCallback((signal: VisualAuthorizedSignal): boolean => {
    return transportRef.current?.sendVisualAuthorized(signal) ?? false;
  }, []);

  const close = useCallback(async (reason: TutorCloseReason = "complete") => {
    try {
      await sessionRef.current?.close(reason);
      pendingCloseReasonRef.current = null;
      isOpenRef.current = false;
    } catch (closeError) {
      pendingCloseReasonRef.current = reason;
      setError({
        code: "close_failed",
        recoverable: true,
        message: "The session could not be ended. Check your connection and retry.",
      });
      throw closeError;
    }
  }, []);

  useEffect(() => {
    if (options.autoOpen === false) return;
    void open().catch(() => undefined);
  }, [open, options.autoOpen]);

  useEffect(() => {
    if (state !== "connecting" && state !== "thinking") return;
    const code = state === "connecting" ? "connecting_timeout" : "thinking_timeout";
    const timeoutMs = state === "connecting" ? CONNECTING_WATCHDOG_MS : THINKING_WATCHDOG_MS;
    const timeout = window.setTimeout(() => {
      installRuntimeRef.current?.();
      setError({ code, recoverable: true, message: sessionErrorMessage(code) });
      setMode("text");
      if (degradedModeRef.current !== "text_cards") {
        options.metrics?.recordDegradedMode("text_cards", "network");
        degradedModeRef.current = "text_cards";
      }
      setState("text_only");
    }, timeoutMs);
    return () => window.clearTimeout(timeout);
  }, [options.metrics, state]);
  return {
    state,
    mode,
    events,
    error,
    micMuted,
    open,
    retry,
    interrupt,
    resume,
    setMicrophoneMuted,
    sendText,
    sendVisualAuthorized,
    sendVisualReady,
    sendVisualFailed,
    selectCard,
    close,
  };
}
