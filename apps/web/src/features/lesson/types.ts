/**
 * Component prop boundaries for the lesson surface.
 *
 * These mirror the wire types owned by @axiom/protocol (Card, VisualSpec,
 * SessionEvent, SessionState, MasteryView, BrowserCommand) and the tutor
 * interfaces owned by @axiom/domain.
 */

import type { RefCallback } from "react";

export type CardPurpose = "branch" | "predict" | "compare" | "sequence" | "check";

export interface Card {
  id: string;
  title: string;
  description: string;
  spokenAliases: string[];
  order?: number;
}

export type VisualDuration = 5;

export interface VisualSpec {
  concept: string;
  teachingIntent: string;
  visualDescription: string;
  durationSeconds: VisualDuration;
  continuityKey: string;
}

export type SessionState =
  | "connecting"
  | "listening"
  | "thinking"
  | "speaking"
  | "redirecting"
  | "text_only"
  | "reconnecting"
  | "ended";

export interface MasteryView {
  concept: string;
  mastery: number;
  evidenceCount: number;
}

export interface TranscriptTurn {
  turnId: string;
  role: "tutor" | "learner";
  text: string;
  interrupted: boolean;
  final: boolean;
}

export interface CardSet {
  purpose: CardPurpose;
  prompt: string;
  cards: Card[];
  revision: number;
}

export type VisualPhase = "idle" | "live" | "held" | "redirecting";

export interface VisualState {
  spec: VisualSpec;
  revision: number;
  visualOperationId?: string;
  phase: VisualPhase;
  stopReason?: "complete" | "interrupted" | "topic_changed" | "budget" | "failed";
}

export interface TopicGraphState {
  nodes: { id: string; label: string }[];
  edges: { from: string; to: string }[];
  activeId: string;
}

/**
 * Expected shape of `useTutorSession` (apps/web/src/hooks, owned by
 * OpenAIRealtime). Components in this feature depend only on this boundary.
 *
 * - state fields are the reducer-driven view of the SessionEvent stream.
 * - sendText(text) emits BrowserCommand { type: "learner.text" }.
 * - selectCard(cardId, revision) emits { type: "learner.card.select" }.
 * - interrupt() emits speech.start + response cancel (barge-in).
 * - toggleMic() requests/releases the microphone; denial -> status text_only.
 * - close(reason) emits { type: "session.close" }.
 */
export interface UseTutorSessionResult {
  status: SessionState;
  statusDetail?: string;
  activeTurn?: TranscriptTurn | null;
  turns: TranscriptTurn[];
  activeCards: CardSet | null;
  mastery: MasteryView[];
  graph: TopicGraphState;
  micEnabled: boolean;
  micAvailable: boolean;
  sendText: (text: string) => void;
  selectCard: (cardId: string, revision: number) => void;
  interrupt: () => void;
  toggleMic: () => void;
  close: (reason: "complete" | "abandoned" | "error") => void;
  retry?: () => void;
}

/**
 * Expected shape of `useVisualDirector`. The hook queues H3 Max clips,
 * preserves the decoded current clip while the next one generates, and
 * replaces prefetched clips when the lesson changes direction.
 */
export interface UseVisualDirectorResult {
  visual: VisualState | null;
  /**
   * Attach point for the canvas <video> element. Keeping the element mounted
   * preserves the current decoded clip throughout queued generation.
   */
  videoRef: RefCallback<HTMLVideoElement>;
  quotaSecondsRemaining: number;
  redirect: (spec: VisualSpec) => void;
  stop: (reason: NonNullable<VisualState["stopReason"]>) => void;
}

/** Combined view consumed by the lesson shell. */
export interface LessonSession extends UseTutorSessionResult {
  visual: UseVisualDirectorResult["visual"];
  videoRef?: UseVisualDirectorResult["videoRef"];
  quotaSecondsRemaining: number | null;
  quotaTotalSeconds?: number | null;
}
