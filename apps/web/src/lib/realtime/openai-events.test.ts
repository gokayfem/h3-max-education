import { describe, expect, it } from "vitest";
import { parseRealtimeServerEvent, parseTutorToolCall } from "./openai-events";

describe("parseRealtimeServerEvent", () => {
  it("accepts transcript and VAD events used by the browser", () => {
    expect(
      parseRealtimeServerEvent(
        JSON.stringify({
          type: "response.output_audio_transcript.delta",
          item_id: "turn-1",
          delta: "Gravity"
        })
      )
    ).toEqual({
      type: "response.output_audio_transcript.delta",
      item_id: "turn-1",
      delta: "Gravity"
    });

    expect(
      parseRealtimeServerEvent(
        JSON.stringify({ type: "input_audio_buffer.speech_started", audio_start_ms: 120, item_id: "input-1" })
      )?.type
    ).toBe("input_audio_buffer.speech_started");
  });

  it("validates decoded tool calls against the shared protocol", () => {
    const validEvent = parseRealtimeServerEvent(
      JSON.stringify({
        type: "response.function_call_arguments.done",
        item_id: "tool-1",
        call_id: "call-1",
        name: "present_cards",
        arguments: JSON.stringify({
          purpose: "predict",
          prompt: "What happens next?",
          cards: [{ title: "It speeds up", description: "Its speed increases." }]
        })
      })
    );
    const invalidEvent = parseRealtimeServerEvent(
      JSON.stringify({
        type: "response.function_call_arguments.done",
        item_id: "tool-2",
        call_id: "call-2",
        name: "present_cards",
        arguments: JSON.stringify({ purpose: "predict", prompt: "Choose", cards: [] })
      })
    );

    expect(validEvent && parseTutorToolCall(validEvent)?.name).toBe("present_cards");
    expect(invalidEvent && parseTutorToolCall(invalidEvent)).toBeNull();
  });

  it("rejects malformed JSON, unknown events, and invalid tool arguments", () => {
    expect(parseRealtimeServerEvent("not-json")).toBeNull();
    expect(parseRealtimeServerEvent(JSON.stringify({ type: "made.up", secret: "value" }))).toBeNull();
    expect(
      parseRealtimeServerEvent(
        JSON.stringify({
          type: "response.function_call_arguments.done",
          item_id: "tool-1",
          call_id: "call-1",
          name: "present_cards",
          arguments: { cards: "not-json" }
        })
      )
    ).toBeNull();
  });
});
