import type { TopicGraphState } from "./types";
import styles from "./lesson.module.css";

/**
 * Exploration graph grown from completed turns. Nodes are laid out on a
 * deterministic spiral so the graph is stable between renders without any
 * physics simulation.
 */
export function TopicGraph({ graph }: { graph: TopicGraphState }) {
  const W = 232;
  const H = 180;
  const cx = W / 2;
  const cy = H / 2;

  const pos = graph.nodes.map((_, i) => {
    if (i === 0) return { x: cx, y: cy };
    const angle = i * 2.39996; // golden angle for even spread
    const r = 26 + 14 * Math.sqrt(i);
    return {
      x: Math.min(W - 14, Math.max(14, cx + r * Math.cos(angle))),
      y: Math.min(H - 14, Math.max(14, cy + r * Math.sin(angle))),
    };
  });

  const index = new Map(graph.nodes.map((n, i) => [n.id, i]));

  return (
    <section className={styles.railSection} aria-labelledby="graph-heading">
      <h2 id="graph-heading" className={styles.railHeading}>
        Your exploration
      </h2>
      <svg
        className={styles.graph}
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`Exploration graph with ${graph.nodes.length} concepts. Current: ${
          graph.nodes.find((n) => n.id === graph.activeId)?.label ?? "none"
        }.`}
      >
        {graph.edges.map((e, i) => {
          const a = pos[index.get(e.from) ?? 0];
          const b = pos[index.get(e.to) ?? 0];
          return (
            <line key={i} className={styles.graphEdge} x1={a.x} y1={a.y} x2={b.x} y2={b.y} />
          );
        })}
        {graph.nodes.map((n, i) => {
          const active = n.id === graph.activeId;
          return (
            <g key={n.id}>
              <circle
                cx={pos[i].x}
                cy={pos[i].y}
                r={active ? 7 : 5}
                className={active ? styles.graphNodeActive : styles.graphNode}
              />
              <text
                x={pos[i].x + 10}
                y={pos[i].y + 4}
                className={active ? `${styles.graphLabel} ${styles.graphLabelActive}` : styles.graphLabel}
              >
                {n.label.length > 18 ? `${n.label.slice(0, 17)}…` : n.label}
              </text>
            </g>
          );
        })}
      </svg>
    </section>
  );
}
