import type { SessionEvent, TutorToolCall } from "@axiom/protocol";
import type WebSocket from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthenticatedLearner } from "./auth.js";
import type { GatewayConfig } from "./config.js";
import type {
  GatewaySessionLease,
  GatewaySessionState,
  SessionEventBus,
  SocketPermit
} from "./event-bus.js";
import type { SafeLogger } from "./logger.js";
import { GatewayMetrics } from "./metrics.js";
import type { RealtimeSideband, SidebandCallbacks, TextTutor } from "./providers.js";
import { GatewaySessionManager, type SessionAttachment } from "./session.js";

const CONFIG: GatewayConfig = {
  environment: "test",
  port: 8_787,
  authSecret: "gateway-test-secret-that-is-at-least-32-chars",
  maxActiveSessionsPerLearner: 2,
  maxPaidCommandsPerLearner: 24,
  openAiApiKey: "provider-test-key",
  openAiRealtimeModel: "gpt-realtime",
  openAiTextModel: "gpt-4.1-mini",
  region: "test"
};
const LEARNER: AuthenticatedLearner = {
  learnerId: "lrn_abcdefghijklmnop"
};

class FakeBus {
  readonly events: SessionEvent[] = [];
  readonly claimed = new Set<string>();
  readonly states = new Map<string, GatewaySessionState>();
  readonly owners = new Map<string, GatewaySessionLease>();
  readonly operations = new Map<string, readonly SessionEvent[] | "pending">();
  readonly operationAttempts = new Map<string, string>();
  readonly transcripts: Array<Readonly<Record<string, unknown>>> = [];
  readonly paidOperations: string[] = [];
  paidAllowed = true;
  durableEvents = 0;
  readonly socketPermits = new Map<string, SocketPermit>();
  readonly releasedSocketPermits: string[] = [];
  maxSocketPermits = Number.POSITIVE_INFINITY;
  ownerAllowed = true;
  refreshAllowed = true;
  hydrateFailure = false;
  private permitSequence = 0;
  private subscriber?: (event: SessionEvent) => void;

  async reserveSocketPermit(
    sessionId: string,
    learnerId: string,
    connectionIdentity: string
  ): Promise<SocketPermit | undefined> {
    if (this.socketPermits.size >= this.maxSocketPermits) return undefined;
    const permit = {
      id: `permit-${this.permitSequence += 1}`,
      sessionId,
      learnerId,
      networkHash: connectionIdentity
    };
    this.socketPermits.set(permit.id, permit);
    return permit;
  }
  async releaseSocketPermit(permit: SocketPermit): Promise<void> {
    if (!this.socketPermits.delete(permit.id)) return;
    this.releasedSocketPermits.push(permit.id);
  }
  async refreshSocketPermit(permit: SocketPermit): Promise<boolean> {
    return this.refreshAllowed && this.socketPermits.has(permit.id);
  }

  async bindSessionOwner(sessionId: string, learnerId: string, callId?: string): Promise<GatewaySessionLease | undefined> {
    if (!this.ownerAllowed) return undefined;
    const owner = this.owners.get(sessionId);
    if (owner && owner.learnerId !== learnerId) return undefined;
    const lease = {
      sessionId,
      learnerId,
      gatewayInstanceToken: owner?.gatewayInstanceToken ?? "fake-gateway",
      ...(callId ? { callId } : {})
    };
    this.owners.set(sessionId, lease);
    return lease;
  }
  async refreshSessionOwner(lease: GatewaySessionLease): Promise<boolean> {
    return this.refreshAllowed
      && this.owners.get(lease.sessionId)?.gatewayInstanceToken === lease.gatewayInstanceToken;
  }
  async releaseSessionOwner(lease: GatewaySessionLease): Promise<boolean> {
    if (this.owners.get(lease.sessionId)?.gatewayInstanceToken !== lease.gatewayInstanceToken) return false;
    this.owners.delete(lease.sessionId);
    return true;
  }
  subscribe(_sessionId: string, _learnerId: string, subscriber: (event: SessionEvent) => void): () => void {
    this.subscriber = subscriber;
    return () => { this.subscriber = undefined; };
  }
  async publish(_sessionId: string, _learnerId: string, event: SessionEvent): Promise<void> {
    this.events.push(event);
    this.subscriber?.(event);
  }
  async beginCommandOperation(
    _sessionId: string,
    commandId: string,
    revision: number,
    current: number
  ): Promise<
    | { state: "accepted"; attemptToken: string }
    | { state: "pending" | "stale" }
    | { state: "completed"; events: readonly SessionEvent[] }
  > {
    const existing = this.operations.get(commandId);
    if (existing && existing !== "pending") return { state: "completed", events: existing };
    if (existing === "pending") return { state: "pending" };
    if (revision !== current + 1) return { state: "stale" };
    const attemptToken = `attempt:${commandId}`;
    this.operations.set(commandId, "pending");
    this.operationAttempts.set(commandId, attemptToken);
    return { state: "accepted", attemptToken };
  }
  async completeCommandOperation(
    _sessionId: string,
    commandId: string,
    attemptToken: string,
    events: readonly SessionEvent[]
  ): Promise<boolean> {
    if (this.operationAttempts.get(commandId) !== attemptToken) return false;
    this.operations.set(commandId, [...events]);
    return true;
  }
  async reservePaidCommand(_learnerId: string, operationId: string): Promise<boolean> {
    this.paidOperations.push(operationId);
    return this.paidAllowed;
  }
  async nextEventRevision(sessionId: string, current: number): Promise<number> {
    return Math.max(current, this.states.get(sessionId)?.eventRevision ?? 0) + 1;
  }
  async readCommandRevision(_sessionId: string, fallback = 0): Promise<number> { return fallback; }
  async hydrateSessionState(sessionId: string): Promise<GatewaySessionState | undefined> {
    if (this.hydrateFailure) throw new Error("state unavailable");
    return this.states.get(sessionId);
  }
  async persistSessionState(sessionId: string, state: GatewaySessionState): Promise<void> { this.states.set(sessionId, state); }
  async clearSessionState(sessionId: string): Promise<void> { this.states.delete(sessionId); }
  async appendTranscript(
    _sessionId: string,
    _effectId: string,
    entry: Readonly<Record<string, unknown>>
  ): Promise<void> {
    this.transcripts.push(entry);
  }
  async hydrateTranscript(): Promise<Array<Readonly<Record<string, unknown>>>> { return []; }
  async loadLearnerContext(): Promise<{
    mastery: readonly [];
    misconceptions: readonly [];
    interests: readonly [];
    recentSummaries: readonly [];
    instructionLines: readonly [];
  }> {
    return { mastery: [], misconceptions: [], interests: [], recentSummaries: [], instructionLines: [] };
  }
  async writeDurableEvent(): Promise<boolean> {
    this.durableEvents += 1;
    return true;
  }
  async writeCardInteraction(): Promise<boolean> { return true; }
  async writeVisualMetadata(): Promise<boolean> { return true; }
}

class FakeSocket {
  readonly OPEN = 1;
  readyState = 1;
  readonly sent: string[] = [];
  send(value: string): void { this.sent.push(value); }
  close(): void { this.readyState = 3; }
}

class FakeSideband implements RealtimeSideband {
  connectCount = 0;
  learnerTexts: string[] = [];
  cancelled = 0;
  closed = 0;
  readonly truncations: Array<{ turnId: string; characters: number }> = [];

  failConnect = false;
  async connect(): Promise<void> {
    this.connectCount += 1;
    if (this.failConnect) throw new Error("provider unavailable");
  }
  sendLearnerText(text: string): boolean { this.learnerTexts.push(text); return true; }
  cancelResponse(): void { this.cancelled += 1; }
  clearOutputAudio(): void {}
  truncateAssistant(turnId: string, characters: number): void { this.truncations.push({ turnId, characters }); }
  selectCard(): boolean { return true; }
  async close(): Promise<void> { this.closed += 1; }
}

const TEXT_TUTOR: TextTutor = {
  respond: async () => "A deterministic science answer.",
  summarize: async () => "A compact deterministic summary."
};
const LOGGER = { write: vi.fn() } as unknown as SafeLogger;

function command(id: string, revision: number, text = "Why is the sky blue?"): Buffer {
  return Buffer.from(JSON.stringify({ protocolVersion: 1, commandId: id, revision, type: "learner.text", text }));
}

function createHarness(
  options: {
    now?: () => number;
    idleTtlMs?: number;
    cleanupIntervalMs?: number;
    socketPermitRefreshIntervalMs?: number;
  } = {},
  bus = new FakeBus()
) {
  const sideband = new FakeSideband();
  let callbacks: SidebandCallbacks | undefined;
  const manager = new GatewaySessionManager(
    CONFIG,
    bus as unknown as SessionEventBus,
    new GatewayMetrics(),
    LOGGER,
    {
      now: options.now,
      idleTtlMs: options.idleTtlMs,
      socketPermitRefreshIntervalMs: options.socketPermitRefreshIntervalMs,
      cleanupIntervalMs: options.cleanupIntervalMs,
      textTutorFactory: () => TEXT_TUTOR,
      sidebandFactory: (_callId, suppliedCallbacks) => {
        callbacks = suppliedCallbacks;
        return sideband;
      }
    }
  );
  return { bus, sideband, manager, callbacks: () => callbacks };
}

const socketAsWebSocket = (socket: FakeSocket) => socket as unknown as WebSocket;
async function runVisualTool(
  harness: { callbacks: () => SidebandCallbacks | undefined; bus: FakeBus; manager: GatewaySessionManager },
  attachment: SessionAttachment,
  callId: string,
  call: Extract<TutorToolCall, { name: "show_visual" }>
): Promise<unknown> {
  const initialEventCount = harness.bus.events.length;
  const pending = harness.callbacks()!.onToolCall(callId, call);
  await vi.waitFor(() => {
    expect(harness.bus.events.slice(initialEventCount).some((event) =>
      event.type === "visual.start" || event.type === "visual.redirect"
    )).toBe(true);
  });
  const event = harness.bus.events.slice(initialEventCount).find(
    (candidate): candidate is Extract<SessionEvent, { type: "visual.start" | "visual.redirect" }> =>
      candidate.type === "visual.start" || candidate.type === "visual.redirect"
  )!;
  await harness.manager.handleRawMessage(attachment.session, Buffer.from(JSON.stringify({
    protocolVersion: 1,
    type: "visual.authorized",
    sessionId: attachment.session.id,
    visualOperationId: event.visualOperationId,
    visualRevision: event.revision,
    reservationId: `reservation-${callId}`
  })), false);
  return await pending;
}

afterEach(() => vi.useRealTimers());

  it("serializes concurrent attachment into one session and one sideband", async () => {
    const harness = createHarness();
    const [first, second] = await Promise.all([
      harness.manager.attach(
        "session_concurrent",
        LEARNER,
        socketAsWebSocket(new FakeSocket()),
        "call_concurrent"
      ),
      harness.manager.attach(
        "session_concurrent",
        LEARNER,
        socketAsWebSocket(new FakeSocket()),
        "call_concurrent"
      )
    ]);

    expect(first.session).toBe(second.session);
    expect(harness.sideband.connectCount).toBe(1);
    await first.detach();
    await second.detach();
    await harness.manager.close();
  });

describe("GatewaySessionManager", () => {
  it("releases a live-socket permit exactly once on detach so a replacement can attach", async () => {
    const bus = new FakeBus();
    bus.maxSocketPermits = 1;
    const harness = createHarness({}, bus);
    const first = await harness.manager.attach(
      "session_12345678",
      LEARNER,
      socketAsWebSocket(new FakeSocket()),
      undefined,
      "network-a"
    );

    await first.detach();
    await first.detach();
    await expect(harness.manager.attach(
      "session_12345678",
      LEARNER,
      socketAsWebSocket(new FakeSocket()),
      undefined,
      "network-a"
    )).resolves.toBeDefined();
    expect(bus.releasedSocketPermits).toEqual(["permit-1"]);
    await harness.manager.close();
  });

  it("does not leak permits when ownership or provider attach fails", async () => {
    const bus = new FakeBus();
    bus.maxSocketPermits = 1;
    bus.ownerAllowed = false;
    const ownershipHarness = createHarness({}, bus);
    await expect(ownershipHarness.manager.attach(
      "session_12345678",
      LEARNER,
      socketAsWebSocket(new FakeSocket()),
      undefined,
      "network-a"
    )).rejects.toThrow("ownership");

    bus.ownerAllowed = true;
    bus.hydrateFailure = true;
    const stateHarness = createHarness({}, bus);
    await expect(stateHarness.manager.attach(
      "session_87654321",
      LEARNER,
      socketAsWebSocket(new FakeSocket()),
      "call_12345678",
      "network-a"
    )).rejects.toThrow("state unavailable");

    expect(bus.socketPermits.size).toBe(0);
    expect(bus.releasedSocketPermits).toEqual(["permit-1", "permit-2"]);
    await ownershipHarness.manager.close();
    await stateHarness.manager.close();
  });

  it("closes the socket and releases its permit when lease renewal is lost", async () => {
    vi.useFakeTimers();
    const bus = new FakeBus();
    const socket = new FakeSocket();
    const harness = createHarness({
      cleanupIntervalMs: 60_000,
      socketPermitRefreshIntervalMs: 10
    }, bus);
    await harness.manager.attach(
      "session_12345678",
      LEARNER,
      socketAsWebSocket(socket),
      undefined,
      "network-a"
    );
    bus.refreshAllowed = false;

    await vi.advanceTimersByTimeAsync(10);

    expect(socket.readyState).toBe(3);
    expect(bus.socketPermits.size).toBe(0);
    expect(bus.releasedSocketPermits).toEqual(["permit-1"]);
    await harness.manager.close();
  });

  it("enforces command idempotency and monotonic revisions", async () => {
    const harness = createHarness();
    const socket = new FakeSocket();
    const attachment = await harness.manager.attach("session_12345678", LEARNER, socketAsWebSocket(socket), "call_12345678");
    const firstId = "11111111-1111-4111-8111-111111111111";
    await harness.manager.handleRawMessage(attachment.session, command(firstId, 1), false);
    await harness.manager.handleRawMessage(attachment.session, command(firstId, 1), false);
    await harness.manager.handleRawMessage(attachment.session, command("22222222-2222-4222-8222-222222222222", 1), false);

    expect(harness.sideband.learnerTexts).toEqual(["Why is the sky blue?"]);
    expect(harness.bus.events.some((event) => event.type === "session.error" && event.code === "stale_command")).toBe(true);
    await harness.manager.close();
  });

  it("executes validated tutor tools into monotonic canvas events after browser authorization", async () => {
    const harness = createHarness();
    const attachment = await harness.manager.attach("session_12345678", LEARNER, socketAsWebSocket(new FakeSocket()), "call_12345678");
    const call: Extract<TutorToolCall, { name: "show_visual" }> = {
      name: "show_visual",
      arguments: {
        concept: "Rayleigh scattering",
        teachingIntent: "Connect wavelength to scattering strength",
        visualDescription: "Colored light rays crossing a particle field",
        durationSeconds: 5,
        continuityKey: "sky-light"
      }
    };
    const result = await runVisualTool(harness, attachment, "tool-call", call);

    expect(result).toEqual(expect.objectContaining({
      accepted: true,
      status: "authorized_pending",
      revision: 1,
      resolution: "480p"
    }));
    expect(harness.bus.events).toContainEqual(expect.objectContaining({
      protocolVersion: 1,
      type: "visual.start",
      revision: 1,
      visualOperationId: expect.any(String)
    }));
    await attachment.detach();
    await harness.manager.close();
  });

  it("starts a fresh visual burst after a completed held or idle canvas", async () => {
    const harness = createHarness();
    const attachment = await harness.manager.attach(
      "session_12345678",
      LEARNER,
      socketAsWebSocket(new FakeSocket()),
      "call_12345678"
    );
    const visual: Extract<TutorToolCall, { name: "show_visual" }> = {
      name: "show_visual",
      arguments: {
        concept: "Waves",
        teachingIntent: "Compare amplitudes",
        visualDescription: "Two waves",
        durationSeconds: 5,
        continuityKey: "waves"
      }
    };
    await runVisualTool(harness, attachment, "visual-1", visual);
    await harness.callbacks()!.onToolCall("stop", { name: "stop_visual", arguments: { reason: "complete" } });
    await runVisualTool(harness, attachment, "visual-2", visual);

    expect(harness.bus.events.filter((event) => event.type === "visual.start")).toHaveLength(2);
    expect(harness.bus.events.some((event) => event.type === "visual.redirect")).toBe(false);
    await harness.manager.close();
  });

  it("resets assistant delta accumulation when the provider starts a new turn", async () => {
    const harness = createHarness();
    const attachment = await harness.manager.attach("session_12345678", LEARNER, socketAsWebSocket(new FakeSocket()), "call_12345678");
    harness.callbacks()!.onTranscriptFinal("turn-one", "Completed first answer");
    harness.callbacks()!.onTranscriptDelta("turn-two", "New partial");
    await harness.manager.handleRawMessage(attachment.session, Buffer.from(JSON.stringify({
      protocolVersion: 1,
      commandId: "77777777-7777-4777-8777-777777777777",
      revision: 1,
      type: "learner.speech.start",
      at: 10,
      turnId: "turn-two",
      heardCharacters: "New partial".length
    })), false);

    expect(harness.sideband.truncations).toEqual([{ turnId: "turn-two", characters: "New partial".length }]);
    expect(harness.bus.events).toContainEqual(expect.objectContaining({
      type: "transcript.final",
      turnId: "turn-two",
      text: "New partial",
      interrupted: true
    }));
    await harness.manager.close();
  });

  it("attempts one sideband reconnect and then degrades to text-only", async () => {
    const harness = createHarness();
    await harness.manager.attach("session_12345678", LEARNER, socketAsWebSocket(new FakeSocket()), "call_12345678");
    harness.callbacks()!.onDisconnect();
    await vi.waitFor(() => expect(harness.sideband.connectCount).toBe(2));
    harness.callbacks()!.onDisconnect();
    await vi.waitFor(() => expect(harness.bus.events).toContainEqual(expect.objectContaining({ type: "session.status", state: "text_only" })));

    expect(harness.sideband.connectCount).toBe(2);
    await harness.manager.close();
  });

  it("serves deterministic text after degradation and cleans detached idle sessions", async () => {
    vi.useFakeTimers();
    let now = 0;
    const harness = createHarness({ now: () => now, idleTtlMs: 300, cleanupIntervalMs: 10 });
    const attachment = await harness.manager.attach("session_12345678", LEARNER, socketAsWebSocket(new FakeSocket()));
    await harness.manager.handleRawMessage(
      attachment.session,
      command("33333333-3333-4333-8333-333333333333", 1),
      false
    );
    expect(harness.bus.events).toContainEqual(expect.objectContaining({ type: "transcript.final", text: "A deterministic science answer." }));

    await attachment.detach();
    now = 301;
    await vi.advanceTimersByTimeAsync(10);
    expect(harness.bus.durableEvents).toBe(0);
    expect(harness.bus.events).toContainEqual(expect.objectContaining({ type: "session.status", state: "ended" }));
    await harness.manager.close();
    expect(harness.bus.paidOperations).toContain(
      "text:session_12345678:33333333-3333-4333-8333-333333333333"
    );
  });

  it("expires an inactive session even while its socket remains open", async () => {
    vi.useFakeTimers();
    let now = 0;
    const harness = createHarness({ now: () => now, idleTtlMs: 300, cleanupIntervalMs: 10 });
    const socket = new FakeSocket();
    await harness.manager.attach("session_12345678", LEARNER, socketAsWebSocket(socket));

    now = 301;
    await vi.advanceTimersByTimeAsync(10);

    expect(socket.readyState).toBe(3);
    expect(harness.bus.durableEvents).toBe(0);
    await harness.manager.close();
  });

  it("handles validation failures, cards, interruptions, remaining tools, and provider errors", async () => {
    const harness = createHarness();
    const attachment = await harness.manager.attach("session_12345678", LEARNER, socketAsWebSocket(new FakeSocket()), "call_12345678");
    await harness.manager.handleRawMessage(attachment.session, Buffer.from("binary"), true);
    await harness.manager.handleRawMessage(attachment.session, Buffer.from("{"), false);
    await harness.manager.handleRawMessage(attachment.session, Buffer.from(JSON.stringify({ protocolVersion: 2 })), false);

    await harness.callbacks()!.onToolCall("cards", {
      name: "present_cards",
      arguments: {
        purpose: "predict",
        prompt: "What happens next?",
        cards: [{ title: "It bends", description: "The ray changes direction.", spokenAliases: [] }]
      }
    });
    const cardsEvent = [...harness.bus.events].reverse().find(
      (event): event is Extract<SessionEvent, { type: "canvas.cards.replace" }> =>
        event.type === "canvas.cards.replace"
    )!;
    await harness.manager.handleRawMessage(attachment.session, Buffer.from(JSON.stringify({
      protocolVersion: 1,
      commandId: "44444444-4444-4444-8444-444444444444",
      revision: 1,
      type: "learner.card.select",
      cardId: cardsEvent.cards[0]!.id
    })), false);
    expect(harness.bus.events).toContainEqual(expect.objectContaining({ type: "canvas.cards.replace", revision: 1 }));

    harness.callbacks()!.onTranscriptDelta("turn", "Partial answer");
    await harness.manager.handleRawMessage(attachment.session, Buffer.from(JSON.stringify({
      protocolVersion: 1,
      commandId: "55555555-5555-4555-8555-555555555555",
      revision: 2,
      type: "learner.speech.start",
      at: 10,
      turnId: "turn",
      heardCharacters: "Partial answer".length
    })), false);
    expect(harness.sideband.cancelled).toBe(1);
    expect(harness.bus.events).toContainEqual(expect.objectContaining({ type: "transcript.final", interrupted: true }));

    await harness.callbacks()!.onToolCall("evidence", {
      name: "record_learning_evidence",
      arguments: { concept: "refraction", evidence: "Prediction selected", confidenceDelta: 0.2, preferenceSignals: {} }
    });
    await harness.callbacks()!.onToolCall("stop", { name: "stop_visual", arguments: { reason: "complete" } });
    await harness.callbacks()!.onToolCall("evidence-2", {
      name: "record_learning_evidence",
      arguments: { concept: "refraction", evidence: "Explained the bend", confidenceDelta: 0.1, preferenceSignals: {} }
    });
    expect(harness.bus.events).toContainEqual({
      protocolVersion: 1,
      type: "learning.progress",
      concepts: [{ concept: "refraction", mastery: 0.8, evidenceCount: 2 }]
    });
    harness.callbacks()!.onProviderError("rate_limit_exceeded");
    expect(harness.bus.durableEvents).toBe(2);
    await vi.waitFor(() => expect(harness.bus.events).toContainEqual(expect.objectContaining({ type: "session.error", code: "provider_rate_limited" })));

    await harness.manager.close();
    expect(harness.bus.events).toContainEqual(expect.objectContaining({ type: "session.status", state: "ended" }));
  });

  it("hydrates revision and canvas state when another manager takes regional ownership", async () => {
    const sharedBus = new FakeBus();
    const first = createHarness({}, sharedBus);
    const firstAttachment = await first.manager.attach("session_12345678", LEARNER, socketAsWebSocket(new FakeSocket()), "call_12345678");
    await first.callbacks()!.onToolCall("cards", {
      name: "present_cards",
      arguments: {
        purpose: "predict",
        prompt: "Choose",
        cards: [{ title: "One", description: "First choice", spokenAliases: [] }]
      }
    });
    await firstAttachment.detach();

    const second = createHarness({}, sharedBus);
    await second.manager.attach("session_12345678", LEARNER, socketAsWebSocket(new FakeSocket()), "call_87654321");
    const result = await second.callbacks()!.onToolCall("cards-2", {
      name: "present_cards",
      arguments: {
        purpose: "predict",
        prompt: "Choose again",
        cards: [{ title: "Two", description: "Second choice", spokenAliases: [] }]
      }
    });

    expect(result).toEqual({ accepted: true, revision: 2 });
    expect(sharedBus.states.get("session_12345678")?.canvas.cards[0]).toEqual(
      expect.objectContaining({ id: expect.stringMatching(/^card_/), title: "Two" })
    );
    await second.manager.close();
  });

  it("rejects a different learner across managers sharing the ownership store", async () => {
    const sharedBus = new FakeBus();
    const first = createHarness({}, sharedBus);
    const second = createHarness({}, sharedBus);
    await first.manager.attach("session_12345678", LEARNER, socketAsWebSocket(new FakeSocket()), "call_12345678");

    await expect(second.manager.attach(
      "session_12345678",
      { ...LEARNER, learnerId: "lrn_qrstuvwxyzabcdef" },
      socketAsWebSocket(new FakeSocket()),
      "call_87654321"
    )).rejects.toThrow("ownership");
    await first.manager.close();
    await second.manager.close();
  });

  it("serializes concurrent commands and enforces contiguous revisions", async () => {
    const harness = createHarness();
    const attachment = await harness.manager.attach("session_12345678", LEARNER, socketAsWebSocket(new FakeSocket()), "call_12345678");
    await Promise.all([
      harness.manager.handleRawMessage(attachment.session, command("88888888-8888-4888-8888-888888888888", 1, "first"), false),
      harness.manager.handleRawMessage(attachment.session, command("99999999-9999-4999-8999-999999999999", 2, "second"), false)
    ]);

    expect(harness.sideband.learnerTexts).toEqual(["first", "second"]);
    expect(harness.bus.states.get("session_12345678")?.lastCommandRevision).toBe(2);
    await harness.manager.close();
  });

  it("rejects cross-learner ownership and permits only one provider call handoff", async () => {
    const harness = createHarness();
    await harness.manager.attach("session_12345678", LEARNER, socketAsWebSocket(new FakeSocket()), "call_12345678");
    await expect(harness.manager.attach(
      "session_12345678",
      { ...LEARNER, learnerId: "lrn_qrstuvwxyzabcdef" },
      socketAsWebSocket(new FakeSocket()),
      "call_12345678"
    )).rejects.toThrow("ownership");
    await harness.manager.attach("session_12345678", LEARNER, socketAsWebSocket(new FakeSocket()), "call_87654321");
    await expect(harness.manager.attach(
      "session_12345678",
      LEARNER,
      socketAsWebSocket(new FakeSocket()),
      "call_abcdefgh"
    )).rejects.toThrow("already attempted");
    await harness.manager.close();
  });
});
