"use client";

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { SessionEvent, VisualSpec } from "@axiom/protocol";
import { useTutorSession, type UseTutorSessionResult } from "@/hooks/useTutorSession";
import { useVisualDirector } from "@/hooks/useVisualDirector";
import { getBrowserLaunchMetrics } from "@/lib/telemetry/browser-metrics";
import {
  createRecoveredLiveLessonState,
  INITIAL_LIVE_STATE,
  reduceLiveLesson,
  shouldApplyRevisionedEvent,
  type RecoveredLessonState,
} from "./live-session";
import { LessonView } from "./LessonShell";
import { StreamingSubjectBuffer } from "./streaming-subjects";
import type { LessonSession, TranscriptTurn, VisualState } from "./types";

export interface LiveLessonShellProps {
  sessionId: string;
  learnerId: string;
  initialState?: RecoveredLessonState;
  initialEvents?: SessionEvent[];
  backfillEvents?: SessionEvent[];
}

const CONTINUOUS_VIDEO_DURATION_SECONDS = 5 as const;
const CONTINUOUS_VISUAL_PUMP_MS = 750;

function withContinuousVideoContract(spec: VisualSpec): VisualSpec {
  return spec.durationSeconds === CONTINUOUS_VIDEO_DURATION_SECONDS
    ? spec
    : { ...spec, durationSeconds: CONTINUOUS_VIDEO_DURATION_SECONDS };
}

function visualFromSpokenResponse(
  text: string,
  activeContinuityKey?: string,
): VisualSpec | null {
  const normalized = text.replace(/\s+/gu, " ").trim();
  const firstSentence =
    normalized.split(/[.!?](?=\s|$)/u, 1)[0]?.trim() || normalized;
  if (
    /(?:can hear you|ready to help|what science topic|what would you like to explore)/iu.test(
      normalized,
    )
  ) {
    return null;
  }

  const subjectSummary = firstSentence.slice(0, 240);
  const subjectKey = subjectSummary
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-|-$/gu, "")
    .slice(0, 72);

  return {
    concept: subjectSummary,
    teachingIntent: `Explain ${subjectSummary}.`,
    visualDescription: subjectSummary,
    durationSeconds: CONTINUOUS_VIDEO_DURATION_SECONDS,
    continuityKey: activeContinuityKey ?? `conversation-${subjectKey || "science"}`,
  };
}

/**
 * Production lesson shell. Wires the realtime hooks into the shared
 * LessonView: useTutorSession owns speech, transcripts, cards, and session
 * status; useVisualDirector owns the generated video element. SessionEvents
 * are reduced through live-session.ts with revision guards so stale cards or
 * visuals can never survive a branch change.
 */
export function LiveLessonShell({
  sessionId,
  learnerId,
  initialState,
  initialEvents = [],
  backfillEvents = [],
}: LiveLessonShellProps) {
  const metrics = getBrowserLaunchMetrics();
  const tutorBoundaryRef = useRef<Pick<
    UseTutorSessionResult,
    "sendVisualAuthorized" | "sendVisualReady" | "sendVisualFailed"
  > | null>(null);
  const onVisualAuthorized = useCallback(
    (signal: Parameters<UseTutorSessionResult["sendVisualAuthorized"]>[0]) => {
      tutorBoundaryRef.current?.sendVisualAuthorized(signal);
    },
    [],
  );
  const onVisualReady = useCallback(
    (signal: Parameters<UseTutorSessionResult["sendVisualReady"]>[0]) => {
      tutorBoundaryRef.current?.sendVisualReady(signal);
    },
    [],
  );
  const onVisualFailed = useCallback(
    (signal: Parameters<UseTutorSessionResult["sendVisualFailed"]>[0]) => {
      tutorBoundaryRef.current?.sendVisualFailed(signal);
    },
    [],
  );
  const director = useVisualDirector({
    onReady: onVisualReady,
    onFailed: onVisualFailed,
    onAuthorized: onVisualAuthorized,
  });
  // Local learner turns consume the visible card set immediately; the next
  // canvas.cards.replace (higher revision) installs the follow-up cards.
  const [live, dispatch] = useReducer(
    reduceLiveLesson,
    undefined,
    () => initialState
      ? createRecoveredLiveLessonState(initialState, initialEvents)
      : INITIAL_LIVE_STATE,
  );
  const latestRevision = useRef(live.revision);
  const activeVisualRef = useRef(live.visual);
  const appliedVisualRef = useRef(live.visual?.phase === "live" ? live.visual : null);
  useEffect(() => {
    activeVisualRef.current = live.visual;
    if (live.visual?.phase === "live") appliedVisualRef.current = live.visual;
  }, [live.visual]);
  const [eventStatusDetail, setEventStatusDetail] = useState<string | undefined>(() => {
    const latestStatus = [...initialEvents]
      .reverse()
      .find((event) => event.type === "session.status");
    return latestStatus?.type === "session.status" ? latestStatus.detail : undefined;
  });
  const learnerCounter = useRef(0);
  const streamingSubjectsRef = useRef(new StreamingSubjectBuffer());
  const latestSpokenVisualRef = useRef<{ readonly text: string; readonly turnId: string } | null>(null);
  const lastVisualTurnIdRef = useRef<string | null>(null);
  const replaceAfterInterruptionRef = useRef(false);
  const [allowance, setAllowance] = useState(() => initialState?.visualAllowance ?? null);
  const pendingInterruptionAuditRef = useRef(false);
  const pendingVisualFailureRef = useRef(false);
  const [interruptionAuditSequence, setInterruptionAuditSequence] = useState(0);
  const backfilledTurns = useMemo(() => {
    const turns = backfillEvents.flatMap((event): TranscriptTurn[] =>
      event.type === "transcript.final"
        ? [{
            turnId: event.turnId,
            role: "tutor",
            text: event.text,
            interrupted: event.interrupted,
            final: true,
          }]
        : []);
    const seen = new Set<string>();
    return turns.filter((turn) => {
      if (seen.has(turn.turnId)) return false;
      seen.add(turn.turnId);
      return true;
    });
  }, [backfillEvents]);
  const startVisualSpec = useCallback((spec: VisualSpec, replacePlayback = false) => {
    const continuousSpec = withContinuousVideoContract(spec);
    const revision = latestRevision.current + 1;
    const visualOperationId = `visual_${crypto.randomUUID()}`;
    const redirecting =
      activeVisualRef.current !== null && activeVisualRef.current.phase !== "held";
    const visualEvent: SessionEvent = {
      protocolVersion: 1,
      type: redirecting ? "visual.redirect" : "visual.start",
      revision,
      visualOperationId,
      spec: continuousSpec,
    };
    dispatch(visualEvent);
    latestRevision.current = revision;
    activeVisualRef.current = {
      spec: continuousSpec,
      revision,
      visualOperationId,
      phase: redirecting ? "redirecting" : "live",
    };
    if (replacePlayback) {
      void director.replace(continuousSpec, revision, visualOperationId);
    } else if (redirecting) {
      director.redirect(continuousSpec, revision, visualOperationId);
    } else {
      void director.start(continuousSpec, revision, visualOperationId);
    }
  }, [director]);
  const generateSpokenVisual = useCallback((text: string, turnId: string) => {
    const replacePlayback =
      replaceAfterInterruptionRef.current
      || (
        lastVisualTurnIdRef.current !== null
        && lastVisualTurnIdRef.current !== turnId
      );
    const spec = visualFromSpokenResponse(
      text,
      replacePlayback ? undefined : activeVisualRef.current?.spec.continuityKey,
    );
    if (!spec?.concept) return;
    lastVisualTurnIdRef.current = turnId;
    replaceAfterInterruptionRef.current = false;
    startVisualSpec(spec, replacePlayback);
  }, [startVisualSpec]);


  const onEvent = useCallback(
    (event: SessionEvent) => {
      const applies = shouldApplyRevisionedEvent(latestRevision.current, event);
      dispatch(event);
      if (!applies) return;
      if ("revision" in event) latestRevision.current = Math.max(latestRevision.current, event.revision);
      if (event.type === "canvas.cards.replace" && event.cards.length > 0) {
        metrics.startCardReplacement(event.revision);
      }
      if (event.type === "session.status") {
        if (event.detail !== undefined) {
          setEventStatusDetail(event.detail);
        } else if (
          event.state === "listening"
          || event.state === "speaking"
          || event.state === "ended"
        ) {
          setEventStatusDetail(undefined);
        }
        if (event.state === "ended") streamingSubjectsRef.current.reset();
      }
      if (pendingVisualFailureRef.current) {
        if (event.type === "session.status" && event.state === "ended") {
          metrics.recordVisualFailureContinuation("lesson_terminated");
          pendingVisualFailureRef.current = false;
        } else if (
          (event.type === "session.status" && event.state === "listening") ||
          event.type === "transcript.delta" ||
          event.type === "transcript.final" ||
          (event.type === "canvas.cards.replace" && event.cards.length > 0)
        ) {
          metrics.recordVisualFailureContinuation("continued");
          pendingVisualFailureRef.current = false;
        }
      }
      if (event.type === "session.error") {
        setEventStatusDetail(
          event.recoverable
            ? "The tutor connection hit a problem."
            : "This session cannot continue.",
        );
      }
      if (event.type === "visual.start") {
        void director.start(
          withContinuousVideoContract(event.spec),
          event.revision,
          event.visualOperationId,
        );
      }
      if (event.type === "visual.redirect") {
        director.redirect(
          withContinuousVideoContract(event.spec),
          event.revision,
          event.visualOperationId,
        );
      }
      if (event.type === "visual.stop") {
        void director.stop();
      }
      if (event.type === "transcript.delta") {
        const subjects = streamingSubjectsRef.current.pushDelta(
          event.turnId,
          event.text,
        );
        for (const subject of subjects) {
          latestSpokenVisualRef.current = { text: subject, turnId: event.turnId };
          generateSpokenVisual(subject, event.turnId);
        }
      }
      if (event.type === "transcript.final") {
        if (event.interrupted) {
          latestSpokenVisualRef.current = null;
          lastVisualTurnIdRef.current = null;
          replaceAfterInterruptionRef.current = activeVisualRef.current !== null;
        }
        if (event.interrupted && activeVisualRef.current) {
          activeVisualRef.current = {
            ...activeVisualRef.current,
            phase: "held",
            stopReason: "interrupted",
          };
          void director.continuePlaybackUntilReplacement();
        }
        const subjects = streamingSubjectsRef.current.finish(
          event.turnId,
          event.text,
          event.interrupted,
        );
        if (!event.interrupted) {
          for (const subject of subjects) {
            latestSpokenVisualRef.current = { text: subject, turnId: event.turnId };
            generateSpokenVisual(subject, event.turnId);
          }
        }
        if (!event.interrupted && event.text.trim().length > 0) {
          latestSpokenVisualRef.current = { text: event.text, turnId: event.turnId };
        }
      }
    },
    [director, generateSpokenVisual, metrics],
  );


  const tutor = useTutorSession({
    sessionId,
    learnerId,
    autoOpen: initialState?.status !== "ended",
    initialEvents,
    initialState: initialState?.status,
    initialCommandRevision: initialState?.revision,
    metrics,
    onEvent,
  });
  useEffect(() => {
    tutorBoundaryRef.current = tutor;
    return () => {
      if (tutorBoundaryRef.current === tutor) tutorBoundaryRef.current = null;
    };
  }, [tutor]);
  useEffect(() => {
    if (tutor.state === "ended") return;
    const pump = window.setInterval(() => {
      const subject = latestSpokenVisualRef.current;
      if (!subject || !director.canGenerate()) return;
      generateSpokenVisual(subject.text, subject.turnId);
    }, CONTINUOUS_VISUAL_PUMP_MS);
    return () => window.clearInterval(pump);
  }, [director, generateSpokenVisual, tutor.state]);
  const statusDetail = tutor.state === "ended"
    ? undefined
    : tutor.error
      ? tutor.error.message
      : tutor.state === "listening" || tutor.state === "speaking"
        ? undefined
        : eventStatusDetail;

  useEffect(() => {
    if (typeof globalThis.fetch !== "function") return;
    const controller = new AbortController();
    void fetch(`/api/fal/reserve?sessionId=${encodeURIComponent(sessionId)}`, {
      credentials: "same-origin",
      cache: "no-store",
      signal: controller.signal,
    }).then(async (response) => {
      if (!response.ok) return;
      const value: unknown = await response.json();
      if (
        typeof value === "object" &&
        value !== null &&
        "remainingSeconds" in value &&
        "dailyLimitSeconds" in value &&
        typeof value.remainingSeconds === "number" &&
        typeof value.dailyLimitSeconds === "number" &&
        Number.isInteger(value.remainingSeconds) &&
        value.remainingSeconds >= 0 &&
        Number.isInteger(value.dailyLimitSeconds) &&
        value.dailyLimitSeconds > 0
      ) {
        setAllowance({
          remainingSeconds: value.remainingSeconds,
          dailyLimitSeconds: value.dailyLimitSeconds,
        });
      }
    }).catch(() => undefined);
    return () => controller.abort();
  }, [sessionId]);

  const recoveredVisualStarted = useRef(false);
  useEffect(() => {
    if (
      recoveredVisualStarted.current ||
      !initialState?.visual ||
      !live.visual?.visualOperationId
    ) return;
    recoveredVisualStarted.current = true;
    void director.start(
      withContinuousVideoContract(initialState.visual.spec),
      live.visual.revision,
      live.visual.visualOperationId,
    );
  }, [director, initialState, live.visual]);

  // A redirect is honestly "Changing direction…" until the director confirms
  // the new prompt version was applied.
  useEffect(() => {
    if (
      live.visual?.phase === "redirecting" &&
      director.status === "generating" &&
      director.promptVersion !== null &&
      director.promptVersion >= live.visual.revision &&
      live.visual.visualOperationId
    ) {
      dispatch({
        protocolVersion: 1,
        type: "visual.start",
        revision: live.visual.revision,
        visualOperationId: live.visual.visualOperationId,
        spec: live.visual.spec,
      });
    }
  }, [director.promptVersion, director.status, live.visual]);

  useEffect(() => {
    if (
      live.visual?.phase !== "redirecting"
      || typeof director.preservedPromptVersion !== "number"
      || director.preservedPromptVersion < live.visual.revision
      || !live.visual.visualOperationId
    ) return;
    dispatch({
      protocolVersion: 1,
      type: "visual.start",
      revision: live.visual.revision,
      visualOperationId: live.visual.visualOperationId,
      spec: appliedVisualRef.current?.spec ?? live.visual.spec,
    });
  }, [director.preservedPromptVersion, live.visual]);

  useEffect(() => {
    if (director.failure && live.visual && live.visual.phase !== "held") {
      pendingVisualFailureRef.current = true;
      dispatch({
        protocolVersion: 1,
        type: "visual.stop",
        revision: Math.max(live.revision, live.visual.revision),
        reason: "failed",
      });
    }
  }, [director.failure, live.visual, live.revision]);

  const sendText = useCallback(
    (text: string) => {
      const value = text.trim();
      if (!value) return;
      learnerCounter.current += 1;
      dispatch({
        type: "learner.turn",
        turn: {
          turnId: `local-${learnerCounter.current}`,
          role: "learner",
          text: value,
          interrupted: false,
          final: true,
        },
      });
      void tutor.sendText(value).catch(() => undefined);
    },
    [tutor],
  );

  const selectCard = useCallback(
    (cardId: string, revision: number) => {
      const card = live.activeCards?.cards.find((c) => c.id === cardId);
      if (!card || !live.activeCards || revision !== live.activeCards.revision) return;
      learnerCounter.current += 1;
      dispatch({
        type: "learner.turn",
        turn: {
          turnId: `local-${learnerCounter.current}`,
          role: "learner",
          text: card.title,
          interrupted: false,
          final: true,
        },
      });
      void tutor.selectCard({ id: card.id, title: card.title, revision }).catch(() => undefined);
    },
    [live.activeCards, tutor],
  );

  const interrupt = useCallback(() => {
    const active = live.activeTurn;
    pendingInterruptionAuditRef.current = true;
    setInterruptionAuditSequence((sequence) => sequence + 1);
    dispatch({ type: "learner.interrupt" });
    if (active) {
      void tutor.interrupt({ turnId: active.turnId, heardCharacters: active.text.length })
        .catch(() => undefined);
    }
  }, [tutor, live.activeTurn]);

  useEffect(() => {
    if (!pendingInterruptionAuditRef.current) return;
    metrics.recordPostInterruptionSurfaceAudit(
      "cards",
      live.activeCards === null ? "clean" : "stale",
    );
    metrics.recordPostInterruptionSurfaceAudit("visual", "clean");
    pendingInterruptionAuditRef.current = false;
  }, [interruptionAuditSequence, live.activeCards, metrics]);

  const toggleMic = useCallback(() => {
    if (tutor.mode === "text") {
      void tutor.resume().catch(() => undefined);
      return;
    }
    void tutor.setMicrophoneMuted(!tutor.micMuted).catch(() => undefined);
  }, [tutor]);

  const close = useCallback(
    async (reason: "complete" | "abandoned" | "error") => {
      await director.stop();
      await tutor.close(reason).catch(() => undefined);
    },
    [director, tutor],
  );

  const retry = useCallback(() => {
    void tutor.retry().catch(() => undefined);
  }, [tutor]);

  const liveTurnIds = new Set([
    ...live.turns.map((turn) => turn.turnId),
    ...(live.activeTurn ? [live.activeTurn.turnId] : []),
  ]);
  const turns = [
    ...backfilledTurns.filter((turn) => !liveTurnIds.has(turn.turnId)),
    ...live.turns,
  ];

  const visual: VisualState | null = live.visual;

  const status = tutor.state;

  const session: LessonSession = {
    status,
    statusDetail,
    activeTurn: live.activeTurn,
    turns,
    activeCards: live.activeCards,
    mastery: live.mastery,
    graph: live.graph,
    visual,
    quotaSecondsRemaining: director.remainingSeconds ?? allowance?.remainingSeconds ?? null,
    quotaTotalSeconds: director.dailyLimitSeconds ?? allowance?.dailyLimitSeconds ?? null,
    micEnabled: tutor.mode === "voice" && !tutor.micMuted && tutor.state !== "ended",
    micAvailable: tutor.mode === "voice",
    sendText,
    selectCard,
    interrupt,
    toggleMic,
    close,
    retry: tutor.state !== "ended" && tutor.error?.recoverable ? retry : undefined,
  };

  const showVideo =
    !director.reducedMotion &&
    visual !== null &&
    (director.status === "connecting" ||
      director.status === "generating" ||
      director.status === "holding" ||
      director.status === "redirecting");

  return (
    <LessonView
      session={session}
      videoRef={showVideo ? director.videoRef : undefined}
      videoReady={director.videoReady}
    />
  );
}
