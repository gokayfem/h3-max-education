import { describe, expect, it } from "vitest";
import { RevisionedLearningCanvas } from "./learning-canvas";

const orbitSpec = {
  concept: "orbit",
  teachingIntent: "show continuous freefall",
  visualDescription: "Earth and a satellite",
  durationSeconds: 5 as const,
  continuityKey: "orbit"
};

describe("RevisionedLearningCanvas", () => {
  it("rejects late cards and visuals from an older branch", () => {
    const canvas = new RevisionedLearningCanvas();
    expect(canvas.apply({ protocolVersion: 1, type: "visual.start", revision: 4, visualOperationId: "visual-4", spec: orbitSpec })).toBe(true);
    expect(canvas.apply({
      protocolVersion: 1,
      type: "canvas.cards.replace",
      revision: 3,
      purpose: "predict",
      prompt: "What happens next?",
      cards: [{ id: "fall", title: "It falls", description: "It moves toward Earth.", spokenAliases: [] }]
    })).toBe(false);
    expect(canvas.snapshot.cards).toEqual([]);
    expect(canvas.snapshot.revision).toBe(4);
  });

  it("clears obsolete cards and dims visuals on interruption", () => {
    const canvas = new RevisionedLearningCanvas();
    canvas.apply({
      protocolVersion: 1,
      type: "canvas.cards.replace",
      revision: 1,
      purpose: "branch",
      prompt: "Choose a path",
      cards: [{ id: "forces", title: "Forces", description: "Explore forces.", spokenAliases: [] }]
    });
    canvas.apply({ protocolVersion: 1, type: "visual.start", revision: 2, visualOperationId: "visual-2", spec: orbitSpec });

    canvas.interrupt(3);

    expect(canvas.snapshot.cards).toEqual([]);
    expect(canvas.snapshot.visual.status).toBe("redirecting");
    expect(canvas.snapshot.visual.isDimmed).toBe(true);
  });

  it("holds the last good frame after a visual stop", () => {
    const canvas = new RevisionedLearningCanvas();
    canvas.apply({ protocolVersion: 1, type: "visual.start", revision: 1, visualOperationId: "visual-1", spec: orbitSpec });
    canvas.markFrameAvailable(1, "blob:frame-1");
    canvas.apply({ protocolVersion: 1, type: "visual.stop", revision: 2, reason: "complete" });

    expect(canvas.snapshot.visual).toMatchObject({
      status: "held",
      visualOperationId: "visual-1",
      lastFrameUrl: "blob:frame-1"
    });
  });

  it("rejects duplicate revisions so retransmission cannot replace branch state", () => {
    const canvas = new RevisionedLearningCanvas();
    canvas.apply({ protocolVersion: 1, type: "visual.start", revision: 1, visualOperationId: "visual-1", spec: orbitSpec });
    expect(canvas.apply({
      protocolVersion: 1,
      type: "canvas.cards.replace",
      revision: 1,
      purpose: "branch",
      prompt: "Late branch",
      cards: []
    })).toBe(false);
    expect(canvas.snapshot.visual.spec?.concept).toBe("orbit");
  });

  it("retains the last frame while a redirected visual is pending", () => {
    const canvas = new RevisionedLearningCanvas();
    canvas.apply({ protocolVersion: 1, type: "visual.start", revision: 1, visualOperationId: "visual-1", spec: orbitSpec });
    canvas.markFrameAvailable(1, "blob:good");
    canvas.apply({ protocolVersion: 1, type: "visual.redirect", revision: 2, visualOperationId: "visual-2", spec: { ...orbitSpec, teachingIntent: "change scale" } });
    expect(canvas.snapshot.visual).toMatchObject({ status: "redirecting", visualOperationId: "visual-2", isDimmed: true, lastFrameUrl: "blob:good" });
  });

  it("rejects late frames after a redirect or stop", () => {
    const canvas = new RevisionedLearningCanvas();
    canvas.apply({ protocolVersion: 1, type: "visual.start", revision: 1, visualOperationId: "visual-1", spec: orbitSpec });
    canvas.apply({ protocolVersion: 1, type: "visual.redirect", revision: 2, visualOperationId: "visual-2", spec: { ...orbitSpec, teachingIntent: "change scale" } });

    expect(canvas.markFrameAvailable(1, "blob:stale")).toBe(false);
    expect(canvas.snapshot.visual.status).toBe("redirecting");
    canvas.apply({ protocolVersion: 1, type: "visual.stop", revision: 3, reason: "failed" });
    expect(canvas.markFrameAvailable(2, "blob:late")).toBe(false);
    expect(canvas.snapshot.visual).toMatchObject({ status: "idle", lastFrameUrl: null });
  });

  it("keeps the held frame when recoverable visual generation fails", () => {
    const canvas = new RevisionedLearningCanvas();
    canvas.apply({ protocolVersion: 1, type: "visual.start", revision: 1, visualOperationId: "visual-1", spec: orbitSpec });
    expect(canvas.markFrameAvailable(1, "blob:last-good")).toBe(true);

    canvas.apply({ protocolVersion: 1, type: "visual.stop", revision: 2, reason: "failed" });

    expect(canvas.snapshot.visual).toMatchObject({ status: "held", lastFrameUrl: "blob:last-good" });
  });
});
