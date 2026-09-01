import type { Card, SessionEvent, VisualSpec } from "@axiom/protocol";

type CanvasEvent = Extract<SessionEvent, { revision: number }>;
export type CanvasVisualStatus = "idle" | "starting" | "playing" | "redirecting" | "held";

export interface CanvasSnapshot {
  readonly revision: number;
  readonly cards: readonly Card[];
  readonly cardPrompt: string | null;
  readonly visual: {
    readonly status: CanvasVisualStatus;
    readonly spec: VisualSpec | null;
    readonly visualOperationId: string | null;
    readonly isDimmed: boolean;
    readonly lastFrameUrl: string | null;
  };
}

export interface LearningCanvas {
  readonly snapshot: CanvasSnapshot;
  apply(event: CanvasEvent): boolean;
  interrupt(revision: number): boolean;
  markFrameAvailable(revision: number, url: string): boolean;
  clear(): void;
}

const INITIAL: CanvasSnapshot = Object.freeze({
  revision: 0,
  cards: Object.freeze([]),
  cardPrompt: null,
  visual: Object.freeze({ status: "idle", spec: null, visualOperationId: null, isDimmed: false, lastFrameUrl: null })
});

export class RevisionedLearningCanvas implements LearningCanvas {
  private current: CanvasSnapshot = INITIAL;

  get snapshot(): CanvasSnapshot { return this.current; }

  apply(event: CanvasEvent): boolean {
    if (!Number.isInteger(event.revision) || event.revision <= this.current.revision) return false;
    switch (event.type) {
      case "canvas.cards.replace":
        this.current = freezeSnapshot({
          ...this.current,
          revision: event.revision,
          cards: event.cards,
          cardPrompt: event.prompt
        });
        return true;
      case "visual.start":
        this.replaceVisual(event.revision, event.visualOperationId, event.spec, "starting");
        return true;
      case "visual.redirect":
        this.replaceVisual(event.revision, event.visualOperationId, event.spec, "redirecting");
        return true;
      case "visual.stop":
        this.current = freezeSnapshot({
          ...this.current,
          revision: event.revision,
          visual: {
            ...this.current.visual,
            status: this.current.visual.lastFrameUrl ? "held" : "idle",
            isDimmed: false
          }
        });
        return true;
    }
  }

  interrupt(revision: number): boolean {
    if (!Number.isInteger(revision) || revision <= this.current.revision) return false;
    this.current = freezeSnapshot({
      ...this.current,
      revision,
      cards: [],
      cardPrompt: null,
      visual: { ...this.current.visual, status: "redirecting", isDimmed: true }
    });
    return true;
  }

  markFrameAvailable(revision: number, url: string): boolean {
    if (!url.trim()) throw new Error("Frame URL must not be empty");
    if (!Number.isInteger(revision) || revision !== this.current.revision) return false;
    if (this.current.visual.status === "idle" || this.current.visual.status === "held") return false;
    this.current = freezeSnapshot({
      ...this.current,
      visual: { ...this.current.visual, status: "playing", isDimmed: false, lastFrameUrl: url }
    });
    return true;
  }

  clear(): void { this.current = INITIAL; }

  private replaceVisual(revision: number, visualOperationId: string, spec: VisualSpec, status: CanvasVisualStatus): void {
    this.current = freezeSnapshot({
      revision,
      cards: [],
      cardPrompt: null,
      visual: { ...this.current.visual, status, spec, visualOperationId, isDimmed: status === "redirecting" }
    });
  }
}

function freezeSnapshot(snapshot: CanvasSnapshot): CanvasSnapshot {
  const cards = Object.freeze([...snapshot.cards]);
  return Object.freeze({ ...snapshot, cards, visual: Object.freeze({ ...snapshot.visual }) });
}
