import { describe, expect, it } from "vitest";
import { FakeTutorTransport } from "./fakes";
import { RealtimeTutorSession } from "./tutor-session";

describe("RealtimeTutorSession", () => {
  it("executes the complete barge-in sequence in order", async () => {
    const transport = new FakeTutorTransport();
    const events: string[] = [];
    const session = new RealtimeTutorSession(transport, (event) => events.push(event.type));
    await session.open({ sessionId: "session-1", learnerId: "learner-1" });
    session.appendAssistantTranscript("turn-1", "A comet is mostly ice");

    await session.interrupt({ turnId: "turn-1", heardCharacters: 12 });

    expect(transport.calls).toEqual([
      "open:session-1",
      "muteOutput",
      "cancelResponse",
      "clearOutputAudio",
      "truncateAssistant:turn-1:12"
    ]);
    expect(events).toContain("transcript.final");
    expect(events.at(-1)).toBe("session.status");
    expect(session.state).toBe("listening");
  });

  it("injects card choices and typed turns as normal learner messages", async () => {
    const transport = new FakeTutorTransport();
    const session = new RealtimeTutorSession(transport, () => undefined);
    await session.open({ sessionId: "session-1", learnerId: "learner-1" });
    await session.sendText("Why does it curve?");
    await session.selectCard({ id: "spacetime", title: "Spacetime", revision: 4 });

    expect(transport.calls).toContain("sendText:Why does it curve?");
    expect(transport.calls).toContain("selectCard:spacetime:Spacetime:4");
  });
  it("preserves text-only mode chosen by the transport", async () => {
    const transport = new FakeTutorTransport();
    transport.mode = "text";
    const session = new RealtimeTutorSession(transport, () => undefined);

    await session.open({ sessionId: "session-1", learnerId: "learner-1" });
    expect(session.state).toBe("text_only");

    await session.resume();
    expect(session.state).toBe("text_only");
  });

  it("emits an ended status when opening fails", async () => {
    const transport = new FakeTutorTransport();
    transport.openError = new Error("network unavailable");
    const events: Parameters<ConstructorParameters<typeof RealtimeTutorSession>[1]>[0][] = [];
    const session = new RealtimeTutorSession(transport, (event) => events.push(event));

    await expect(session.open({ sessionId: "session-1", learnerId: "learner-1" }))
      .rejects.toThrow("network unavailable");
    expect(session.state).toBe("ended");
    expect(events.at(-1)).toEqual({ protocolVersion: 1, type: "session.status", state: "ended" });
  });

  it("restores the prior state when typed turns or cards fail", async () => {
    const transport = new FakeTutorTransport();
    transport.mode = "text";
    const session = new RealtimeTutorSession(transport, () => undefined);
    await session.open({ sessionId: "session-1", learnerId: "learner-1" });

    transport.sendError = new Error("turn failed");
    await expect(session.sendText("Why?")).rejects.toThrow("turn failed");
    expect(session.state).toBe("text_only");

    transport.cardError = new Error("card failed");
    await expect(session.selectCard({ id: "orbit", title: "Orbit", revision: 1 }))
      .rejects.toThrow("card failed");
    expect(session.state).toBe("text_only");
  });


  it("attempts one controlled reconnect and then enters text-only mode", async () => {
    const transport = new FakeTutorTransport();
    transport.reconnectResults = [false, false];
    const session = new RealtimeTutorSession(transport, () => undefined);
    await session.open({ sessionId: "session-1", learnerId: "learner-1" });

    await session.handleConnectionFailure();
    await session.handleConnectionFailure();

    expect(transport.calls.filter((call) => call === "reconnect")).toHaveLength(1);
    expect(session.state).toBe("text_only");
  });

  it("emits versioned interrupted transcript content at the heard boundary", async () => {
    const transport = new FakeTutorTransport();
    const events: Parameters<ConstructorParameters<typeof RealtimeTutorSession>[1]>[0][] = [];
    const session = new RealtimeTutorSession(transport, (event) => events.push(event));
    await session.open({ sessionId: "session-1", learnerId: "learner-1" });
    session.appendAssistantTranscript("turn-1", "abcdef");
    await session.interrupt({ turnId: "turn-1", heardCharacters: 3 });
    expect(events).toContainEqual({ protocolVersion: 1, type: "transcript.final", turnId: "turn-1", text: "abc", interrupted: true });
  });

  it("recovers once when reconnect succeeds and resumes output explicitly", async () => {
    const transport = new FakeTutorTransport();
    transport.reconnectResults = [true];
    const session = new RealtimeTutorSession(transport, () => undefined);
    await session.open({ sessionId: "session-1", learnerId: "learner-1" });
    await session.handleConnectionFailure();
    await session.resume();
    expect(session.state).toBe("listening");
    expect(transport.calls.slice(-2)).toEqual(["reconnect", "resumeOutput"]);
  });

  it("resumes muted tutor output when a later response starts", async () => {
    const transport = new FakeTutorTransport();
    const session = new RealtimeTutorSession(transport, () => undefined);
    await session.open({ sessionId: "session-1", learnerId: "learner-1" });
    await session.interrupt({ turnId: "turn-1", heardCharacters: 0 });

    await session.responseStarted("turn-2");
    await session.responseStarted("turn-2");

    expect(transport.calls.filter((call) => call === "resumeOutput")).toHaveLength(1);
    expect(session.state).toBe("listening");
  });

  it("closes idempotently after queued interruption work", async () => {
    const transport = new FakeTutorTransport();
    const session = new RealtimeTutorSession(transport, () => undefined);
    await session.open({ sessionId: "session-1", learnerId: "learner-1" });
    const interruption = session.interrupt({ turnId: "turn-1", heardCharacters: 0 });
    await session.close("complete");
    await interruption;
    await session.close("complete");
    expect(transport.calls.at(-1)).toBe("close:complete");
    expect(transport.calls.filter((call) => call === "close:complete")).toHaveLength(1);
  });
});
