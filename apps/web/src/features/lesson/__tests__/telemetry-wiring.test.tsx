import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  metrics: {
    startSessionEstablishment: vi.fn(),
    markSessionPermission: vi.fn(),
    finishSessionEstablishment: vi.fn(),
    startTypedFirstToken: vi.fn(),
    finishTypedFirstToken: vi.fn(),
    startInterruption: vi.fn(),
    finishInterruption: vi.fn(),
    recordDegradedMode: vi.fn(),
    recordStaleRevisionDrop: vi.fn(),
  },
  useTutorSession: vi.fn(),
}));

vi.mock("@/lib/telemetry/browser-metrics", () => ({
  getBrowserLaunchMetrics: () => mocks.metrics,
}));

vi.mock("@/hooks/useTutorSession", () => ({
  useTutorSession: mocks.useTutorSession,
}));

vi.mock("@/hooks/useVisualDirector", () => ({
  useVisualDirector: () => ({
    status: "idle",
    promptVersion: null,
    failure: null,
    reducedMotion: false,
    videoRef: { current: null },
    start: vi.fn(),
    replace: vi.fn(),
    redirect: vi.fn(),
    canGenerate: vi.fn(() => false),
    stop: vi.fn(),
    continuePlaybackUntilReplacement: vi.fn(),
  }),
}));

vi.mock("../LessonShell", () => ({
  LessonView: () => <div>Lesson</div>,
}));

import { LiveLessonShell } from "../LiveLessonShell";

describe("LiveLessonShell telemetry wiring", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.useTutorSession.mockReturnValue({
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
      sendText: vi.fn(),
      selectCard: vi.fn(),
      close: vi.fn(),
    });
  });

  it("injects the real browser singleton boundary into the tutor session", () => {
    render(<LiveLessonShell sessionId="session-1" learnerId="learner-1" />);

    expect(mocks.useTutorSession).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "session-1",
        learnerId: "learner-1",
        metrics: mocks.metrics,
      }),
    );
  });
});
