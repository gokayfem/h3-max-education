"use client";

import type { VisualSpec } from "@axiom/protocol";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  FalVideoDirector,
  type VisualDirectorSnapshot
} from "@/lib/visual/falVideoDirector";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";
import {
  getBrowserLaunchMetrics,
  type VisualGenerationAttempt,
  type VisualResultCategory
} from "@/lib/telemetry/browser-metrics";

export interface UseVisualDirectorResult extends VisualDirectorSnapshot {
  reducedMotion: boolean;
  videoReady: boolean;
  videoRef: (element: HTMLVideoElement | null) => void;
  start(spec: VisualSpec, revision: number, visualOperationId: string): Promise<boolean>;
  replace(spec: VisualSpec, revision: number, visualOperationId: string): Promise<boolean>;
  redirect(spec: VisualSpec, revision: number, visualOperationId: string): boolean;
  canGenerate(): boolean;
  continuePlaybackUntilReplacement(): Promise<void>;
  stop(): Promise<void>;
}

export interface VisualAcknowledgement {
  visualOperationId: string;
  visualRevision: number;
}

export interface VisualAuthorizedAcknowledgement extends VisualAcknowledgement {
  reservationId: string;
}

export interface VisualReadyAcknowledgement extends VisualAcknowledgement {
  reservationId?: string;
}

export type VisualFailedAcknowledgementReason =
  | "prompt_rejected"
  | "transport"
  | "reduced_motion";

export interface VisualFailedAcknowledgement extends VisualAcknowledgement {
  reason: VisualFailedAcknowledgementReason;
}

export interface UseVisualDirectorOptions {
  onAuthorized?: (acknowledgement: VisualAuthorizedAcknowledgement) => void;
  onReady?: (acknowledgement: VisualReadyAcknowledgement) => void;
  onFailed?: (acknowledgement: VisualFailedAcknowledgement) => void;
}

interface ActiveVisualAcknowledgement extends VisualAcknowledgement {
  reservationId?: string;
  readySent: boolean;
  failedSent: boolean;
}

function visualFailureResult(
  failure: VisualDirectorSnapshot["failure"]
): VisualResultCategory {
  switch (failure?.reason) {
    case "content_policy":
      return "prompt_rejected";
    case "transport":
    case "protocol":
      return "transport_failed";
    default:
      return "cancelled";
  }
}

function visualFailureAcknowledgementReason(
  failure: NonNullable<VisualDirectorSnapshot["failure"]>
): VisualFailedAcknowledgementReason {
  switch (failure.reason) {
    case "content_policy":
      return "prompt_rejected";
    case "transport":
    case "protocol":
      return "transport";
  }
  return "transport";
}

export function useVisualDirector(
  options: UseVisualDirectorOptions = {}
): UseVisualDirectorResult {
  const {
    onAuthorized,
    onFailed,
    onReady,
  } = options;
  const reducedMotion = usePrefersReducedMotion();
  const [reducedRevision, setReducedRevision] = useState<number | null>(null);
  const [videoReady, setVideoReady] = useState(false);
  const latestRequestedRevision = useRef(0);
  const latestVisualOperationId = useRef<string | null>(null);
  const authorizedOperationId = useRef<string | null>(null);
  const visualAttempt = useRef<VisualGenerationAttempt | null>(null);
  const quotaReserved = useRef(false);
  const attachedVideo = useRef<HTMLVideoElement | null>(null);
  const activeAcknowledgement = useRef<ActiveVisualAcknowledgement | null>(null);
  const firstFramePending = useRef(false);
  const [director] = useState(() => new FalVideoDirector());
  const visualStopped = useRef(false);
  const lifecycleGeneration = useRef(0);
  const isCurrentLifecycle = useCallback(
    (generation: number) => lifecycleGeneration.current === generation,
    [],
  );
  const metrics = typeof window === "undefined" ? null : getBrowserLaunchMetrics();
  const subscribe = useCallback(
    (listener: () => void) => director.subscribe(listener),
    [director]
  );
  const getSnapshot = useCallback(() => director.snapshot, [director]);
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const appliedPromptVersion = director.appliedPromptVersion;

  const finishVisual = useCallback(
    (result: VisualResultCategory, expectedAttempt?: VisualGenerationAttempt | null) => {
      const attempt = visualAttempt.current;
      if (
        !attempt ||
        !metrics ||
        (expectedAttempt !== undefined && attempt !== expectedAttempt)
      ) return;
      visualAttempt.current = null;
      try {
        metrics.finishVisualGeneration(attempt, result);
      } catch {
        // Telemetry is best-effort and must never affect the lesson.
      }
    },
    [metrics]
  );

  const beginVisual = useCallback((): VisualGenerationAttempt | null => {
    finishVisual("cancelled");
    if (!metrics) return null;
    try {
      const attempt = metrics.startVisualGeneration();
      visualAttempt.current = attempt;
      return attempt;
    } catch {
      visualAttempt.current = null;
      return null;
    }
  }, [finishVisual, metrics]);
  const handleGenerationAccepted = useCallback((reservationId: string) => {
    beginVisual();
    const visualOperationId = latestVisualOperationId.current;
    if (
      !visualOperationId ||
      latestRequestedRevision.current < 1 ||
      authorizedOperationId.current === visualOperationId
    ) return;
    authorizedOperationId.current = visualOperationId;
    try {
      onAuthorized?.({
        visualOperationId,
        visualRevision: latestRequestedRevision.current,
        reservationId
      });
    } catch {
      // Authorization acknowledgement cannot interrupt the lesson.
    }
  }, [beginVisual, onAuthorized]);
  useEffect(() => {
    director.setGenerationAcceptedListener(handleGenerationAccepted);
    return () => director.setGenerationAcceptedListener(undefined);
  }, [director, handleGenerationAccepted]);

  const recordQuota = useCallback(
    (outcome: "reserved" | "released") => {
      if (!metrics) return;
      try {
        metrics.recordQuotaOutcome(outcome);
      } catch {
        // Telemetry is best-effort and must never affect the lesson.
      }
    },
    [metrics]
  );

  const armAcknowledgement = useCallback((
    visualOperationId: string,
    visualRevision: number,
    reservationId?: string
  ) => {
    const active = activeAcknowledgement.current;
    if (
      active?.visualOperationId === visualOperationId &&
      active.visualRevision === visualRevision &&
      active.reservationId === reservationId
    ) return active;
    const next: ActiveVisualAcknowledgement = {
      visualOperationId,
      visualRevision,
      reservationId,
      readySent: false,
      failedSent: false
    };
    activeAcknowledgement.current = next;
    return next;
  }, []);

  const emitReady = useCallback(() => {
    const active = activeAcknowledgement.current;
    if (!active || active.readySent || active.failedSent || !firstFramePending.current) return;
    active.readySent = true;
    firstFramePending.current = false;
    try {
      onReady?.({
        visualOperationId: active.visualOperationId,
        visualRevision: active.visualRevision,
        ...(active.reservationId ? { reservationId: active.reservationId } : {})
      });
    } catch {
      // Acknowledgement delivery cannot interrupt the lesson.
    }
  }, [onReady]);

  const emitFailed = useCallback(
    (reason: VisualFailedAcknowledgementReason) => {
      const active = activeAcknowledgement.current;
      if (!active || active.failedSent) return;
      active.failedSent = true;
      firstFramePending.current = false;
      try {
        onFailed?.({
          visualOperationId: active.visualOperationId,
          visualRevision: active.visualRevision,
          reason
        });
      } catch {
        // Acknowledgement delivery cannot interrupt the lesson.
      }
    },
    [onFailed]
  );

  const onFirstFrame = useCallback(() => {
    setVideoReady(true);
    firstFramePending.current = true;
    finishVisual("displayed");
    emitReady();
  }, [emitReady, finishVisual]);
  const onFirstFrameRef = useRef(onFirstFrame);
  const finishVisualRef = useRef(finishVisual);
  useEffect(() => {
    onFirstFrameRef.current = onFirstFrame;
    finishVisualRef.current = finishVisual;
  }, [finishVisual, onFirstFrame]);
  const videoRef = useCallback(
    (element: HTMLVideoElement | null) => {
      attachedVideo.current?.removeEventListener("loadeddata", onFirstFrame);
      attachedVideo.current = element;
      director.attachVideoElement(element);
      element?.addEventListener("loadeddata", onFirstFrame);
    },
    [director, onFirstFrame]
  );

  const requestStart = useCallback(
    async (
      spec: VisualSpec,
      revision: number,
      visualOperationId: string,
      replacePlayback: boolean,
    ) => {
      if (
        !Number.isSafeInteger(revision) ||
        revision < 1 ||
        revision <= latestRequestedRevision.current ||
        visualOperationId.trim().length === 0
      ) {
        try {
          metrics?.recordStaleRevisionDrop("visual");
        } catch {
          // Telemetry is best-effort and must never affect the lesson.
        }
        return false;
      }
      latestRequestedRevision.current = revision;
      latestVisualOperationId.current = visualOperationId;
      authorizedOperationId.current = null;
      activeAcknowledgement.current = null;
      firstFramePending.current = false;
      visualStopped.current = false;
      if (reducedMotion) {
        const attempt = beginVisual();
        setReducedRevision(revision);
        armAcknowledgement(visualOperationId, revision);
        emitFailed("reduced_motion");
        finishVisual("reduced_motion_static", attempt);
        return true;
      }

      const accepted = replacePlayback
        ? await director.replace(spec, revision)
        : await director.start(spec, revision);
      if (accepted) {
        quotaReserved.current = true;
        recordQuota("reserved");
        if (director.snapshot.reservationId) {
          armAcknowledgement(
            visualOperationId,
            revision,
            director.snapshot.reservationId
          );
          emitReady();
        }
      }
      return accepted;
    },
    [
      armAcknowledgement,
      beginVisual,
      director,
      emitFailed,
      emitReady,
      finishVisual,
      metrics,
      recordQuota,
      reducedMotion
    ]
  );
  const start = useCallback(
    (spec: VisualSpec, revision: number, visualOperationId: string) =>
      requestStart(spec, revision, visualOperationId, false),
    [requestStart],
  );
  const replace = useCallback(
    (spec: VisualSpec, revision: number, visualOperationId: string) =>
      requestStart(spec, revision, visualOperationId, true),
    [requestStart],
  );

  const redirect = useCallback(
    (spec: VisualSpec, revision: number, visualOperationId: string) => {
      if (
        !Number.isSafeInteger(revision) ||
        revision <= latestRequestedRevision.current ||
        visualOperationId.trim().length === 0
      ) {
        try {
          metrics?.recordStaleRevisionDrop("visual");
        } catch {
          // Telemetry is best-effort and must never affect the lesson.
        }
        return false;
      }
      latestRequestedRevision.current = revision;
      latestVisualOperationId.current = visualOperationId;
      authorizedOperationId.current = null;
      activeAcknowledgement.current = null;
      firstFramePending.current = false;
      visualStopped.current = false;
      if (reducedMotion) {
        const attempt = beginVisual();
        setReducedRevision(revision);
        armAcknowledgement(visualOperationId, revision);
        emitFailed("reduced_motion");
        finishVisual("reduced_motion_static", attempt);
        return true;
      }
      const accepted = director.redirect(spec, revision);
      if (accepted) {
        beginVisual();
        if (director.snapshot.reservationId) {
          authorizedOperationId.current = visualOperationId;
          try {
            onAuthorized?.({
              visualOperationId,
              visualRevision: revision,
              reservationId: director.snapshot.reservationId
            });
          } catch {
            // Authorization acknowledgement cannot interrupt the lesson.
          }
          armAcknowledgement(
            visualOperationId,
            revision,
            director.snapshot.reservationId
          );
          emitReady();
        }
      }
      return accepted;
    },
    [
      armAcknowledgement,
      beginVisual,
      director,
      emitFailed,
      emitReady,
      finishVisual,
      metrics,
      onAuthorized,
      reducedMotion
    ]
  );

  const stop = useCallback(() => {
    setReducedRevision(null);
    visualStopped.current = true;
    activeAcknowledgement.current = null;
    firstFramePending.current = false;
    finishVisual("cancelled");
    if (quotaReserved.current) {
      quotaReserved.current = false;
      recordQuota("released");
    }
    return reducedMotion ? Promise.resolve() : director.stop();
  }, [director, finishVisual, recordQuota, reducedMotion]);
  const continuePlaybackUntilReplacement = useCallback(() => {
    visualStopped.current = true;
    activeAcknowledgement.current = null;
    firstFramePending.current = false;
    finishVisual("cancelled");
    if (quotaReserved.current) {
      quotaReserved.current = false;
      recordQuota("released");
    }
    return reducedMotion
      ? Promise.resolve()
      : director.continuePlaybackUntilReplacement();
  }, [director, finishVisual, recordQuota, reducedMotion]);
  const canGenerate = useCallback(
    () => !reducedMotion && director.canAcceptGeneration(),
    [director, reducedMotion],
  );

  useEffect(() => {
    if (!reducedMotion) return;
    visualStopped.current = true;
    activeAcknowledgement.current = null;
    firstFramePending.current = false;
    finishVisual("reduced_motion_static");
    try {
      metrics?.recordDegradedMode("held_frame", "reduced_motion");
    } catch {
      // Telemetry is best-effort and must never affect the lesson.
    }
    void director.stop();
  }, [director, finishVisual, metrics, reducedMotion]);

  useEffect(() => {
    if (
      reducedMotion ||
      visualStopped.current ||
      !snapshot.reservationId ||
      !latestVisualOperationId.current ||
      latestRequestedRevision.current < 1
    ) return;
    armAcknowledgement(
      latestVisualOperationId.current,
      latestRequestedRevision.current,
      snapshot.reservationId
    );
    emitReady();
  }, [
    armAcknowledgement,
    emitReady,
    reducedMotion,
    snapshot.reservationId
  ]);

  useEffect(() => {
    if (
      reducedMotion ||
      visualStopped.current ||
      snapshot.status !== "generating" ||
      snapshot.promptVersion !== latestRequestedRevision.current ||
      !snapshot.reservationId ||
      !latestVisualOperationId.current
    ) return;
    armAcknowledgement(
      latestVisualOperationId.current,
      snapshot.promptVersion,
      snapshot.reservationId
    );
    firstFramePending.current = true;
    finishVisual("displayed");
    emitReady();
  }, [
    armAcknowledgement,
    emitReady,
    finishVisual,
    reducedMotion,
    snapshot.promptVersion,
    snapshot.reservationId,
    snapshot.status
  ]);

  useEffect(() => {
    if (!snapshot.failure) return;
    finishVisual(visualFailureResult(snapshot.failure));
    if (
      !visualStopped.current &&
      latestVisualOperationId.current &&
      latestRequestedRevision.current > 0
    ) {
      armAcknowledgement(
        latestVisualOperationId.current,
        latestRequestedRevision.current,
        snapshot.reservationId ?? undefined
      );
      emitFailed(visualFailureAcknowledgementReason(snapshot.failure));
    }
    if (quotaReserved.current) {
      quotaReserved.current = false;
      recordQuota("released");
    }
    try {
      metrics?.recordDegradedMode(
        appliedPromptVersion === null ? "voice_text_cards" : "held_frame",
        snapshot.failure.reason === "transport" ? "network" : "visual_unavailable"
      );
    } catch {
      // Telemetry is best-effort and must never affect the lesson.
    }
  }, [
    armAcknowledgement,
    appliedPromptVersion,
    emitFailed,
    finishVisual,
    metrics,
    recordQuota,
    snapshot.failure,
    snapshot.reservationId
  ]);

  useEffect(() => {
    if (snapshot.status !== "holding" || !quotaReserved.current) return;
    quotaReserved.current = false;
    recordQuota("released");
  }, [recordQuota, snapshot.status]);

  useEffect(() => {
    const mountedGeneration = ++lifecycleGeneration.current;
    return () => {
      const cleanupGeneration = mountedGeneration;
      queueMicrotask(() => {
        if (!isCurrentLifecycle(cleanupGeneration)) return;
        attachedVideo.current?.removeEventListener("loadeddata", onFirstFrameRef.current);
        finishVisualRef.current("cancelled");
        void director.dispose();
      });
    };
  }, [director, isCurrentLifecycle]);


  if (reducedMotion && reducedRevision !== null) {
    return {
      status: "holding",
      promptVersion: reducedRevision,
      failure: null,
      preservedPromptVersion: null,
      remainingSeconds: snapshot.remainingSeconds,
      dailyLimitSeconds: snapshot.dailyLimitSeconds,
      reservationId: null,
      reducedMotion,
      videoReady: false,
      videoRef,
      start,
      redirect,
      replace,
      canGenerate,
      continuePlaybackUntilReplacement,
      stop
    };
  }

  const pending =
    snapshot.status === "connecting" || snapshot.status === "redirecting";
  const preserveFailedFrame =
    snapshot.status === "failed" && appliedPromptVersion !== null;
  const effectiveSnapshot: VisualDirectorSnapshot = {
    ...snapshot,
    status: preserveFailedFrame ? "holding" : snapshot.status,
    promptVersion:
      pending || snapshot.status === "failed"
        ? appliedPromptVersion
        : snapshot.promptVersion
  };

  return {
    ...effectiveSnapshot,
    reducedMotion,
    videoReady,
    videoRef,
    start,
    redirect,
    replace,
    canGenerate,
    continuePlaybackUntilReplacement,
    stop,
  };
}
