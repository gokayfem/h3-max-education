import { describe, expect, it } from "vitest";
import {
  browserCommandSchema,
  sessionEventSchema,
  tutorToolCallSchema
} from "./index";

const visualSpec = {
  concept: "orbital motion",
  teachingIntent: "show continuous freefall",
  visualDescription: "Earth and satellite from a stable frame",
  durationSeconds: 5 as const,
  continuityKey: "orbit-1"
};

const commandEnvelope = {
  protocolVersion: 1 as const,
  commandId: "093c071a-21d0-4f40-81fd-c799bc986996",
  revision: 1
};

describe("gateway protocol", () => {
  it("accepts every gateway-to-browser event", () => {
    const events = [
      { protocolVersion: 1, type: "transcript.delta", turnId: "turn-1", text: "Gravity" },
      { protocolVersion: 1, type: "transcript.final", turnId: "turn-1", text: "Gravity bends spacetime.", interrupted: false },
      {
        protocolVersion: 1,
        type: "canvas.cards.replace",
        revision: 2,
        prompt: "What changes?",
        purpose: "predict",
        cards: [{ id: "faster", title: "It moves faster", description: "Its speed increases.", spokenAliases: ["faster"] }]
      },
      { protocolVersion: 1, type: "canvas.cards.replace", revision: 3, prompt: "Choose a branch", purpose: "branch", cards: [] },
      { protocolVersion: 1, type: "visual.start", revision: 4, visualOperationId: "visual-op-1", spec: visualSpec },
      { protocolVersion: 1, type: "visual.redirect", revision: 5, visualOperationId: "visual-op-2", spec: visualSpec },
      { protocolVersion: 1, type: "visual.stop", revision: 6, reason: "complete" },
      { protocolVersion: 1, type: "learning.progress", concepts: [{ concept: "gravity", mastery: 0.62, evidenceCount: 3 }] },
      { protocolVersion: 1, type: "session.status", state: "listening", detail: "Your turn" },
      { protocolVersion: 1, type: "session.error", recoverable: true, code: "video_unavailable" }
    ];

    for (const event of events) {
      expect(sessionEventSchema.parse(event)).toEqual(event);
    }
  });

  it("accepts every browser-to-gateway command", () => {
    const commands = [
      { ...commandEnvelope, type: "learner.text", text: "Why does it orbit?" },
      { ...commandEnvelope, type: "learner.card.select", cardId: "faster" },
      {
        ...commandEnvelope,
        type: "learner.speech.start",
        at: 12.5,
        turnId: "assistant-turn",
        heardCharacters: 42
      },
      { ...commandEnvelope, type: "learner.speech.end", at: 14.2 },
      {
        protocolVersion: 1,
        type: "visual.authorized",
        sessionId: "session_12345678",
        visualOperationId: "visual-op-1",
        visualRevision: 4,
        reservationId: "reservation-1"
      },
      {
        protocolVersion: 1,
        type: "visual.ready",
        sessionId: "session_12345678",
        visualOperationId: "visual-op-1",
        visualRevision: 4,
        reservationId: "reservation-1"
      },
      {
        protocolVersion: 1,
        type: "visual.failed",
        sessionId: "session_12345678",
        visualOperationId: "visual-op-2",
        visualRevision: 5,
        reason: "reduced_motion"
      }
    ];
    for (const command of commands) {
      expect(browserCommandSchema.parse(command)).toEqual(command);
    }
  });

  it.each([
    ["a stale event revision", { protocolVersion: 1, type: "visual.stop", revision: 0, reason: "complete" }],
    ["an unknown protocol version", { ...commandEnvelope, protocolVersion: 2, type: "learner.text", text: "Hello" }],
    ["a missing command id", { protocolVersion: 1, revision: 1, type: "learner.text", text: "Hello" }],
    ["an invalid command id", { ...commandEnvelope, commandId: "duplicate-1", type: "learner.text", text: "Hello" }],
    ["an oversized transcript event", {
      protocolVersion: 1,
      type: "transcript.delta",
      turnId: "turn-oversized",
      text: "x".repeat(16_385)
    }],
    ["an unknown event property", { protocolVersion: 1, type: "session.status", state: "listening", extra: true }]
  ])("rejects %s", (_label, payload) => {
    const schema = "commandId" in payload || payload.type === "learner.text"
      ? browserCommandSchema
      : sessionEventSchema;
    expect(schema.safeParse(payload).success).toBe(false);
  });
});

describe("tutor tool contracts", () => {
  it("accepts every tutor tool", () => {
    const calls = [
      { name: "show_visual", arguments: visualSpec },
      {
        name: "present_cards",
        arguments: {
          purpose: "predict",
          prompt: "What happens next?",
          cards: [{ title: "The cell divides", description: "Two daughter cells form." }]
        }
      },
      {
        name: "record_learning_evidence",
        arguments: {
          concept: "mitosis",
          evidence: "Learner correctly ordered anaphase after metaphase.",
          confidenceDelta: 0.2,
          misconception: null,
          preferenceSignals: { explanationMode: "visual", pace: "steady" }
        }
      },
      { name: "stop_visual", arguments: { reason: "interrupted" } }
    ];

    for (const call of calls) {
      expect(tutorToolCallSchema.safeParse(call).success).toBe(true);
    }
  });

  it.each([
    ["legacy ten-second visual duration", { name: "show_visual", arguments: { ...visualSpec, durationSeconds: 10 } }],
    ["legacy fifteen-second visual duration", { name: "show_visual", arguments: { ...visualSpec, durationSeconds: 15 } }],
    ["unsupported visual duration", { name: "show_visual", arguments: { ...visualSpec, durationSeconds: 7 } }],
    ["unknown tool", { name: "search_web", arguments: {} }],
    ["unknown argument", { name: "stop_visual", arguments: { reason: "complete", force: true } }],
    ["model-supplied card id", {
      name: "present_cards",
      arguments: {
        purpose: "compare",
        prompt: "Compare",
        cards: [{ id: "model-id", title: "First", description: "First option" }]
      }
    }],
    ["blank visual concept", { name: "show_visual", arguments: { ...visualSpec, concept: "   " } }],
    ["blank card prompt", {
      name: "present_cards",
      arguments: {
        purpose: "check",
        prompt: " \n ",
        cards: [{ title: "Choice", description: "A useful choice" }]
      }
    }],
    ["blank card text", {
      name: "present_cards",
      arguments: {
        purpose: "check",
        prompt: "Choose",
        cards: [{ title: " ", description: "A useful choice", spokenAliases: ["\t"] }]
      }
    }],
    ["blank learning evidence", {
      name: "record_learning_evidence",
      arguments: { concept: "gravity", evidence: " ", confidenceDelta: 0 }
    }],
    ["out-of-range confidence", {
      name: "record_learning_evidence",
      arguments: { concept: "gravity", evidence: "answer", confidenceDelta: 1.1 }
    }]
  ])("rejects %s", (_label, call) => {
    expect(tutorToolCallSchema.safeParse(call).success).toBe(false);
  });
});
