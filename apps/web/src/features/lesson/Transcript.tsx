"use client";

import type { TranscriptTurn } from "./types";
import styles from "./lesson.module.css";

export interface TranscriptProps {
  /** Immutable, finalized transcript history. */
  turns: TranscriptTurn[];
  /** The single in-progress tutor turn, kept separate from finalized history. */
  activeTurn?: TranscriptTurn | null;
  /** visible text per turn after streaming truncation */
  textFor: (turn: TranscriptTurn) => string;
}

export function Transcript({ turns, activeTurn = null, textFor }: TranscriptProps) {
  const finalizedLimit = activeTurn ? 4 : 5;
  const windowStart = Math.max(0, turns.length - finalizedLimit);
  const visibleTurns = turns.slice(windowStart);
  const latestTurn = turns.at(-1);
  const latestText = latestTurn ? textFor(latestTurn) : "";
  const activeText = activeTurn ? textFor(activeTurn) : "";
  const totalTurns = turns.length + (activeTurn ? 1 : 0);

  return (
    <>
      <div
        role="region"
        className={styles.transcript}
        aria-label="Live transcript"
      >
        <ol className={styles.transcriptList} start={windowStart + 1}>
          {visibleTurns.map((turn, index) => (
            <li
              key={turn.turnId}
              className={styles.turn}
              data-role={turn.role}
              aria-posinset={windowStart + index + 1}
              aria-setsize={totalTurns}
            >
              <span className={styles.turnRole} aria-hidden="true">
                {turn.role === "tutor" ? "AI" : "You"}
              </span>
              <p className={styles.turnText}>
                <span className="sr-only">{turn.role === "tutor" ? "Tutor: " : "You: "}</span>
                {textFor(turn)}
                {turn.interrupted && (
                  <span className={styles.turnInterrupted}>interrupted</span>
                )}
              </p>
            </li>
          ))}
          {activeTurn && (
            <li
              key={activeTurn.turnId}
              className={styles.turn}
              data-role={activeTurn.role}
              aria-posinset={turns.length + 1}
              aria-setsize={totalTurns}
            >
              <span className={styles.turnRole} aria-hidden="true">
                {activeTurn.role === "tutor" ? "AI" : "You"}
              </span>
              <p className={styles.turnText}>
                <span className="sr-only">
                  {activeTurn.role === "tutor" ? "Tutor: " : "You: "}
                </span>
                {activeText}
                <span className={styles.caret} aria-hidden="true" />
              </p>
            </li>
          )}
        </ol>
      </div>
      <span className="sr-only" role="status" aria-live="polite">
        {!activeTurn && latestTurn?.final
          ? `${latestTurn.role === "tutor" ? "Tutor" : "You"}: ${latestText}${
              latestTurn.interrupted ? " Interrupted." : ""
            }`
          : ""}
      </span>
    </>
  );
}
