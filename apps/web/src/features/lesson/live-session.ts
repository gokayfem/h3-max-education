import type { SessionEvent, SessionState, VisualSpec } from "@axiom/protocol";
import type { CardSet, MasteryView, TopicGraphState, TranscriptTurn, VisualState } from "./types";

/**
 * Reduces the realtime SessionEvent stream (from useTutorSession's onEvent)
 * into the lesson surface's card, mastery, graph, and visual state.
 *
 * All state-changing events carry monotonic revisions; stale events (revision
 * lower than the last applied) are ignored so a late card or visual can never
 * overwrite a newer branch.
 */
export type LiveLessonAction =
  | SessionEvent
  | { type: "learner.turn"; turn: TranscriptTurn }
  | { type: "learner.interrupt" };

export interface LiveLessonState {
  activeCards: CardSet | null;
  mastery: MasteryView[];
  graph: TopicGraphState;
  visual: VisualState | null;
  turns: TranscriptTurn[];
  activeTurn: TranscriptTurn | null;
  /** highest revision applied so far */
  revision: number;
}

export interface RecoveredLessonState {
  revision: number;
  status: Extract<SessionState, "text_only" | "thinking" | "ended">;
  concepts: string[];
  cards: CardSet | null;
  mastery?: { concept: string; confidence: number; evidenceCount: number }[];
  explorationEdges?: { from: string; to: string }[];
  visual: { visualOperationId: string; spec: VisualSpec } | null;
  lastEvents: SessionEvent[];
  visualAllowance?: {
    remainingSeconds: number;
    dailyLimitSeconds: number;
  };
}

export const INITIAL_LIVE_STATE: LiveLessonState = {
  activeCards: null,
  mastery: [],
  graph: { nodes: [], edges: [], activeId: "" },
  turns: [],
  activeTurn: null,
  visual: null,
  revision: 0,
};

function graphId(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function pushGraph(graph: TopicGraphState, label: string): TopicGraphState {
  const id = graphId(label);
  if (!id) return graph;
  if (graph.nodes.some((n) => n.id === id)) {
    return { ...graph, activeId: id };
  }
  const edges = graph.activeId ? [...graph.edges, { from: graph.activeId, to: id }] : graph.edges;
  return { nodes: [...graph.nodes, { id, label }], edges, activeId: id };
}

function createRecoveredGraph(recovered: RecoveredLessonState): TopicGraphState {
  const nodes = recovered.concepts
    .map((label) => ({ id: graphId(label), label }))
    .filter((node) => node.id.length > 0);
  const edges = recovered.explorationEdges
    ? recovered.explorationEdges.map((edge) => ({
        from: graphId(edge.from),
        to: graphId(edge.to),
      }))
    : recovered.concepts.slice(1).map((concept, index) => ({
        from: graphId(recovered.concepts[index]),
        to: graphId(concept),
      }));
  return {
    nodes,
    edges: edges.filter((edge) => edge.from.length > 0 && edge.to.length > 0),
    activeId: nodes.at(-1)?.id ?? "",
  };
}

function eventKey(event: SessionEvent): string {
  return JSON.stringify(event);
}

export function mergeRecoveredSessionEvents(
  fanoutEvents: SessionEvent[],
  snapshotEvents: SessionEvent[],
): SessionEvent[] {
  if (snapshotEvents.length === 0) return [...fanoutEvents];
  const fanoutKeys = fanoutEvents.map(eventKey);
  const snapshotKeys = snapshotEvents.map(eventKey);
  const containsSnapshot = fanoutKeys.some((_, startIndex) =>
    snapshotKeys.every((key, offset) => fanoutKeys[startIndex + offset] === key));
  if (containsSnapshot) return [...fanoutEvents];

  const maximumOverlap = Math.min(fanoutKeys.length, snapshotKeys.length);
  for (let overlap = maximumOverlap; overlap > 0; overlap -= 1) {
    const fanoutSuffix = fanoutKeys.slice(-overlap);
    const snapshotPrefix = snapshotKeys.slice(0, overlap);
    if (fanoutSuffix.every((key, index) => key === snapshotPrefix[index])) {
      return [...fanoutEvents, ...snapshotEvents.slice(overlap)];
    }
  }
  return [...fanoutEvents, ...snapshotEvents];
}

export function createRecoveredLiveLessonState(
  recovered: RecoveredLessonState,
  events: SessionEvent[],
): LiveLessonState {
  const graph = createRecoveredGraph(recovered);
  const snapshot: LiveLessonState = {
    ...INITIAL_LIVE_STATE,
    revision: recovered.revision,
    mastery: (recovered.mastery ?? []).map((concept) => ({
      concept: concept.concept,
      mastery: concept.confidence,
      evidenceCount: concept.evidenceCount,
    })),
    activeCards: recovered.cards,
    graph,
    visual: recovered.visual
      ? {
          spec: recovered.visual.spec,
          revision: recovered.revision,
          visualOperationId: recovered.visual.visualOperationId,
          phase: "live",
        }
      : null,
  };
  return events.reduce(reduceLiveLesson, snapshot);
}

export function shouldApplyRevisionedEvent(
  currentRevision: number,
  event: SessionEvent,
): boolean {
  return !("revision" in event) || event.revision >= currentRevision;
}

export function reduceLiveLesson(
  state: LiveLessonState,
  action: LiveLessonAction,
): LiveLessonState {
  if (action.type === "learner.turn") {
    const turns = state.activeTurn
      ? [
          ...state.turns,
          { ...state.activeTurn, interrupted: true, final: true },
          action.turn,
        ]
      : [...state.turns, action.turn];
    return {
      ...state,
      activeCards: null,
      turns,
      activeTurn: null,
    };
  }

  if (action.type === "learner.interrupt") {
    return {
      ...state,
      activeCards: null,
      visual: state.visual
        ? { ...state.visual, phase: "held", stopReason: "interrupted" }
        : null,
      turns: state.activeTurn
        ? [...state.turns, { ...state.activeTurn, interrupted: true, final: true }]
        : state.turns,
      activeTurn: null,
    };
  }

  if (action.type === "transcript.delta") {
    if (state.activeTurn?.turnId === action.turnId) {
      return {
        ...state,
        activeTurn: {
          ...state.activeTurn,
          text: `${state.activeTurn.text}${action.text}`,
        },
      };
    }

    return {
      ...state,
      turns: state.activeTurn
        ? [...state.turns, { ...state.activeTurn, interrupted: true, final: true }]
        : state.turns,
      activeTurn: {
        turnId: action.turnId,
        role: "tutor",
        text: action.text,
        interrupted: false,
        final: false,
      },
    };
  }

  if (action.type === "transcript.final") {
    const finalTurn: TranscriptTurn = {
      turnId: action.turnId,
      role: "tutor",
      text: action.text,
      interrupted: action.interrupted,
      final: true,
    };
    const committedIndex = state.turns.findIndex(
      (turn) => turn.turnId === action.turnId,
    );
    const turns = committedIndex >= 0
      ? state.turns.map((turn, index) => index === committedIndex ? finalTurn : turn)
      : [...state.turns, finalTurn];
    return {
      ...state,
      activeCards: action.interrupted ? null : state.activeCards,
      visual: action.interrupted && state.visual
        ? { ...state.visual, phase: "held", stopReason: "interrupted" }
        : state.visual,
      turns,
      activeTurn: state.activeTurn?.turnId === action.turnId
        ? null
        : state.activeTurn,
    };
  }

  return reduceSessionEvent(state, action);
}

export function reduceSessionEvent(
  state: LiveLessonState,
  event: SessionEvent,
): LiveLessonState {
  switch (event.type) {
    case "canvas.cards.replace": {
      if (!shouldApplyRevisionedEvent(state.revision, event)) return state;
      return {
        ...state,
        revision: event.revision,
        activeCards: {
          purpose: event.purpose,
          prompt: event.prompt,
          cards: event.cards,
          revision: event.revision,
        },
      };
    }

    case "visual.start": {
      if (!shouldApplyRevisionedEvent(state.revision, event)) return state;
      return {
        ...state,
        revision: event.revision,
        visual: {
          spec: event.spec,
          revision: event.revision,
          visualOperationId: event.visualOperationId,
          phase: "live",
        },
        graph: pushGraph(state.graph, event.spec.concept),
      };
    }

    case "visual.redirect": {
      if (!shouldApplyRevisionedEvent(state.revision, event)) return state;
      return {
        ...state,
        revision: event.revision,
        visual: {
          spec: event.spec,
          revision: event.revision,
          visualOperationId: event.visualOperationId,
          phase: "redirecting",
        },
        graph: pushGraph(state.graph, event.spec.concept),
      };
    }

    case "visual.stop": {
      if (!shouldApplyRevisionedEvent(state.revision, event) || !state.visual) return state;
      return {
        ...state,
        revision: event.revision,
        visual: { ...state.visual, phase: "held", stopReason: event.reason },
      };
    }

    case "learning.progress":
      return { ...state, mastery: event.concepts };

    default:
      return state;
  }
}
