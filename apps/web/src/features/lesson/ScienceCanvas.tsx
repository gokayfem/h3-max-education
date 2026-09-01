import type { RefCallback } from "react";
import type { VisualState } from "./types";
import styles from "./lesson.module.css";

/** Generated video is the only moving lesson visual. */
export interface ScienceCanvasProps {
  visual: VisualState | null;
  videoReady?: boolean;
  /** Director-owned attach point bound to the generated stream. */
  videoRef?: RefCallback<HTMLVideoElement>;
}

function OpeningMessage({ overlay = false }: { overlay?: boolean }) {
  return (
    <div className={styles.canvasOpening} data-overlay={overlay || undefined}>
      <span className={styles.canvasOpeningRule} aria-hidden="true" />
      <p className={styles.canvasOpeningMessage}>Your learning journey starts here</p>
    </div>
  );
}

export function ScienceCanvas({
  visual,
  videoRef,
  videoReady = false,
}: ScienceCanvasProps) {
  if (!visual || !videoRef) {
    return (
      <figure className={styles.canvasFrame} aria-label="Learning journey canvas">
        <OpeningMessage />
      </figure>
    );
  }

  const held = visual.phase === "held";

  return (
    <figure
      className={styles.canvasFrame}
      aria-label={
        videoReady
          ? `Lesson visual: ${visual.spec.concept}. ${visual.spec.teachingIntent}`
          : "Learning journey canvas"
      }
    >
      <video
        className={styles.canvasScene}
        autoPlay
        crossOrigin="anonymous"
        data-ready={videoReady}
        loop
        muted
        playsInline
        ref={videoRef}
      />

      {!videoReady && <OpeningMessage overlay />}

      {videoReady && !held && (
        <span className={styles.canvasBadge} data-tone="live">
          Continuous live visual
        </span>
      )}
      {videoReady && held && (
        <span className={styles.canvasBadge}>Continuous visual · holding current scene</span>
      )}

      {videoReady && (
        <figcaption className={styles.canvasCaption}>
          <p className={styles.canvasConcept}>{visual.spec.concept}</p>
          <p className={styles.canvasIntent}>{visual.spec.teachingIntent}</p>
        </figcaption>
      )}
    </figure>
  );
}
