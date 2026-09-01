import type { MasteryView } from "./types";
import styles from "./lesson.module.css";

export function MasteryRail({ mastery }: { mastery: MasteryView[] }) {
  const activeConcept = mastery.reduce<MasteryView | null>(
    (best, m) => (best === null || m.mastery > best.mastery ? m : best),
    null,
  )?.concept;

  return (
    <section className={styles.railSection} aria-labelledby="mastery-heading">
      <h2 id="mastery-heading" className={styles.railHeading}>
        Mastery
      </h2>
      {mastery.length === 0 ? (
        <p className={styles.masteryEmpty}>
          Mastery builds from what you do — predictions, branches, and explain-backs — never from
          self-ratings.
        </p>
      ) : (
        <div className={styles.masteryPanel}>
          <p className={styles.masteryPanelLabel}>Observed mastery</p>
          <ul className={styles.masteryList}>
            {mastery.map((m) => {
              const pct = Math.round(m.mastery * 100);
              const active = m.concept === activeConcept;
              return (
                <li key={m.concept} className={styles.masteryItem} data-active={active}>
                  <span className={styles.masteryDot} aria-hidden="true" />
                  <span className={styles.masteryConcept}>{m.concept}</span>
                  <span
                    className={styles.masteryValue}
                    role="progressbar"
                    aria-valuenow={pct}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-label={`Mastery of ${m.concept}: ${pct} percent, ${m.evidenceCount} ${
                      m.evidenceCount === 1 ? "observation" : "observations"
                    }`}
                  >
                    {pct}%
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </section>
  );
}
