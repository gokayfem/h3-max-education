"use client";

import { useCallback, useEffect, useRef } from "react";
import { getBrowserLaunchMetrics } from "@/lib/telemetry/browser-metrics";
import type { CardSet } from "./types";
import styles from "./lesson.module.css";

const PURPOSE_LABELS: Record<CardSet["purpose"], string> = {
  branch: "Choose a branch",
  predict: "Make a prediction",
  compare: "Compare",
  sequence: "Put in order",
  check: "Quick check",
};

export interface CardDockProps {
  cardSet: CardSet;
  onSelect: (cardId: string, revision: number) => void;
  disabled?: boolean;
}

/**
 * One-to-three interactive cards at a natural checkpoint. Fully keyboard
 * operable: number keys 1–3 select directly, Tab moves through the cards,
 * Enter/Space activates. Selection is a normal learner turn.
 */
export function CardDock({ cardSet, onSelect, disabled }: CardDockProps) {
  const { purpose, prompt, cards, revision } = cardSet;
  const listRef = useRef<HTMLUListElement>(null);
  const focusInsideRef = useRef(false);
  const lastRevisionRef = useRef<number | null>(null);

  const select = useCallback(
    (cardId: string) => {
      if (!disabled) onSelect(cardId, revision);
    },
    [disabled, onSelect, revision],
  );

  // When a revised card set replaces the one a keyboard learner was focused
  // on, the old button unmounts and focus would drop to <body>; restore it.
  // Runs on mount and on every revision change: CardDock unmounts while no
  // card set is active, so a mount after cards reappear is itself a commit.
  useEffect(() => {
    if (lastRevisionRef.current === revision) return;
    lastRevisionRef.current = revision;
    // Cards for this revision have committed to the DOM.
    getBrowserLaunchMetrics().finishCardReplacement(revision);
    if (focusInsideRef.current) {
      listRef.current?.querySelector("button")?.focus();
    }
  }, [revision]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
      const n = Number(e.key);
      if (Number.isInteger(n) && n >= 1 && n <= cards.length) {
        e.preventDefault();
        select(cards[n - 1].id);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [cards, select]);

  return (
    <section
      className={styles.cardDock}
      aria-label="Choose what happens next"
      onFocusCapture={() => {
        focusInsideRef.current = true;
      }}
      onBlurCapture={(e) => {
        // relatedTarget is null when the focused card unmounts mid-revision;
        // keep the flag so focus is restored instead of lost to <body>.
        if (e.relatedTarget && !e.currentTarget.contains(e.relatedTarget as Node)) {
          focusInsideRef.current = false;
        }
      }}
    >
      <div className={styles.cardPromptRow}>
        <span className={styles.cardPurpose}>{PURPOSE_LABELS[purpose]}</span>
        <p className={styles.cardPrompt}>{prompt}</p>
      </div>
      <span className="sr-only" role="status" aria-live="polite">
        {`${PURPOSE_LABELS[purpose]}. ${prompt} ${cards.length} options available; press keys 1 through ${cards.length} to choose.`}
      </span>
      <ul className={styles.cardRow} ref={listRef}>
        {cards.map((card, i) => (
          <li key={card.id}>
            <button
              type="button"
              className={styles.card}
              onClick={() => select(card.id)}
              disabled={disabled}
              aria-label={`Option ${i + 1} of ${cards.length}: ${card.title}. ${card.description}`}
              aria-keyshortcuts={String(i + 1)}
            >
              <span className={styles.cardKey} aria-hidden="true">
                {i + 1}
              </span>
              <span className={styles.cardTitle}>{card.title}</span>
              <span className={styles.cardDesc}>{card.description}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
