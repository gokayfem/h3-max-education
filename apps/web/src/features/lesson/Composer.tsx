"use client";

import type { SessionState } from "./types";
import styles from "./lesson.module.css";

export interface ComposerProps {
  status: SessionState;
  micEnabled: boolean;
  micAvailable: boolean;
  onToggleMic: () => void;
  onInterrupt: () => void;
}

/**
 * Voice-only lesson controls. Learner input is microphone audio; the tutor
 * responds with synchronized audio, transcript, cards, and generated video.
 */
export function Composer({
  status,
  micEnabled,
  micAvailable,
  onToggleMic,
  onInterrupt,
}: ComposerProps) {
  const ended = status === "ended";
  const connecting = status === "connecting" || status === "reconnecting";
  const speaking = status === "speaking" || status === "thinking" || status === "redirecting";
  const unavailable = status === "text_only" || !micAvailable;
  const voiceStatus = connecting
    ? "Connecting…"
    : unavailable
      ? "Voice connection unavailable"
      : speaking
        ? "Generating…"
        : micEnabled
          ? "Listening"
          : "Paused";

  return (
    <footer className={styles.composerCol}>
      <div className={styles.composer}>
        <button
          type="button"
          className={styles.micButton}
          aria-pressed={micEnabled}
          aria-label={micEnabled ? "Mute microphone" : "Enable microphone"}
          title={unavailable ? "Microphone connection unavailable" : undefined}
          disabled={ended || connecting || unavailable}
          onClick={onToggleMic}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <rect x="9" y="3" width="6" height="11" rx="3" />
            <path d="M5 11a7 7 0 0 0 14 0" />
            <line x1="12" y1="18" x2="12" y2="21" />
            {!micEnabled && <line x1="4" y1="4" x2="20" y2="20" />}
          </svg>
        </button>
        <div className={styles.waveform} aria-hidden="true" />
        <p className={styles.input} role="status" aria-live="polite">
          {voiceStatus}
        </p>
        {speaking && (
          <button type="button" className={styles.sendButton} onClick={onInterrupt}>
            Interrupt
          </button>
        )}
      </div>
      <span className="sr-only">
        {unavailable
          ? "Reconnect voice to continue the lesson."
          : "Speak naturally. You can interrupt H3 Max Realtime Education at any time."}
      </span>
    </footer>
  );
}
