import type { ReactNode } from "react";
import type { SessionState } from "./types";
import styles from "./lesson.module.css";

const STATE_LABELS: Record<SessionState, string> = {
  connecting: "Connecting…",
  listening: "Connected",
  thinking: "Thinking",
  speaking: "Speaking",
  redirecting: "Changing direction…",
  text_only: "Text only",
  reconnecting: "Reconnecting…",
  ended: "Session ended",
};

const LIVE_STATES: SessionState[] = ["listening", "speaking", "thinking", "redirecting"];
const URL_PATTERN = /https?:\/\/[^\s,]+/g;

function renderDetail(detail: string): { content: ReactNode; hasLink: boolean } {
  const content: ReactNode[] = [];
  let last = 0;
  for (const match of detail.matchAll(URL_PATTERN)) {
    const url = match[0];
    if (match.index > last) content.push(detail.slice(last, match.index));
    content.push(
      <a key={`${match.index}-${url}`} href={url} target="_blank" rel="noreferrer">
        {url.replace(/^https?:\/\//, "")}
      </a>,
    );
    last = match.index + url.length;
  }
  if (content.length === 0) return { content: detail, hasLink: false };
  if (last < detail.length) content.push(detail.slice(last));
  return { content, hasLink: true };
}

export interface StatusBarProps {
  status: SessionState;
  detail?: string;
  quotaSecondsRemaining: number | null;
  quotaTotal?: number | null;
  onRetry?: () => void;
}

export function StatusBar({
  status,
  detail,
  quotaSecondsRemaining,
  quotaTotal,
  onRetry,
}: StatusBarProps) {
  const remaining = quotaSecondsRemaining ?? 0;
  const total = quotaTotal ?? 0;
  const quotaKnown =
    quotaSecondsRemaining !== null &&
    quotaTotal !== null &&
    quotaTotal !== undefined &&
    Number.isFinite(quotaSecondsRemaining) &&
    Number.isFinite(quotaTotal) &&
    quotaTotal > 0;
  const pct = quotaKnown
    ? Math.max(0, Math.min(100, Math.round((remaining / total) * 100)))
    : 0;
  return (
    <div className={styles.statusBlock}>
      <div className={styles.statusRow} role="status" aria-live="polite">
        <span
          className={styles.statusDot}
          data-state={status}
          data-live={LIVE_STATES.includes(status)}
          aria-hidden="true"
        />
        <span className={styles.statusLabel}>{STATE_LABELS[status]}</span>
      </div>
      {detail && <DetailLine detail={detail} />}
      {onRetry && (
        <button type="button" className={styles.endButton} onClick={onRetry}>
          Retry connection
        </button>
      )}
      {quotaKnown && (
        <div
          className={styles.quotaMeter}
          role="progressbar"
          aria-valuenow={remaining}
          aria-valuemin={0}
          aria-valuemax={total}
          aria-label={`Visual generation budget: ${remaining} seconds remaining`}
        >
          <div className={styles.quotaFill} style={{ width: `${pct}%` }} />
        </div>
      )}
      <p className={styles.quotaLabel}>
        {!quotaKnown
          ? "Visual allowance is currently unavailable"
          : remaining > 0
            ? `${remaining}s of daily visual generation remaining`
            : status === "text_only"
              ? "Visual budget used — continuing with text and cards"
              : "Visual budget used — continuing with voice"}
      </p>
    </div>
  );
}

function DetailLine({ detail }: { detail: string }) {
  const { content, hasLink } = renderDetail(detail);
  return (
    <p className={styles.statusDetail} data-wrap={hasLink || undefined} title={detail}>
      {content}
    </p>
  );
}
