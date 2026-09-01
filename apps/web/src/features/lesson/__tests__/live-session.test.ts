import { describe, expect, it } from "vitest";
import type { SessionEvent } from "@axiom/protocol";
import {
  INITIAL_LIVE_STATE,
  reduceLiveLesson,
  createRecoveredLiveLessonState,
  mergeRecoveredSessionEvents,
  reduceSessionEvent,
  shouldApplyRevisionedEvent,
} from "../live-session";

const spec = {
  concept: "Orbital motion",
  teachingIntent: "Show free fall with sideways velocity",
  visualDescription: "Earth with the Moon tracing an ellipse",
  durationSeconds: 5 as const,
  continuityKey: "physics-orbits",
};

const cardsEvent: Extract<SessionEvent, { type: "canvas.cards.replace" }> = {
  protocolVersion: 1,
  type: "canvas.cards.replace",
  revision: 2,
  purpose: "branch",
  prompt: "Where next?",
  cards: [
    { id: "a", title: "Faster", description: "Speed it up.", spokenAliases: [] },
  ],
};

const recoveredState = {
  revision: 3,
  status: "text_only" as const,
  learnerId: "learner-1",
  startedAt: "2026-08-31T10:00:00.000Z",
  updatedAt: "2026-08-31T10:01:00.000Z",
  turnCount: 1,
  concepts: ["Orbital motion", "Escape velocity"],
  mastery: [{ concept: "Orbital motion", confidence: 0.6, evidenceCount: 3 }],
  explorationEdges: [{ from: "Orbital motion", to: "Escape velocity" }],
  cards: {
    purpose: cardsEvent.purpose,
    prompt: cardsEvent.prompt,
    cards: cardsEvent.cards,
    revision: cardsEvent.revision,
  },
  visual: { visualOperationId: "visual-op-3", spec },
  lastEvents: [
    {
      protocolVersion: 1 as const,
      type: "transcript.final" as const,
      turnId: "tutor-1",
      text: "Gravity bends the path.",
      interrupted: false,
    },
    cardsEvent,
    {
      protocolVersion: 1 as const,
      type: "visual.start" as const,
      revision: 3,
      visualOperationId: "visual-op-3",
      spec,
    },
  ],
};


describe("live session reducer", () => {
  it("installs cards with their revision", () => {
    const s = reduceSessionEvent(INITIAL_LIVE_STATE, cardsEvent);
    expect(s.activeCards?.cards[0].id).toBe("a");
    expect(s.activeCards?.revision).toBe(2);
    expect(s.revision).toBe(2);
  });

  it("hydrates the authoritative snapshot and recovered transcript without resetting revision", () => {
    const state = createRecoveredLiveLessonState(recoveredState, recoveredState.lastEvents);

    expect(state.revision).toBe(3);
    expect(state.turns.map((turn) => turn.text)).toEqual(["Gravity bends the path."]);
    expect(state.activeCards?.revision).toBe(2);
    expect(state.visual).toMatchObject({ revision: 3, phase: "live" });
    expect(state.graph.nodes.map((node) => node.label)).toEqual(["Orbital motion", "Escape velocity"]);
    expect(state.visual?.visualOperationId).toBe("visual-op-3");
    expect(state.mastery).toEqual([
      { concept: "Orbital motion", mastery: 0.6, evidenceCount: 3 },
    ]);
    expect(state.graph.edges).toEqual([
      { from: "orbital-motion", to: "escape-velocity" },
    ]);
  });

  it("merges overlapping snapshot and fanout events once in chronological order", () => {
    const initial = recoveredState.lastEvents[0];
    const merged = mergeRecoveredSessionEvents(
      [initial, cardsEvent],
      [cardsEvent],
    );

    expect(merged).toEqual([initial, cardsEvent]);
  });

  it("ignores stale card events with older revisions", () => {
    const s = reduceSessionEvent(INITIAL_LIVE_STATE, cardsEvent);
    const stale: SessionEvent = { ...cardsEvent, revision: 1, prompt: "Stale" };
    const next = reduceSessionEvent(s, stale);
    expect(next).toBe(s);
    expect(next.activeCards?.prompt).toBe("Where next?");
  });

  it("keeps learner questions before their tutor replies across multiple turns", () => {
    let state = reduceLiveLesson(INITIAL_LIVE_STATE, {
      type: "learner.turn",
      turn: {
        turnId: "learner-1",
        role: "learner",
        text: "Why do planets orbit?",
        interrupted: false,
        final: true,
      },
    });
    state = reduceLiveLesson(state, {
      protocolVersion: 1,
      type: "transcript.final",
      turnId: "tutor-1",
      text: "Gravity bends their motion.",
      interrupted: false,
    });
    state = reduceLiveLesson(state, {
      type: "learner.turn",
      turn: {
        turnId: "learner-2",
        role: "learner",
        text: "What if they move faster?",
        interrupted: false,
        final: true,
      },
    });
    state = reduceLiveLesson(state, {
      protocolVersion: 1,
      type: "transcript.final",
      turnId: "tutor-2",
      text: "A faster planet follows a wider path.",
      interrupted: false,
    });

    expect(state.turns.map(({ role, text }) => `${role}:${text}`)).toEqual([
      "learner:Why do planets orbit?",
      "tutor:Gravity bends their motion.",
      "learner:What if they move faster?",
      "tutor:A faster planet follows a wider path.",
    ]);
  });
  it("removes obsolete cards when a tutor turn is interrupted", () => {
    const withCards = reduceSessionEvent(INITIAL_LIVE_STATE, cardsEvent);
    const interrupted = reduceLiveLesson(withCards, {
      protocolVersion: 1,
      type: "transcript.final",
      turnId: "tutor-1",
      text: "Gravity bends—",
      interrupted: true,
    });

    expect(interrupted.activeCards).toBeNull();
    expect(interrupted.turns[0]).toMatchObject({ interrupted: true, final: true });
  });

  it("clears cards while holding the current visual on learner interruption", () => {
    const withCardsAndVisual = reduceSessionEvent(
      reduceSessionEvent(INITIAL_LIVE_STATE, {
        protocolVersion: 1,
        type: "visual.start",
        revision: 1,
        visualOperationId: "visual-op-1",
        spec,
      }),
      cardsEvent,
    );

    const interrupted = reduceLiveLesson(withCardsAndVisual, { type: "learner.interrupt" });

    expect(interrupted.activeCards).toBeNull();
    expect(interrupted.visual).toEqual({
      ...withCardsAndVisual.visual,
      phase: "held",
      stopReason: "interrupted",
    });
  });


  it("updates the active tutor turn without copying completed history", () => {
    const completed = Array.from({ length: 1_000 }, (_, index) => ({
      turnId: `learner-${index}`,
      role: "learner" as const,
      text: `Question ${index}`,
      interrupted: false,
      final: true,
    }));
    const before = { ...INITIAL_LIVE_STATE, turns: completed };
    const started = reduceLiveLesson(before, {
      protocolVersion: 1,
      type: "transcript.delta",
      turnId: "tutor-1",
      text: "Gravity ",
    });
    const updated = reduceLiveLesson(started, {
      protocolVersion: 1,
      type: "transcript.delta",
      turnId: "tutor-1",
      text: "bends motion.",
    });

    expect(started.turns).toBe(completed);
    expect(updated.turns).toBe(completed);
    expect(updated.activeTurn).toEqual({
      turnId: "tutor-1",
      role: "tutor",
      text: "Gravity bends motion.",
      interrupted: false,
      final: false,
    });
  });

  it("commits the active tutor turn on interruption", () => {
    const streaming = reduceLiveLesson(INITIAL_LIVE_STATE, {
      protocolVersion: 1,
      type: "transcript.delta",
      turnId: "tutor-1",
      text: "Gravity bends—",
    });

    const interrupted = reduceLiveLesson(streaming, { type: "learner.interrupt" });

    expect(interrupted.activeTurn).toBeNull();
    expect(interrupted.turns.at(-1)).toMatchObject({
      turnId: "tutor-1",
      text: "Gravity bends—",
      interrupted: true,
      final: true,
    });
  });

  it("merges a late interruption final without reordering later turns", () => {
    let state = reduceLiveLesson(INITIAL_LIVE_STATE, {
      protocolVersion: 1,
      type: "transcript.delta",
      turnId: "tutor-1",
      text: "Gravity bends—",
    });
    state = reduceLiveLesson(state, { type: "learner.interrupt" });
    state = reduceLiveLesson(state, {
      type: "learner.turn",
      turn: {
        turnId: "learner-1",
        role: "learner",
        text: "Can you explain that another way?",
        interrupted: false,
        final: true,
      },
    });
    state = reduceLiveLesson(state, {
      protocolVersion: 1,
      type: "transcript.final",
      turnId: "tutor-1",
      text: "Gravity bends the path—",
      interrupted: true,
    });

    expect(state.turns.map((turn) => turn.turnId)).toEqual(["tutor-1", "learner-1"]);
    expect(state.turns[0].text).toBe("Gravity bends the path—");
  });

  it("visual.start goes live and grows the exploration graph", () => {
    const s = reduceSessionEvent(INITIAL_LIVE_STATE, {
      protocolVersion: 1,
      type: "visual.start",
      revision: 1,
      visualOperationId: "visual-op-1",
      spec,
    });
    expect(s.visual?.phase).toBe("live");
    expect(s.graph.nodes.map((n) => n.label)).toContain("Orbital motion");
  });

  it("visual.redirect marks redirecting until the prompt is applied", () => {
    let s = reduceSessionEvent(INITIAL_LIVE_STATE, {
      protocolVersion: 1,
      type: "visual.start",
      revision: 1,
      visualOperationId: "visual-op-1",
      spec,
    });
    s = reduceSessionEvent(s, {
      protocolVersion: 1,
      type: "visual.redirect",
      revision: 2,
      visualOperationId: "visual-op-2",
      spec,
    });
    expect(s.visual?.phase).toBe("redirecting");
    expect(s.visual?.revision).toBe(2);
  });

  it("a stale redirect cannot overwrite a newer visual", () => {
    const s = reduceSessionEvent(INITIAL_LIVE_STATE, {
      protocolVersion: 1,
      type: "visual.start",
      revision: 3,
      visualOperationId: "visual-op-3",
      spec,
    });
    const next = reduceSessionEvent(s, {
      protocolVersion: 1,
      type: "visual.redirect",
      revision: 2,
      visualOperationId: "visual-op-2",
      spec,
    });
    expect(next).toBe(s);
    expect(next.visual?.phase).toBe("live");
  });

  it("does not forward stale visual requests to the director", () => {
    const stale: SessionEvent = {
      protocolVersion: 1,
      type: "visual.start",
      revision: 2,
      visualOperationId: "visual-op-2",
      spec,
    };
    expect(shouldApplyRevisionedEvent(3, stale)).toBe(false);
    expect(shouldApplyRevisionedEvent(2, stale)).toBe(true);
  });

  it("visual.stop holds the frame with its reason", () => {
    let s = reduceSessionEvent(INITIAL_LIVE_STATE, {
      protocolVersion: 1,
      type: "visual.start",
      revision: 1,
      visualOperationId: "visual-op-1",
      spec,
    });
    s = reduceSessionEvent(s, { protocolVersion: 1, type: "visual.stop", revision: 2, reason: "interrupted" });
    expect(s.visual?.phase).toBe("held");
    expect(s.visual?.stopReason).toBe("interrupted");
  });

  it("learning.progress replaces the mastery view", () => {
    const s = reduceSessionEvent(INITIAL_LIVE_STATE, {
      protocolVersion: 1,
      type: "learning.progress",
      concepts: [{ concept: "Orbital motion", mastery: 0.4, evidenceCount: 2 }],
    });
    expect(s.mastery).toHaveLength(1);
    expect(s.mastery[0].mastery).toBe(0.4);
  });

  it("consumes visible cards when a learner turn begins", () => {
    const withCards = reduceSessionEvent(INITIAL_LIVE_STATE, cardsEvent);
    const state = reduceLiveLesson(withCards, {
      type: "learner.turn",
      turn: {
        turnId: "learner-1",
        role: "learner",
        text: "Go faster",
        interrupted: false,
        final: true,
      },
    });
    expect(state.activeCards).toBeNull();
  });
});
