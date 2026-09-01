/** @vitest-environment jsdom */

import { act, cleanup, renderHook } from "@testing-library/react";
import type { SessionEvent } from "@axiom/protocol";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { useTutorSession } from "./useTutorSession";

interface MockSession {
  open: Mock<() => Promise<void>>;
  sendText: Mock<() => Promise<void>>;
  selectCard: Mock<() => Promise<void>>;
  interrupt: Mock<() => Promise<void>>;
  close: Mock<(reason: "complete" | "abandoned" | "error") => Promise<void>>;
}

interface MockTransport {
  callbacks: {
    initialCommandRevision?: number;
    onSessionEvent: (event: SessionEvent) => void;
    onSpeechStarted: (context: { turnId: string; heardCharacters: number } | null) => void;
  };
  setMicrophoneMuted: Mock<(muted: boolean) => Promise<void>>;
  setSessionEstablishmentAttempt: Mock<(attempt: unknown) => void>;
  dispose: Mock<() => void>;
}

const harness = vi.hoisted(() => ({
  sessions: [] as MockSession[],
  transports: [] as MockTransport[],
  resolveOpen: undefined as undefined | (() => void),
  stallOpen: false,
  transportMode: "text" as "voice" | "text",
}));

vi.mock("@/lib/realtime/browser-realtime-transport", () => ({
  BrowserRealtimeTransport: class {
    mode = harness.transportMode;
    readonly setMicrophoneMuted = vi.fn(async () => undefined);
    readonly dispose = vi.fn();
    readonly setSessionEstablishmentAttempt = vi.fn();
    readonly cancelResponse = vi.fn(async () => undefined);
    readonly clearOutputAudio = vi.fn(async () => undefined);

    constructor(
      readonly callbacks: {
        initialCommandRevision?: number;
        onSessionEvent: (event: SessionEvent) => void;
        onSpeechStarted: (context: { turnId: string; heardCharacters: number } | null) => void;
      },
    ) {
      harness.transports.push(this as unknown as MockTransport);
    }
  },
}));

vi.mock("@axiom/domain", () => ({
  RealtimeTutorSession: class {
    private opened = false;
    readonly open = vi.fn(async () => {
      if (!harness.stallOpen) {
        this.transport.callbacks.onSessionEvent({
          protocolVersion: 1,
          type: "session.status",
          state: "text_only",
        });
      }
      await new Promise<void>((resolve) => {
        harness.resolveOpen = resolve;
      });
      this.opened = true;
    });
    readonly sendText = vi.fn(async () => {
      if (!this.opened) throw new Error("Tutor session is not active.");
      this.transport.callbacks.onSessionEvent({
        protocolVersion: 1,
        type: "session.status",
        state: "thinking",
      });
    });
    readonly selectCard = vi.fn(async () => {
      if (!this.opened) throw new Error("Tutor session is not active.");
      this.transport.callbacks.onSessionEvent({
        protocolVersion: 1,
        type: "session.status",
        state: "redirecting",
      });
    });
    readonly interrupt = vi.fn(async () => {
      if (!this.opened) throw new Error("Tutor session is not active.");
    });
    readonly resume = vi.fn(async () => undefined);
    readonly close = vi.fn(async () => undefined);
    readonly appendAssistantTranscript = vi.fn();
    readonly handleConnectionFailure = vi.fn(async () => undefined);

    constructor(
      private readonly transport: { callbacks: { onSessionEvent: (event: SessionEvent) => void } },
    ) {
      harness.sessions.push(this);
    }
  },
}));

const recoveredEvents: SessionEvent[] = [
  {
    protocolVersion: 1,
    type: "transcript.final",
    turnId: "tutor-1",
    text: "Gravity bends the Moon's path.",
    interrupted: false,
  },
  {
    protocolVersion: 1,
    type: "session.status",
    state: "text_only",
    detail: "Continue by typing.",
  },
];

describe("useTutorSession recovery", () => {
  beforeEach(() => {
    harness.sessions.length = 0;
    harness.transports.length = 0;
    harness.resolveOpen = undefined;
    harness.stallOpen = false;
    harness.transportMode = "text";
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("installs recovered events once without replaying them to the live callback", () => {
    const onEvent = vi.fn();
    const { result } = renderHook(() => useTutorSession({
      sessionId: "00000000-0000-4000-8000-000000000001",
      learnerId: "learner-1",
      autoOpen: false,
      initialEvents: recoveredEvents,
      initialState: "text_only",
      onEvent,
    }));

    expect(result.current.events).toEqual(recoveredEvents);
    expect(result.current.state).toBe("text_only");
    expect(onEvent).not.toHaveBeenCalled();
    expect(harness.transports[0].callbacks.initialCommandRevision).toBeUndefined();
  });

  it("resumes an established microphone synchronously in the button gesture", async () => {
    const { result } = renderHook(() => useTutorSession({
      sessionId: "00000000-0000-4000-8000-000000000001",
      learnerId: "learner-1",
      autoOpen: false,
    }));
    let openPromise!: Promise<void>;
    act(() => {
      openPromise = result.current.open();
    });
    await act(async () => {
      harness.resolveOpen?.();
      await openPromise;
    });
    const transport = harness.transports[0];
    transport.setMicrophoneMuted.mockClear();

    let activation!: Promise<void>;
    act(() => {
      activation = result.current.setMicrophoneMuted(false);
      expect(transport.setMicrophoneMuted).toHaveBeenCalledWith(false);
    });
    await act(async () => activation);
  });

  it("starts a connected voice session with automatic listening enabled", async () => {
    harness.transportMode = "voice";
    const { result } = renderHook(() => useTutorSession({
      sessionId: "00000000-0000-4000-8000-000000000001",
      learnerId: "learner-1",
      autoOpen: true,
    }));

    await act(async () => Promise.resolve());
    await act(async () => {
      harness.resolveOpen?.();
      await Promise.resolve();
    });

    expect(harness.transports[0].setMicrophoneMuted).toHaveBeenCalledWith(false);
    expect(result.current.mode).toBe("voice");
    expect(result.current.micMuted).toBe(false);
  });

  it("treats an unconfigured realtime provider as a stable typed session", () => {
    const { result } = renderHook(() => useTutorSession({
      sessionId: "00000000-0000-4000-8000-000000000001",
      learnerId: "learner-1",
      autoOpen: false,
    }));

    act(() => {
      harness.transports[0].callbacks.onSessionEvent({
        protocolVersion: 1,
        type: "session.error",
        recoverable: true,
        code: "OPENAI_NOT_CONFIGURED",
      });
      harness.transports[0].callbacks.onSessionEvent({
        protocolVersion: 1,
        type: "session.status",
        state: "text_only",
        detail: "Voice is unavailable. Continue by typing.",
      });
    });

    expect(result.current.state).toBe("text_only");
    expect(result.current.mode).toBe("text");
    expect(result.current.error).toBeNull();
  });

  it("holds text, card, and interrupt commands until the in-flight open is truly ready", async () => {
    const { result } = renderHook(() => useTutorSession({
      sessionId: "00000000-0000-4000-8000-000000000001",
      learnerId: "learner-1",
      autoOpen: true,
    }));

    await act(async () => Promise.resolve());
    const session = harness.sessions[0];
    expect(result.current.state).toBe("text_only");

    let sendPromise: Promise<void>;
    let selectPromise: Promise<void>;
    let interruptPromise: Promise<void>;
    act(() => {
      sendPromise = result.current.sendText("Why does it orbit?");
      selectPromise = result.current.selectCard({ id: "speed", title: "Change speed", revision: 1 });
      interruptPromise = result.current.interrupt({ turnId: "tutor-1", heardCharacters: 12 });
    });
    expect(session.sendText).not.toHaveBeenCalled();
    expect(session.selectCard).not.toHaveBeenCalled();
    expect(session.interrupt).not.toHaveBeenCalled();

    await act(async () => {
      harness.resolveOpen?.();
      await Promise.all([sendPromise!, selectPromise!, interruptPromise!]);
    });

    expect(session.open).toHaveBeenCalledOnce();
    expect(session.open).toHaveBeenCalledWith({
      sessionId: "00000000-0000-4000-8000-000000000001",
      learnerId: "learner-1",
    });
    expect(session.sendText).toHaveBeenCalledWith("Why does it orbit?");
    expect(session.selectCard).toHaveBeenCalledOnce();
    expect(session.interrupt).toHaveBeenCalledOnce();
    expect(result.current.state).toBe("redirecting");
  });

  it("turns automatic speech detection into a tutor interruption", async () => {
    renderHook(() => useTutorSession({
      sessionId: "00000000-0000-4000-8000-000000000001",
      learnerId: "learner-1",
      autoOpen: true,
    }));

    await act(async () => {
      harness.resolveOpen?.();
      await Promise.resolve();
    });
    const interruption = { turnId: "tutor-1", heardCharacters: 18 };
    act(() => {
      harness.transports[0].callbacks.onSpeechStarted(interruption);
    });
    await act(async () => Promise.resolve());

    expect(harness.sessions[0].interrupt).toHaveBeenCalledWith(interruption);
  });

  it("passes the recovered command revision to a new transport", () => {
    renderHook(() => useTutorSession({
      sessionId: "00000000-0000-4000-8000-000000000001",
      learnerId: "learner-1",
      autoOpen: false,
      initialEvents: recoveredEvents,
      initialState: "text_only",
      initialCommandRevision: 7,
    }));

    expect(harness.transports[0].callbacks.initialCommandRevision).toBe(7);
  });

  it("turns a connecting stall into a recoverable text state", async () => {
    vi.useFakeTimers();
    harness.stallOpen = true;
    const { result } = renderHook(() => useTutorSession({
      sessionId: "00000000-0000-4000-8000-000000000001",
      learnerId: "learner-1",
      autoOpen: true,
    }));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });

    expect(result.current.state).toBe("text_only");
    expect(result.current.error).toMatchObject({
      code: "connecting_timeout",
      recoverable: true,
    });
    expect(harness.transports[0].dispose).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });
  it("restores the typed composer with a recoverable error when a turn fails", async () => {
    const { result } = renderHook(() => useTutorSession({
      sessionId: "00000000-0000-4000-8000-000000000001",
      learnerId: "learner-1",
      autoOpen: true,
    }));
    const session = harness.sessions[0];
    await act(async () => {
      harness.resolveOpen?.();
      await Promise.resolve();
    });
    session.sendText.mockRejectedValueOnce(new Error("provider unavailable"));

    await act(async () => {
      await expect(result.current.sendText("Why does it orbit?")).rejects.toThrow(
        "provider unavailable",
      );
    });

    expect(result.current.state).toBe("text_only");
    expect(result.current.error).toMatchObject({
      code: "operation_failed",
      recoverable: true,
    });
  });


  it("keeps a failed terminal close recoverable and retries the same reason", async () => {
    const { result } = renderHook(() => useTutorSession({
      sessionId: "00000000-0000-4000-8000-000000000001",
      learnerId: "learner-1",
      autoOpen: true,
    }));
    const session = harness.sessions[0];
    await act(async () => {
      harness.resolveOpen?.();
      await Promise.resolve();
    });
    session.close.mockRejectedValueOnce(new Error("network unavailable"));

    await act(async () => {
      await expect(result.current.close("abandoned")).rejects.toThrow("network unavailable");
    });

    expect(result.current.state).not.toBe("ended");
    expect(result.current.error).toMatchObject({ code: "close_failed", recoverable: true });

    await act(async () => {
      await result.current.retry();
    });

    expect(session.close).toHaveBeenNthCalledWith(1, "abandoned");
    expect(session.close).toHaveBeenNthCalledWith(2, "abandoned");
  });
});
