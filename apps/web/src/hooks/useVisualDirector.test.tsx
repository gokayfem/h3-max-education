import type { VisualSpec } from "@axiom/protocol";
import { StrictMode, type ReactNode } from "react";
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { VisualDirectorSnapshot } from "@/lib/visual/falVideoDirector";

const mocks = vi.hoisted(() => {
  let listener: (() => void) | undefined;
  let generationAccepted: ((reservationId: string) => void) | undefined;
  const director = {
    snapshot: {
      status: "idle",
      promptVersion: null,
      failure: null,
      remainingSeconds: null,
      dailyLimitSeconds: null,
      reservationId: null,
    } as VisualDirectorSnapshot,
    appliedPromptVersion: null as number | null,
    setGenerationAcceptedListener: vi.fn((next: ((reservationId: string) => void) | undefined) => {
      generationAccepted = next;
    }),
    subscribe: vi.fn((next: () => void) => {
      listener = next;
      return () => {
        listener = undefined;
      };
    }),
    attachVideoElement: vi.fn(),
    start: vi.fn(async () => true),
    replace: vi.fn(async () => true),
    redirect: vi.fn(() => true),
    canAcceptGeneration: vi.fn(() => true),
    stop: vi.fn(async () => undefined),
    continuePlaybackUntilReplacement: vi.fn(async () => undefined),
    dispose: vi.fn(async () => undefined),
  };
  const metrics = {
    startVisualGeneration: vi.fn(() => ({ kind: "visual_generation" as const })),
    finishVisualGeneration: vi.fn(),
    recordStaleRevisionDrop: vi.fn(),
    recordDegradedMode: vi.fn(),
    recordQuotaOutcome: vi.fn(),
  };
  return {
    director,
    metrics,
    setGenerationAccepted(listener: ((reservationId: string) => void) | undefined) {
      generationAccepted = listener;
    },
    acceptGeneration(reservationId: string) {
      generationAccepted?.(reservationId);
    },
    emit(snapshot: VisualDirectorSnapshot) {
      director.snapshot = snapshot;
      if (snapshot.status === "generating" && snapshot.promptVersion !== null) {
        director.appliedPromptVersion = snapshot.promptVersion;
      }
      listener?.();
    },
  };
});

vi.mock("@/lib/visual/falVideoDirector", () => ({
  FalVideoDirector: vi.fn(
    (options?: { onGenerationAccepted?: (reservationId: string) => void }) => {
      mocks.setGenerationAccepted(options?.onGenerationAccepted);
      return mocks.director;
    },
  ),
}));

vi.mock("@/lib/telemetry/browser-metrics", () => ({
  getBrowserLaunchMetrics: () => mocks.metrics,
}));

import { useVisualDirector } from "./useVisualDirector";

const spec: VisualSpec = {
  concept: "orbital motion",
  teachingIntent: "Connect velocity and gravity",
  visualDescription: "A planet follows a curved path around a star",
  durationSeconds: 5,
  continuityKey: "physics-orbits",
};

function setReducedMotion(matches: boolean): void {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

describe("useVisualDirector", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.director.snapshot = {
      status: "idle",
      promptVersion: null,
      failure: null,
      remainingSeconds: null,
      dailyLimitSeconds: null,
      reservationId: null,
    };
    mocks.director.appliedPromptVersion = null;
    mocks.director.start.mockImplementation(async () => {
      mocks.acceptGeneration("11111111-1111-4111-8111-111111111111");
      return true;
    });
    mocks.director.replace.mockResolvedValue(true);
    setReducedMotion(false);
  });

  it("keeps the stable director alive and subscribed through StrictMode effect replay", async () => {
    const wrapper = ({ children }: { children: ReactNode }) => (
      <StrictMode>{children}</StrictMode>
    );
    const { result, unmount } = renderHook(() => useVisualDirector(), { wrapper });

    await act(async () => {
      await Promise.resolve();
    });
    expect(mocks.director.dispose).not.toHaveBeenCalled();

    act(() => mocks.emit({
      status: "generating",
      promptVersion: 1,
      failure: null,
      remainingSeconds: 115,
      dailyLimitSeconds: 120,
      reservationId: "11111111-1111-4111-8111-111111111111",
    }));
    expect(result.current.status).toBe("generating");

    unmount();
    await act(async () => {
      await Promise.resolve();
    });
    expect(mocks.director.dispose).toHaveBeenCalledOnce();
  });

  it("keeps the decoded video visible while generating or stopping replacements", async () => {
    const { result } = renderHook(() => useVisualDirector());
    const video = document.createElement("video");
    act(() => {
      result.current.videoRef(video);
      video.dispatchEvent(new Event("loadeddata"));
    });
    expect(result.current.videoReady).toBe(true);

    await act(() => result.current.start(spec, 1, "visual-op-1"));
    expect(result.current.videoReady).toBe(true);

    await act(() => result.current.stop());
    expect(result.current.videoReady).toBe(true);
  });

  it("delegates new-conversation visuals to playback replacement", async () => {
    const { result } = renderHook(() => useVisualDirector());

    await act(() => result.current.replace(spec, 1, "visual-op-1"));

    expect(mocks.director.replace).toHaveBeenCalledWith(spec, 1);
    expect(mocks.director.start).not.toHaveBeenCalled();
  });

  it("cancels stale generation without stopping the playing video", async () => {
    const { result } = renderHook(() => useVisualDirector());

    await act(() => result.current.continuePlaybackUntilReplacement());

    expect(mocks.director.continuePlaybackUntilReplacement).toHaveBeenCalledOnce();
    expect(mocks.director.stop).not.toHaveBeenCalled();
  });

  it("keeps requested revisions pending until the director reports them applied", async () => {
    const onAuthorized = vi.fn();
    const onFailed = vi.fn();
    const { result } = renderHook(() =>
      useVisualDirector({ onAuthorized, onFailed }),
    );

    await act(() => result.current.start(spec, 3, "visual-op-3"));
    expect(mocks.director.start).toHaveBeenCalledWith(spec, 3);
    expect(mocks.metrics.recordQuotaOutcome).toHaveBeenCalledWith("reserved");
    expect(onAuthorized).toHaveBeenCalledOnce();
    expect(onAuthorized).toHaveBeenCalledWith({
      visualOperationId: "visual-op-3",
      visualRevision: 3,
      reservationId: "11111111-1111-4111-8111-111111111111",
    });

    act(() => mocks.emit({
      status: "connecting",
      promptVersion: 3,
      failure: null,
      remainingSeconds: 105,
      dailyLimitSeconds: 120,
      reservationId: "11111111-1111-4111-8111-111111111111",
    }));
    expect(result.current.promptVersion).toBeNull();

    act(() => mocks.emit({
      status: "generating",
      promptVersion: 3,
      failure: null,
      remainingSeconds: 105,
      dailyLimitSeconds: 120,
      reservationId: "11111111-1111-4111-8111-111111111111",
    }));
    expect(result.current.promptVersion).toBe(3);

    act(() => mocks.emit({
      status: "redirecting",
      promptVersion: 4,
      failure: null,
      remainingSeconds: 105,
      dailyLimitSeconds: 120,
      reservationId: "11111111-1111-4111-8111-111111111111",
    }));
    expect(result.current.promptVersion).toBe(3);

    act(() => mocks.emit({
      status: "failed",
      promptVersion: 4,
      failure: { reason: "transport", message: "Generation failed" },
      remainingSeconds: 120,
      dailyLimitSeconds: 120,
      reservationId: "11111111-1111-4111-8111-111111111111",
    }));
    expect(result.current.status).toBe("holding");
    expect(result.current.promptVersion).toBe(3);
    expect(result.current.failure?.reason).toBe("transport");
    expect(result.current.remainingSeconds).toBe(120);
    expect(result.current.dailyLimitSeconds).toBe(120);
    expect(mocks.metrics.finishVisualGeneration).toHaveBeenCalledWith(
      expect.anything(),
      "displayed",
    );
    expect(onFailed).toHaveBeenCalledOnce();
    expect(onFailed).toHaveBeenCalledWith({
      visualOperationId: "visual-op-3",
      visualRevision: 3,
      reason: "transport",
    });
  });

  it("acknowledges a decoded redirected revision on the director frame gate", async () => {
    const reservationId = "33333333-3333-4333-8333-333333333333";
    const onAuthorized = vi.fn();
    const onReady = vi.fn();
    const { result } = renderHook(() =>
      useVisualDirector({ onAuthorized, onReady }),
    );
    await act(() => result.current.start(spec, 3, "visual-op-3"));

    act(() => mocks.emit({
      status: "generating",
      promptVersion: 3,
      failure: null,
      remainingSeconds: 105,
      dailyLimitSeconds: 120,
      reservationId,
    }));
    expect(onReady).toHaveBeenLastCalledWith({
      visualOperationId: "visual-op-3",
      visualRevision: 3,
      reservationId,
    });

    act(() => expect(result.current.redirect(spec, 4, "visual-op-4")).toBe(true));
    expect(onAuthorized).toHaveBeenLastCalledWith({
      visualOperationId: "visual-op-4",
      visualRevision: 4,
      reservationId,
    });
    act(() => mocks.emit({
      status: "generating",
      promptVersion: 4,
      failure: null,
      remainingSeconds: 105,
      dailyLimitSeconds: 120,
      reservationId,
    }));

    expect(onReady).toHaveBeenCalledTimes(2);
    expect(onReady).toHaveBeenLastCalledWith({
      visualOperationId: "visual-op-4",
      visualRevision: 4,
      reservationId,
    });
    expect(onAuthorized.mock.invocationCallOrder[1]).toBeLessThan(
      onReady.mock.invocationCallOrder[1],
    );
  });

  it("uses a static applied revision without authorizing generation for reduced motion", async () => {
    setReducedMotion(true);
    const onFailed = vi.fn();
    const { result } = renderHook(() => useVisualDirector({ onFailed }));

    await act(() => result.current.start(spec, 5, "visual-op-5"));
    expect(mocks.director.start).not.toHaveBeenCalled();
    expect(result.current.reducedMotion).toBe(true);
    expect(result.current.status).toBe("holding");
    expect(result.current.promptVersion).toBe(5);
    expect(result.current.remainingSeconds).toBeNull();
    expect(result.current.dailyLimitSeconds).toBeNull();
    expect(mocks.metrics.finishVisualGeneration).toHaveBeenCalledWith(
      expect.anything(),
      "reduced_motion_static",
    );
    expect(mocks.metrics.recordQuotaOutcome).not.toHaveBeenCalled();
    expect(onFailed).toHaveBeenCalledWith({
      visualOperationId: "visual-op-5",
      visualRevision: 5,
      reason: "reduced_motion",
    });

    act(() => expect(result.current.redirect(spec, 5, "visual-op-5")).toBe(false));
    act(() => expect(result.current.redirect(spec, 6, "visual-op-6")).toBe(true));
    expect(mocks.director.redirect).not.toHaveBeenCalled();
    expect(result.current.promptVersion).toBe(6);
    expect(mocks.metrics.recordStaleRevisionDrop).toHaveBeenCalledWith("visual");
    expect(mocks.metrics.recordDegradedMode).toHaveBeenCalledWith(
      "held_frame",
      "reduced_motion",
    );
  });

  it("acknowledges the first decoded frame once and still reports a later terminal failure", async () => {
    const reservationId = "22222222-2222-4222-8222-222222222222";
    mocks.director.start.mockImplementation(async () => {
      mocks.acceptGeneration(reservationId);
      mocks.director.snapshot = {
        status: "connecting",
        promptVersion: 8,
        failure: null,
        remainingSeconds: 105,
        dailyLimitSeconds: 120,
        reservationId,
      };
      return true;
    });
    const onReady = vi.fn();
    const onFailed = vi.fn();
    const { result } = renderHook(() => useVisualDirector({ onReady, onFailed }));
    await act(() => result.current.start(spec, 8, "visual-op-8"));
    expect(result.current.videoReady).toBe(false);
    const video = document.createElement("video");

    act(() => {
      result.current.videoRef(video);
      video.dispatchEvent(new Event("loadeddata"));
      video.dispatchEvent(new Event("loadeddata"));
    });

    expect(result.current.videoReady).toBe(true);

    expect(mocks.metrics.finishVisualGeneration).toHaveBeenCalledWith(
      expect.anything(),
      "displayed",
    );
    expect(onReady).toHaveBeenCalledOnce();
    expect(onReady).toHaveBeenCalledWith({
      visualOperationId: "visual-op-8",
      visualRevision: 8,
      reservationId,
    });

    act(() => mocks.emit({
      status: "failed",
      promptVersion: 8,
      failure: { reason: "transport", message: "Video generation failed" },
      remainingSeconds: 120,
      dailyLimitSeconds: 120,
      reservationId,
    }));
    expect(onFailed).toHaveBeenCalledOnce();
    expect(onFailed).toHaveBeenCalledWith({
      visualOperationId: "visual-op-8",
      visualRevision: 8,
      reason: "transport",
    });
  });
});
