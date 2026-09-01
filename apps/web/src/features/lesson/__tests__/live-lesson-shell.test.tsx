import { act, fireEvent, render, screen } from "@testing-library/react";
import type { SessionEvent } from "@axiom/protocol";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LessonSession } from "../types";
import { LiveLessonShell } from "../LiveLessonShell";

const harness = vi.hoisted(() => {
  const videoRef = vi.fn((element: HTMLVideoElement | null) => {
    if (element) element.src = "https://v3.fal.media/files/orbit.mp4";
  });
  return {
    onEvent: null as ((event: SessionEvent) => void) | null,
    start: vi.fn(),
    redirect: vi.fn(),
    replace: vi.fn(),
    stop: vi.fn(),
    continuePlaybackUntilReplacement: vi.fn(),
    sendText: vi.fn(),
    director: {
      status: "idle" as "idle" | "connecting" | "holding" | "generating",
      promptVersion: null as number | null,
      preservedPromptVersion: null as number | null,
      failure: null,
      videoRef,
      canGenerate: vi.fn(() => true),
    },
  };
});


vi.mock("@/hooks/useTutorSession", () => ({
  useTutorSession: (options: {
    onEvent?: (event: SessionEvent) => void;
  }) => {
    harness.onEvent = options.onEvent ?? null;
    return {
      state: "text_only",
      mode: "text",
      events: [],
      error: null,
      micMuted: false,
      open: vi.fn(),
      retry: vi.fn(),
      interrupt: vi.fn(),
      resume: vi.fn(),
      setMicrophoneMuted: vi.fn(),
      sendText: harness.sendText,
      selectCard: vi.fn(),
      close: vi.fn(),
    };
  },
}));

vi.mock("@/hooks/useVisualDirector", () => ({
  useVisualDirector: () => ({
    ...harness.director,
    start: harness.start,
    redirect: harness.redirect,
    replace: harness.replace,
    stop: harness.stop,
    continuePlaybackUntilReplacement: harness.continuePlaybackUntilReplacement,
  }),
}));

vi.mock("../LessonShell", () => ({
  LessonView: ({
    session,
    videoRef,
  }: {
    session: LessonSession;
    videoRef?: (element: HTMLVideoElement | null) => void;
  }) => (
    <div>
      {videoRef && <video data-testid="generated-video" ref={videoRef} />}
      <span data-testid="visual-state">
        {session.visual ? `${session.visual.phase}:${session.visual.spec.concept}` : "none"}
      </span>
      <button type="button" onClick={() => session.sendText("First question")}>First</button>
      <button type="button" onClick={() => session.sendText("Second question")}>Second</button>
      <ol data-testid="transcript">
        {session.turns.map((turn) => <li key={turn.turnId}>{`${turn.role}:${turn.text}`}</li>)}
      </ol>
    </div>
  ),
}));

const spec = {
  concept: "Orbital motion",
  teachingIntent: "Show gravity bending motion",
  visualDescription: "A planet following a curved orbit",
  durationSeconds: 5 as const,
  continuityKey: "astronomy",
};

describe("LiveLessonShell", () => {
  beforeEach(() => {
    harness.onEvent = null;
    harness.start.mockReset().mockResolvedValue(undefined);
    harness.redirect.mockReset();
    harness.replace.mockReset().mockResolvedValue(undefined);
    harness.stop.mockReset().mockResolvedValue(undefined);
    harness.sendText.mockReset().mockResolvedValue(undefined);
    harness.director.status = "idle";
    harness.continuePlaybackUntilReplacement.mockReset().mockResolvedValue(undefined);
    harness.director.promptVersion = null;
    harness.director.preservedPromptVersion = null;
    harness.director.canGenerate.mockReset().mockReturnValue(true);
    harness.director.videoRef.mockClear();
  });

  it("renders two learner and tutor turns in chronological order", () => {
    render(<LiveLessonShell sessionId="session-1" learnerId="learner-1" />);

    fireEvent.click(screen.getByRole("button", { name: "First" }));
    act(() => harness.onEvent?.({
      protocolVersion: 1,
      type: "transcript.final",
      turnId: "tutor-1",
      text: "First answer",
      interrupted: false,
    }));
    fireEvent.click(screen.getByRole("button", { name: "Second" }));
    act(() => harness.onEvent?.({
      protocolVersion: 1,
      type: "transcript.final",
      turnId: "tutor-2",
      text: "Second answer",
      interrupted: false,
    }));

    expect(Array.from(screen.getByTestId("transcript").children, (item) => item.textContent)).toEqual([
      "learner:First question",
      "tutor:First answer",
      "learner:Second question",
      "tutor:Second answer",
    ]);
  });

  it("prepends deduplicated transcript backfill without remounting", () => {
    const recent: SessionEvent = {
      protocolVersion: 1,
      type: "transcript.final",
      turnId: "tutor-recent",
      text: "Recent answer",
      interrupted: false,
    };
    render(
      <LiveLessonShell
        sessionId="session-1"
        learnerId="learner-1"
        initialEvents={[recent]}
        backfillEvents={[
          {
            protocolVersion: 1,
            type: "transcript.final",
            turnId: "tutor-old",
            text: "Old answer",
            interrupted: false,
          },
          recent,
        ]}
      />,
    );

    expect(Array.from(screen.getByTestId("transcript").children, (item) => item.textContent)).toEqual([
      "tutor:Old answer",
      "tutor:Recent answer",
    ]);
  });

  it("forwards revisioned visuals to the director and ignores stale redirects", () => {
    render(<LiveLessonShell sessionId="session-1" learnerId="learner-1" />);

    act(() => harness.onEvent?.({
      protocolVersion: 1,
      type: "visual.start",
      revision: 1,
      visualOperationId: "visual-op-1",
      spec,
    }));
    act(() => harness.onEvent?.({
      protocolVersion: 1,
      type: "canvas.cards.replace",
      revision: 3,
      purpose: "branch",
      prompt: "Where next?",
      cards: [{ id: "card-1", title: "Faster", description: "Increase speed", spokenAliases: [] }],
    }));
    act(() => harness.onEvent?.({
      protocolVersion: 1,
      type: "visual.redirect",
      revision: 2,
      visualOperationId: "visual-op-2",
      spec,
    }));

    expect(harness.start).toHaveBeenCalledWith(
      { ...spec, durationSeconds: 5 },
      1,
      "visual-op-1",
    );
    expect(harness.redirect).not.toHaveBeenCalled();
  });

  it("keeps the current video mounted while its replacement connects", () => {
    harness.director.status = "generating";
    const view = render(
      <LiveLessonShell sessionId="session-1" learnerId="learner-1" />,
    );
    act(() => harness.onEvent?.({
      protocolVersion: 1,
      type: "visual.start",
      revision: 1,
      visualOperationId: "visual-op-1",
      spec,
    }));
    const playingVideo = screen.getByTestId("generated-video");

    harness.director.status = "connecting";
    view.rerender(
      <LiveLessonShell sessionId="session-1" learnerId="learner-1" />,
    );

    expect(screen.getByTestId("generated-video")).toBe(playingVideo);
    expect(harness.director.videoRef).not.toHaveBeenCalledWith(null);
  });


  it("waits for tutor science, then sends only each summarized subject", () => {
    render(<LiveLessonShell sessionId="session-1" learnerId="learner-1" />);
    act(() => harness.onEvent?.({
      protocolVersion: 1,
      type: "session.status",
      state: "listening",
    }));
    expect(harness.start).not.toHaveBeenCalled();
    expect(screen.getByTestId("visual-state").textContent).toBe("none");

    act(() => harness.onEvent?.({
      protocolVersion: 1,
      type: "transcript.final",
      turnId: "generic-greeting",
      text: "Yes, I can hear you loud and clear! What science topic would you like to explore today?",
      interrupted: false,
    }));
    expect(harness.start).not.toHaveBeenCalled();
    expect(screen.getByTestId("visual-state").textContent).toBe("none");

    act(() => harness.onEvent?.({
      protocolVersion: 1,
      type: "transcript.final",
      turnId: "spoken-response-1",
      text: "Water boils at 99.97 degrees Celsius.",
      interrupted: false,
    }));
    expect(harness.start).toHaveBeenCalledWith(
      expect.objectContaining({
        concept: "Water boils at 99.97 degrees Celsius",
        continuityKey: "conversation-water-boils-at-99-97-degrees-celsius", // gitleaks:allow -- deterministic test identifier
        teachingIntent: "Explain Water boils at 99.97 degrees Celsius.",
        visualDescription: "Water boils at 99.97 degrees Celsius",
        durationSeconds: 5,
      }),
      1,
      expect.any(String),
    );
    const firstVisualDescription = harness.start.mock.calls[0]?.[0].visualDescription;
    expect(firstVisualDescription).toBe(
      "Water boils at 99.97 degrees Celsius",
    );
    expect(firstVisualDescription).not.toContain("REAL WORLD");
    expect(firstVisualDescription).not.toContain("0.00");

    act(() => harness.onEvent?.({
      protocolVersion: 1,
      type: "transcript.final",
      turnId: "spoken-response-2",
      text: "Ancient surveyors measured circular buildings with rope.",
      interrupted: false,
    }));
    expect(harness.replace).toHaveBeenCalledWith(
      expect.objectContaining({
        continuityKey: "conversation-ancient-surveyors-measured-circular-buildings-with-rope",
        visualDescription:
          "Ancient surveyors measured circular buildings with rope",
        durationSeconds: 5,
      }),
      2,
      expect.any(String),
    );
    const continuingVisualDescription = harness.replace.mock.calls[0]?.[0].visualDescription;
    expect(continuingVisualDescription).toBe(
      "Ancient surveyors measured circular buildings with rope",
    );
    expect(continuingVisualDescription).not.toContain("HOW IT WORKS");
    expect(continuingVisualDescription).not.toContain("motion spine");
  });

  it("starts five-second generation from speech deltas before the turn finishes", () => {
    render(<LiveLessonShell sessionId="session-1" learnerId="learner-1" />);

    act(() => harness.onEvent?.({
      protocolVersion: 1,
      type: "transcript.delta",
      turnId: "streaming-turn",
      text: "Heat moves through metal as particles collide ",
    }));

    expect(harness.start).toHaveBeenCalledWith(
      expect.objectContaining({
        visualDescription: "Heat moves through metal as particles collide",
        durationSeconds: 5,
      }),
      1,
      expect.any(String),
    );

    act(() => harness.onEvent?.({
      protocolVersion: 1,
      type: "transcript.delta",
      turnId: "streaming-turn",
      text: "Collisions transfer energy into neighboring particles. ",
    }));

    expect(harness.redirect).toHaveBeenCalledWith(
      expect.objectContaining({
        visualDescription:
          "Collisions transfer energy into neighboring particles",
        durationSeconds: 5,
      }),
      2,
      expect.any(String),
    );

    act(() => harness.onEvent?.({
      protocolVersion: 1,
      type: "transcript.final",
      turnId: "streaming-turn",
      text: "Heat moves through metal as particles collide Collisions transfer energy into neighboring particles.",
      interrupted: false,
    }));

    expect(harness.start).toHaveBeenCalledOnce();
    expect(harness.redirect).toHaveBeenCalledOnce();
  });

  it("replaces old playback when the next tutor conversation produces a video", () => {
    render(<LiveLessonShell sessionId="session-1" learnerId="learner-1" />);
    act(() => harness.onEvent?.({
      protocolVersion: 1,
      type: "transcript.delta",
      turnId: "first-conversation",
      text: "Gravity bends a moving planet into a curved orbit. ",
    }));
    act(() => harness.onEvent?.({
      protocolVersion: 1,
      type: "transcript.delta",
      turnId: "second-conversation",
      text: "Magnetic field lines curve around a bar magnet. ",
    }));

    expect(harness.start).toHaveBeenCalledOnce();
    expect(harness.replace).toHaveBeenCalledWith(
      expect.objectContaining({
        visualDescription: "Magnetic field lines curve around a bar magnet",
        durationSeconds: 5,
      }),
      2,
      expect.any(String),
    );
    expect(harness.redirect).not.toHaveBeenCalled();
  });

  it("keeps filling the playback queue from the latest explanation", () => {
    vi.useFakeTimers();
    const view = render(<LiveLessonShell sessionId="session-1" learnerId="learner-1" />);
    act(() => harness.onEvent?.({
      protocolVersion: 1,
      type: "transcript.delta",
      turnId: "continuous-turn",
      text: "Gravity bends a moving planet into a curved orbit. ",
    }));
    act(() => harness.onEvent?.({
      protocolVersion: 1,
      type: "transcript.final",
      turnId: "continuous-turn",
      text: "Gravity bends a moving planet into a curved orbit.",
      interrupted: false,
    }));
    harness.redirect.mockClear();

    act(() => vi.advanceTimersByTime(1_500));

    expect(harness.redirect).toHaveBeenCalledTimes(2);
    expect(harness.redirect).toHaveBeenLastCalledWith(
      expect.objectContaining({
        visualDescription: "Gravity bends a moving planet into a curved orbit",
        durationSeconds: 5,
      }),
      3,
      expect.any(String),
    );

    harness.director.canGenerate.mockReturnValue(false);
    act(() => vi.advanceTimersByTime(1_500));
    expect(harness.redirect).toHaveBeenCalledTimes(2);
    view.unmount();
    vi.useRealTimers();
  });

  it("keeps the current video playing until the interrupted topic is replaced", () => {
    vi.useFakeTimers();
    const view = render(<LiveLessonShell sessionId="session-1" learnerId="learner-1" />);

    act(() => harness.onEvent?.({
      protocolVersion: 1,
      type: "transcript.delta",
      turnId: "interrupted-turn",
      text: "Gravity bends a moving planet into a curved orbit. ",
    }));
    expect(harness.start).toHaveBeenCalledOnce();

    act(() => harness.onEvent?.({
      protocolVersion: 1,
      type: "transcript.final",
      turnId: "interrupted-turn",
      text: "Gravity bends a moving planet into a curved orbit.",
      interrupted: true,
    }));
    expect(harness.continuePlaybackUntilReplacement).toHaveBeenCalledOnce();
    expect(harness.stop).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1_500));
    expect(harness.start).toHaveBeenCalledOnce();
    expect(harness.redirect).not.toHaveBeenCalled();

    act(() => harness.onEvent?.({
      protocolVersion: 1,
      type: "transcript.delta",
      turnId: "replacement-turn",
      text: "Magnetic field lines curve around a bar magnet. ",
    }));

    expect(harness.start).toHaveBeenCalledOnce();
    expect(harness.replace).toHaveBeenCalledWith(
      expect.objectContaining({
        visualDescription: "Magnetic field lines curve around a bar magnet",
        durationSeconds: 5,
      }),
      2,
      expect.any(String),
    );
    expect(harness.redirect).not.toHaveBeenCalled();
    view.unmount();
    vi.useRealTimers();
  });
  it("resolves an abandoned redirect back to the clip that remains on screen", () => {
    const view = render(
      <LiveLessonShell sessionId="session-1" learnerId="learner-1" />,
    );
    act(() => harness.onEvent?.({
      protocolVersion: 1,
      type: "transcript.final",
      turnId: "spoken-response-1",
      text: "Pi was discovered by measuring circles.",
      interrupted: false,
    }));
    expect(screen.getByTestId("visual-state").textContent).toBe(
      "live:Pi was discovered by measuring circles",
    );
    act(() => harness.onEvent?.({
      protocolVersion: 1,
      type: "transcript.final",
      turnId: "spoken-response-2",
      text: "Ancient surveyors measured circular buildings with rope.",
      interrupted: false,
    }));
    expect(screen.getByTestId("visual-state").textContent).toBe(
      "redirecting:Ancient surveyors measured circular buildings with rope",
    );

    act(() => {
      harness.director.status = "generating";
      harness.director.preservedPromptVersion = 2;
      view.rerender(
        <LiveLessonShell sessionId="session-1" learnerId="learner-1" />,
      );
    });

    expect(screen.getByTestId("visual-state").textContent).toBe(
      "live:Pi was discovered by measuring circles",
    );
  });
  it("mounts the generated video when one visual revision resolves into holding state", async () => {
    harness.start.mockImplementation(async () => {
      harness.director.status = "holding";
      harness.director.promptVersion = 1;
      return true;
    });
    render(<LiveLessonShell sessionId="session-1" learnerId="learner-1" />);

    await act(async () => {
      harness.onEvent?.({
        protocolVersion: 1,
        type: "visual.start",
        revision: 1,
        visualOperationId: "visual-op-1",
        spec,
      });
      await Promise.resolve();
    });

    const video = screen.getByTestId("generated-video") as HTMLVideoElement;
    expect(video.src).toBe("https://v3.fal.media/files/orbit.mp4");
    expect(harness.director.videoRef).toHaveBeenCalledWith(video);
    expect(harness.start).toHaveBeenCalledOnce();
  });
});
