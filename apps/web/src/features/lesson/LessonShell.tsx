"use client";
import Link from "next/link";

import type { RefCallback } from "react";
import type { LessonSession, TranscriptTurn } from "./types";
import { ScienceCanvas } from "./ScienceCanvas";
import { Transcript } from "./Transcript";
import { StatusBar } from "./StatusBar";
import { Composer } from "./Composer";
import styles from "./lesson.module.css";

export interface LessonViewProps {
  session: LessonSession;
  /** director-owned video attach point, when a realtime visual stream exists */
  videoReady?: boolean;
  videoRef?: RefCallback<HTMLVideoElement>;
  /** visible text per turn (defaults to full text; driver truncates while streaming) */
  textFor?: (turn: TranscriptTurn) => string;
}

/** Shared presentational workspace for the live generated lesson. */
export function LessonView({ session, videoRef, videoReady, textFor }: LessonViewProps) {
  const activeTurn =
    session.activeTurn ??
    session.turns.find((turn) => turn.role === "tutor" && !turn.final) ??
    null;
  const completedTurns = session.activeTurn
    ? session.turns
    : session.turns.filter((turn) => turn.turnId !== activeTurn?.turnId);
  const ended = session.status === "ended";

  return (
    <div className={styles.shell}>
      <header className={styles.topbar}>
        <h1 className={styles.brand}>
          <span className={styles.brandName}>H3 Max Realtime Education</span>
          <span className={styles.brandTag}>science companion</span>
        </h1>
        <div className={styles.topbarActions}>
          <StatusBar
            status={session.status}
            detail={session.statusDetail}
            quotaSecondsRemaining={session.quotaSecondsRemaining}
            quotaTotal={session.quotaTotalSeconds}
            onRetry={session.retry}
          />
          {!ended && (
            <button
              type="button"
              aria-label="End session"
              className={styles.endButton}
              onClick={() => session.close("abandoned")}
            >
              End session
            </button>
          )}
        </div>
      </header>

      <main className={styles.stage} id="main" aria-label="Lesson">
        <ScienceCanvas
          visual={session.visual}
          videoRef={videoRef}
          videoReady={videoReady}
        />
        <div className={styles.transcriptWrap}>
          <Transcript
            turns={completedTurns}
            activeTurn={activeTurn}
            textFor={textFor ?? ((t) => t.text)}
          />
        </div>
      </main>

      {ended ? (
        <footer className={styles.composerCol}>
          <div className={styles.endedBanner} role="status">
            <p className={styles.endedText}>
              Session ended. Your learning is saved for the next session.
            </p>
            <Link className={styles.endedLink} href="/learn">
              Start a new session
            </Link>
          </div>
        </footer>
      ) : (
        <Composer
          status={session.status}
          micEnabled={session.micEnabled}
          micAvailable={session.micAvailable}
          onToggleMic={session.toggleMic}
          onInterrupt={session.interrupt}
        />
      )}
    </div>
  );
}
