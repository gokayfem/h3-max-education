/** @vitest-environment jsdom */

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ACTIVE_SESSION_STORAGE_KEY } from "@/lib/session-storage";
import { LearnClient } from "./LearnClient";

vi.mock("@/features/lesson/LiveLessonShell", () => ({
  LiveLessonShell: ({
    sessionId,
    learnerId,
    initialEvents,
    initialState,
    backfillEvents,
  }: {
    sessionId: string;
    learnerId: string;
    initialEvents?: unknown[];
    initialState?: { revision: number; cards: unknown; visual: unknown };
    backfillEvents?: unknown[];
  }) => (
    <div
      data-testid="live-lesson"
      data-session-id={sessionId}
      data-learner-id={learnerId}
      data-event-count={initialEvents?.length ?? 0}
      data-backfill-count={backfillEvents?.length ?? 0}
      data-revision={initialState?.revision}
      data-has-cards={String(initialState?.cards !== null)}
      data-has-visual={String(initialState?.visual !== null)}
    />
  ),
}));

const SESSION_ID = "00000000-0000-4000-8000-000000000001";
const NEW_SESSION_ID = "00000000-0000-4000-8000-000000000002";
const LEARNER_ID = "lrn_3xV7USq8K9h2mN5p";

const visualSpec = {
  concept: "Scientific modeling",
  teachingIntent: "Show how evidence updates a model",
  visualDescription: "Observations become a testable model and revised prediction",
  durationSeconds: 5,
  continuityKey: "scientific-model",
};
const recoveredEvents = [
  {
    protocolVersion: 1,
    type: "transcript.final",
    turnId: "tutor-1",
    text: "Evidence can strengthen or revise a scientific model.",
    interrupted: false,
  },
  {
    protocolVersion: 1,
    type: "canvas.cards.replace",
    revision: 3,
    purpose: "branch",
    prompt: "Where should we go next?",
    cards: [{ id: "evidence", title: "Test new evidence", description: "See how evidence changes the model.", spokenAliases: [] }],
  },
  { protocolVersion: 1, type: "visual.start", revision: 3, visualOperationId: "visual-op-3", spec: visualSpec },
  {
    protocolVersion: 1,
    type: "session.status",
    state: "text_only",
    detail: "Continue by typing or selecting a card.",
  },
] as const;
const recoveredState = {
  revision: 3,
  status: "text_only",
  learnerId: LEARNER_ID,
  startedAt: "2026-08-31T10:00:00.000Z",
  updatedAt: "2026-08-31T10:01:00.000Z",
  turnCount: 1,
  explorationEdges: [],
  mastery: [],
  concepts: ["Scientific modeling"],
  cards: {
    purpose: "branch",
    prompt: "Where should we go next?",
    cards: [{ id: "evidence", title: "Test new evidence", description: "See how evidence changes the model.", spokenAliases: [] }],
    revision: 3,
  },
  visual: { visualOperationId: "visual-op-3", spec: visualSpec },
  lastEvents: recoveredEvents,
};

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("LearnClient refresh recovery", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });
  it("renders an honest loading state while starting session creation immediately", () => {
    vi.mocked(fetch).mockImplementation(() => new Promise<Response>(() => undefined));

    render(<LearnClient learnerId={LEARNER_ID} />);

    expect(screen.getByRole("status")).toHaveTextContent("Preparing your science companion");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith("/api/session", expect.objectContaining({
      method: "POST",
    }));
  });

  it("creates an anonymous guest session before preparing the lesson", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(response({ learner: { learnerId: LEARNER_ID } }, 201))
      .mockResolvedValueOnce(response({ sessionId: NEW_SESSION_ID }, 201));

    render(<LearnClient />);

    expect(await screen.findByTestId("live-lesson")).toHaveAttribute(
      "data-learner-id",
      LEARNER_ID,
    );
    expect(fetch).toHaveBeenNthCalledWith(
      1,
      "/api/auth/session",
      expect.objectContaining({ method: "POST" }),
    );
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      "/api/session",
      expect.objectContaining({ method: "POST" }),
    );
  });


  it("reuses a valid recovered session without creating a replacement", async () => {
    window.sessionStorage.setItem(ACTIVE_SESSION_STORAGE_KEY, SESSION_ID);
    vi.mocked(fetch)
      .mockResolvedValueOnce(response({
        sessionId: SESSION_ID,
        state: recoveredState,
        events: recoveredEvents,
        cursor: recoveredEvents.length,
      }));

    render(<LearnClient learnerId={LEARNER_ID} />);

    const lesson = await screen.findByTestId("live-lesson");
    expect(lesson).toHaveAttribute("data-session-id", SESSION_ID);
    expect(lesson).toHaveAttribute("data-event-count", String(recoveredEvents.length));
    expect(lesson).toHaveAttribute("data-revision", "3");
    expect(lesson).toHaveAttribute("data-has-cards", "true");
    expect(lesson).toHaveAttribute("data-has-visual", "true");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(`/api/session/${SESSION_ID}/recover`, { cache: "no-store" });
    expect(window.sessionStorage.getItem(ACTIVE_SESSION_STORAGE_KEY)).toBe(SESSION_ID);
  });

  it("renders the first recovery immediately and backfills later pages through bounded event reads", async () => {
    window.sessionStorage.setItem(ACTIVE_SESSION_STORAGE_KEY, SESSION_ID);
    const firstPage = Array.from({ length: 100 }, (_, index) => ({
      protocolVersion: 1,
      type: "transcript.final",
      turnId: `turn-${index}`,
      text: `Recovered event ${index}`,
      interrupted: false,
    }));
    const lastEvent = {
      protocolVersion: 1,
      type: "transcript.final",
      turnId: "turn-100",
      text: "Recovered event 100",
      interrupted: false,
    };
    let resolveBackfill: ((value: Response) => void) | undefined;
    vi.mocked(fetch)
      .mockResolvedValueOnce(response({
        sessionId: SESSION_ID,
        state: { ...recoveredState, lastEvents: [] },
        events: firstPage,
        cursor: 100,
      }))
      .mockImplementationOnce(() => new Promise<Response>((resolve) => {
        resolveBackfill = resolve;
      }));

    render(<LearnClient learnerId={LEARNER_ID} />);

    const lesson = await screen.findByTestId("live-lesson");
    expect(lesson).toHaveAttribute("data-event-count", "0");
    expect(lesson).toHaveAttribute("data-backfill-count", "100");
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      `/api/session/${SESSION_ID}/events?cursor=100&once=1`,
      { cache: "no-store", signal: expect.anything() },
    );

    await act(async () => {
      resolveBackfill?.(response({ events: [lastEvent], nextCursor: 101 }));
    });
    await waitFor(() => {
      expect(screen.getByTestId("live-lesson")).toHaveAttribute("data-backfill-count", "1");
    });
  });

  it("keeps the lesson available and offers retry when history backfill fails", async () => {
    window.sessionStorage.setItem(ACTIVE_SESSION_STORAGE_KEY, SESSION_ID);
    const firstPage = Array.from({ length: 100 }, (_, index) => ({
      protocolVersion: 1,
      type: "transcript.final",
      turnId: `retry-turn-${index}`,
      text: `Recovered event ${index}`,
      interrupted: false,
    }));
    vi.mocked(fetch)
      .mockResolvedValueOnce(response({
        sessionId: SESSION_ID,
        state: { ...recoveredState, lastEvents: [] },
        events: firstPage,
        cursor: 100,
      }))
      .mockResolvedValueOnce(response({ error: { code: "temporarily_unavailable" } }, 503))
      .mockResolvedValueOnce(response({
        events: [{
          protocolVersion: 1,
          type: "transcript.final",
          turnId: "retry-turn-100",
          text: "Recovered after retry",
          interrupted: false,
        }],
        nextCursor: 101,
      }));

    render(<LearnClient learnerId={LEARNER_ID} />);

    expect(await screen.findByTestId("live-lesson")).toHaveAttribute("data-backfill-count", "100");
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Earlier lesson history could not be restored");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledTimes(3);
      expect(screen.getByTestId("live-lesson")).toHaveAttribute("data-backfill-count", "1");
    });
  });

  it("creates a new session when a successful recovery payload is invalid", async () => {
    window.sessionStorage.setItem(ACTIVE_SESSION_STORAGE_KEY, SESSION_ID);
    vi.mocked(fetch)
      .mockResolvedValueOnce(response({
        sessionId: SESSION_ID,
        state: { revision: 3 },
        events: [{ type: "transcript.final", text: "untyped" }],
        cursor: 1,
      }))
      .mockResolvedValueOnce(response({ sessionId: NEW_SESSION_ID }, 201));

    render(<LearnClient learnerId={LEARNER_ID} />);

    const lesson = await screen.findByTestId("live-lesson");
    expect(lesson).toHaveAttribute("data-session-id", NEW_SESSION_ID);
    expect(lesson).toHaveAttribute("data-event-count", "0");
    expect(window.sessionStorage.getItem(ACTIVE_SESSION_STORAGE_KEY)).toBe(NEW_SESSION_ID);
  });

  it.each([404, 410])(
    "creates and stores a new session when recovery returns %s",
    async (status) => {
      window.sessionStorage.setItem(ACTIVE_SESSION_STORAGE_KEY, SESSION_ID);
      vi.mocked(fetch)
        .mockResolvedValueOnce(response({ error: { code: "session_not_found" } }, status))
        .mockResolvedValueOnce(response({ sessionId: NEW_SESSION_ID }, 201));

      render(<LearnClient learnerId={LEARNER_ID} />);

      const lesson = await screen.findByTestId("live-lesson");
      expect(lesson).toHaveAttribute("data-session-id", NEW_SESSION_ID);
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(window.sessionStorage.getItem(ACTIVE_SESSION_STORAGE_KEY)).toBe(NEW_SESSION_ID);
    },
  );

  it("replaces invalid stored data with only a new opaque id", async () => {
    window.sessionStorage.setItem(ACTIVE_SESSION_STORAGE_KEY, JSON.stringify({
      sessionId: SESSION_ID,
      token: "secret",
      transcript: ["private"],
      profile: { displayName: "Maya" },
    }));
    vi.mocked(fetch)
      .mockResolvedValueOnce(response({ sessionId: NEW_SESSION_ID }, 201));

    render(<LearnClient learnerId={LEARNER_ID} />);

    await screen.findByTestId("live-lesson");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(window.sessionStorage.length).toBe(1);
    expect(window.sessionStorage.getItem(ACTIVE_SESSION_STORAGE_KEY)).toBe(NEW_SESSION_ID);
  });


  it("clears the matching active id after a successful normal close", async () => {
    window.sessionStorage.setItem(ACTIVE_SESSION_STORAGE_KEY, SESSION_ID);
    vi.mocked(fetch)
      .mockResolvedValueOnce(response({
        sessionId: SESSION_ID,
        state: recoveredState,
        events: recoveredEvents,
        cursor: recoveredEvents.length,
      }));
    render(<LearnClient learnerId={LEARNER_ID} />);
    expect(await screen.findByTestId("live-lesson")).toHaveAttribute(
      "data-event-count",
      String(recoveredEvents.length),
    );

    window.dispatchEvent(new CustomEvent("axiom:session-closed", { detail: { sessionId: SESSION_ID } }));
    await waitFor(() => {
      expect(window.sessionStorage.getItem(ACTIVE_SESSION_STORAGE_KEY)).toBeNull();
      expect(screen.getByTestId("live-lesson")).toHaveAttribute("data-event-count", "0");
    });
  });
});
