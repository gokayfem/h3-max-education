import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionEvent } from "@axiom/protocol";

const falMocks = vi.hoisted(() => ({
  connect: vi.fn(),
}));

vi.mock("@fal-ai/client", () => ({
  createFalClient: () => ({
    realtime: { connect: falMocks.connect },
  }),
}));
import { BrowserRealtimeTransport, type BrowserRealtimeDependencies } from "./browser-realtime-transport";

class FakeDataChannel extends EventTarget {
  readyState: RTCDataChannelState = "open";
  readonly sent: string[] = [];

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.readyState = "closed";
  }
}

class FakeWebSocket extends EventTarget {
  readyState: number = WebSocket.OPEN;
  readonly sent: string[] = [];
  readonly close = vi.fn(() => {
    this.readyState = WebSocket.CLOSED;
  });

  send(data: string) {
    this.sent.push(data);
  }
}

class FakePeerConnection extends EventTarget {
  connectionState: RTCPeerConnectionState = "connected";
  localDescription: RTCSessionDescription | null = null;
  ontrack: ((event: RTCTrackEvent) => void) | null = null;
  readonly channel = new FakeDataChannel();
  readonly addTrack = vi.fn();
  readonly close = vi.fn();

  createDataChannel() {
    return this.channel as unknown as RTCDataChannel;
  }

  async createOffer(): Promise<RTCSessionDescriptionInit> {
    return { type: "offer", sdp: "offer-sdp" };
  }

  async setLocalDescription(description: RTCLocalSessionDescriptionInit) {
    this.localDescription = description as RTCSessionDescription;
  }

  async setRemoteDescription() {}
}

function createHarness(
  negotiationResponse = new Response("answer-sdp", {
    headers: {
      "content-type": "application/sdp",
      "x-axiom-openai-call-id": "rtc_test-call-1234",
      "x-axiom-gateway-ticket": "short-lived-gateway-token",
      "x-axiom-command-revision": "0",
    }
  })
) {
  const peer = new FakePeerConnection();
  const localTrack = { stop: vi.fn(), enabled: true } as unknown as MediaStreamTrack;
  const localStream = {
    getTracks: () => [localTrack],
    getAudioTracks: () => [localTrack],
  } as unknown as MediaStream;
  const audio = {
    autoplay: false,
    muted: false,
    srcObject: null,
    pause: vi.fn(),
    play: vi.fn(async () => undefined)
  } as unknown as HTMLAudioElement;
  const dependencies: BrowserRealtimeDependencies = {
    createPeerConnection: () => peer as unknown as RTCPeerConnection,
    getUserMedia: vi.fn(async () => localStream),
    createAudioElement: () => audio,
    createWebSocket: vi.fn(() => {
      throw new Error("Gateway socket is not expected without a configured gateway URL.");
    }),
    fetch: vi.fn(async (input) => {
      const url = String(input);
      if (url.endsWith("/api/gateway-token")) {
        return Response.json({ token: "short-lived-gateway-token", commandRevision: 0 });
      }
      if (url.includes("/close")) {
        return Response.json({ deleted: true });
      }
      return negotiationResponse.clone();
    }),
    now: () => 1_000
  };
  return { peer, localTrack, audio, dependencies };
}

function typedTurnResponse(text = "Typed science reply", cardRevision = 1) {
  const turnId = "44444444-4444-4444-8444-444444444444";
  return new Response(JSON.stringify({
    sessionId: "33333333-3333-4333-8333-333333333333",
    turnId,
    reply: text,
    cards: { revision: cardRevision },
    events: [{ protocolVersion: 1, type: "transcript.final", turnId, text, interrupted: false }],
    toolCalls: [{
      name: "present_cards",
      arguments: {
        purpose: "branch",
        prompt: "Choose",
        cards: [{ title: "One", description: "First option" }]
      }
    }]
  }), { headers: { "content-type": "application/json" } });
}

describe("BrowserRealtimeTransport", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    falMocks.connect.mockReset();
  });

  it("mutes synchronously before sending the full cancellation sequence", async () => {
    const { peer, audio, dependencies } = createHarness();
    const responseStarted = vi.fn();
    let cancellation: Promise<void> | undefined;
    const transport = new BrowserRealtimeTransport({
      dependencies,
      gatewayUrl: "",
      onSpeechStarted: (context) => {
        if (!context) return;
        cancellation = transport.cancelResponse()
          .then(() => transport.clearOutputAudio())
          .then(() => transport.truncateAssistant(context.turnId));
      },
      onResponseStarted: responseStarted,
    });
    await transport.open({ sessionId: "session-1", learnerId: "learner-1" });
    peer.channel.dispatchEvent(new MessageEvent("message", {
      data: JSON.stringify({ type: "response.output_item.added", item: { id: "turn-1", type: "message" } })
    }));
    peer.channel.dispatchEvent(new MessageEvent("message", {
      data: JSON.stringify({ type: "response.output_audio_transcript.delta", item_id: "turn-1", delta: "Gravity" })
    }));
    peer.channel.dispatchEvent(new MessageEvent("message", {
      data: JSON.stringify({ type: "input_audio_buffer.speech_started", item_id: "input-1", audio_start_ms: 100 })
    }));

    expect(audio.muted).toBe(true);
    await cancellation;
    expect(peer.channel.sent.map((value) => JSON.parse(value))).toEqual([
      { type: "response.cancel" },
      { type: "output_audio_buffer.clear" },
      { type: "conversation.item.truncate", item_id: "turn-1", content_index: 0, audio_end_ms: 0 }
    ]);

    peer.channel.dispatchEvent(new MessageEvent("message", {
      data: JSON.stringify({ type: "response.output_item.added", item: { id: "turn-2", type: "message" } })
    }));
    expect(audio.muted).toBe(true);
    expect(responseStarted).toHaveBeenCalledWith("turn-2");
    await transport.resumeOutput();
    expect(audio.muted).toBe(false);
  });

  it("uses the SDP ticket without a token POST and keeps visual signals off the learner revision", async () => {
    const { dependencies } = createHarness();
    const socket = new FakeWebSocket();
    const createWebSocket = vi.fn((url: string, protocols?: string | string[]) => {
      void url;
      void protocols;
      return socket as unknown as WebSocket;
    });
    dependencies.createWebSocket = createWebSocket;
    const transport = new BrowserRealtimeTransport({
      dependencies,
      gatewayUrl: "https://gateway.example.test/realtime"
    });
    const sessionId = "33333333-3333-4333-8333-333333333333";

    await transport.open({ sessionId, learnerId: "learner-1" });
    await Promise.resolve();
    await transport.sendText("Why do planets orbit?");
    expect(transport.sendVisualAuthorized({
      visualOperationId: "visual-operation-1",
      visualRevision: 3,
      reservationId: "reservation-1",
    })).toBe(true);
    expect(transport.sendVisualReady({
      visualOperationId: "visual-operation-1",
      visualRevision: 3,
      reservationId: "reservation-1",
    })).toBe(true);
    expect(transport.sendVisualFailed({
      visualOperationId: "visual-operation-2",
      visualRevision: 4,
      reason: "transport",
    })).toBe(true);
    await transport.sendText("What changes the orbit?");

    expect(createWebSocket).toHaveBeenCalledWith(
      `wss://gateway.example.test/realtime/sessions/${sessionId}?callId=rtc_test-call-1234`,
      ["axiom.realtime.v1", "axiom.ticket.short-lived-gateway-token"],
    );
    expect(createWebSocket.mock.calls[0]?.[0]).not.toContain("short-lived-gateway-token");
    expect(vi.mocked(dependencies.fetch).mock.calls.some(
      ([input]) => String(input).endsWith("/api/gateway-token"),
    )).toBe(false);
    expect(JSON.parse(socket.sent[0] ?? "{}")).toMatchObject({
      revision: 1,
      type: "learner.text",
      text: "Why do planets orbit?"
    });
    expect(JSON.parse(socket.sent[1] ?? "{}")).toMatchObject({ type: "visual.authorized" });
    expect(JSON.parse(socket.sent[2] ?? "{}")).toMatchObject({ type: "visual.ready" });
    expect(JSON.parse(socket.sent[3] ?? "{}")).toMatchObject({ type: "visual.failed" });
    expect(JSON.parse(socket.sent[4] ?? "{}")).toMatchObject({
      revision: 2,
      type: "learner.text",
      text: "What changes the orbit?"
    });
  });

  it("continues gateway command revisions from SDP recovery metadata", async () => {
    const recoveredNegotiation = new Response("answer-sdp", {
      headers: {
        "content-type": "application/sdp",
        "x-axiom-openai-call-id": "rtc_test-call-1234",
        "x-axiom-gateway-ticket": "short-lived-gateway-token",
        "x-axiom-command-revision": "7",
      },
    });
    const { dependencies } = createHarness(recoveredNegotiation);
    const socket = new FakeWebSocket();
    dependencies.createWebSocket = () => socket as unknown as WebSocket;
    const transport = new BrowserRealtimeTransport({
      dependencies,
      gatewayUrl: "https://gateway.example.test/realtime"
    });
    await transport.open({
      sessionId: "33333333-3333-4333-8333-333333333333",
      learnerId: "learner-1"
    });
    await Promise.resolve();
    await transport.sendText("Recovered question");
    expect(JSON.parse(socket.sent[0] ?? "{}")).toMatchObject({ revision: 8, text: "Recovered question" });
  });

  it("uses the direct channel during one reconnect then continues a gateway card through typed HTTP", async () => {
    const { peer, dependencies } = createHarness();
    const firstSocket = new FakeWebSocket();
    const secondSocket = new FakeWebSocket();
    const createWebSocket = vi.fn()
      .mockReturnValueOnce(firstSocket as unknown as WebSocket)
      .mockReturnValueOnce(secondSocket as unknown as WebSocket);
    dependencies.createWebSocket = createWebSocket;
    const baseFetch = dependencies.fetch;
    dependencies.fetch = vi.fn(async (input, init) => {
      const url = String(input);
      if (url.includes("/recover")) return Response.json({ state: { revision: 0 } });
      if (url.includes("/turn")) return typedTurnResponse("Gateway card continued in text", 1);
      return baseFetch(input, init);
    });
    const transcripts: string[] = [];
    const transport = new BrowserRealtimeTransport({
      dependencies,
      gatewayUrl: "https://gateway.example.test",
      onSessionEvent: (event) => {
        if (event.type === "transcript.delta") transcripts.push(event.text);
      },
    });
    await transport.open({
      sessionId: "33333333-3333-4333-8333-333333333333",
      learnerId: "learner-1",
    });
    await Promise.resolve();
    await Promise.resolve();
    firstSocket.dispatchEvent(new MessageEvent("message", {
      data: JSON.stringify({
        protocolVersion: 1,
        type: "canvas.cards.replace",
        revision: 5,
        purpose: "branch",
        prompt: "Choose",
        cards: [{ id: "orbit", title: "Orbital motion", description: "Explore orbit" }],
      }),
    }));

    firstSocket.dispatchEvent(new Event("close"));
    peer.channel.dispatchEvent(new MessageEvent("message", {
      data: JSON.stringify({
        type: "response.output_audio_transcript.delta",
        item_id: "turn-direct",
        delta: "Still heard",
      }),
    }));
    await vi.waitFor(() => {
      expect(createWebSocket).toHaveBeenCalledTimes(2);
    });
    await Promise.resolve();

    expect(transcripts).toEqual(["Still heard"]);
    secondSocket.dispatchEvent(new Event("close"));
    await Promise.resolve();
    expect(transport.mode).toBe("text");
    expect(createWebSocket).toHaveBeenCalledTimes(2);

    await transport.selectCard({ id: "orbit", title: "Orbital motion", revision: 5 });
    const typedTurnCall = vi.mocked(dependencies.fetch).mock.calls.find(
      ([input]) => String(input).includes("/turn"),
    );
    expect(JSON.parse(typedTurnCall?.[1]?.body as string)).toMatchObject({
      revision: 1,
      text: "I choose: Orbital motion",
    });
  });

  it("toggles real microphone tracks and disposes local resources without closing the session", async () => {
    const { localTrack, dependencies } = createHarness();
    const transport = new BrowserRealtimeTransport({ dependencies, gatewayUrl: "" });
    await transport.open({ sessionId: "session-1", learnerId: "learner-1" });

    await transport.setMicrophoneMuted(true);
    expect(localTrack.enabled).toBe(false);
    await transport.setMicrophoneMuted(false);
    expect(localTrack.enabled).toBe(true);

    transport.dispose();
    expect(localTrack.stop).toHaveBeenCalledOnce();
    expect(dependencies.fetch).toHaveBeenCalledOnce();
    await expect(transport.setMicrophoneMuted(true)).rejects.toThrow("not available");
  });


  it("validates inbound events and closes every media resource", async () => {
    const { peer, localTrack, audio, dependencies } = createHarness();
    const receivedTypes: string[] = [];
    const transport = new BrowserRealtimeTransport({
      gatewayUrl: "",
      dependencies,
      onSessionEvent: (event) => receivedTypes.push(event.type)
    });
    await transport.open({ sessionId: "session-1", learnerId: "learner-1" });
    const remoteTrack = { stop: vi.fn() } as unknown as MediaStreamTrack;
    const remoteStream = { getTracks: () => [remoteTrack] } as unknown as MediaStream;
    peer.ontrack?.({ streams: [remoteStream], track: remoteTrack } as unknown as RTCTrackEvent);

    peer.channel.dispatchEvent(new MessageEvent("message", { data: "not-json" }));
    peer.channel.dispatchEvent(
      new MessageEvent("message", {
        data: JSON.stringify({
          type: "response.output_audio_transcript.delta",
          item_id: "turn-1",
          delta: "Force"
        })
      })
    );
    await transport.close("complete");

    expect(receivedTypes.filter((type) => type === "transcript.delta")).toEqual(["transcript.delta"]);
    expect(localTrack.stop).toHaveBeenCalledOnce();
    expect(remoteTrack.stop).toHaveBeenCalledOnce();
    expect(peer.close).toHaveBeenCalledOnce();
    expect(peer.channel.readyState).toBe("closed");
    expect(audio.pause).toHaveBeenCalledOnce();
    expect(audio.srcObject).toBeNull();
  });

  it("enters typed mode when microphone permission is denied", async () => {
    const { dependencies } = createHarness();
    dependencies.getUserMedia = vi.fn(async () => {
      throw new DOMException("Permission denied", "NotAllowedError");
    });
    const events: string[] = [];
    const transport = new BrowserRealtimeTransport({
      gatewayUrl: "",
      dependencies,
      onSessionEvent: (event) => events.push(event.type === "session.status" ? event.state : event.type)
    });

    await transport.open({ sessionId: "session-1", learnerId: "learner-1" });

    expect(transport.mode).toBe("text");
    expect(events).toContain("text_only");
  });
  it("falls back to typed mode and stops a microphone stream that resolves after timeout", async () => {
    vi.useFakeTimers();
    const { localTrack, dependencies } = createHarness();
    let resolveMedia!: (stream: MediaStream) => void;
    const lateStream = {
      getTracks: () => [localTrack],
      getAudioTracks: () => [localTrack],
    } as unknown as MediaStream;
    dependencies.getUserMedia = vi.fn(() => new Promise<MediaStream>((resolve) => {
      resolveMedia = resolve;
    }));
    const events: string[] = [];
    const transport = new BrowserRealtimeTransport({
      gatewayUrl: "",
      dependencies,
      onSessionEvent: (event) =>
        events.push(event.type === "session.status" ? event.state : event.type),
    });

    const opening = transport.open({ sessionId: "session-1", learnerId: "learner-1" });
    await vi.advanceTimersByTimeAsync(10_000);
    await opening;
    resolveMedia(lateStream);
    await Promise.resolve();

    expect(transport.mode).toBe("text");
    expect(events).toContain("text_only");
    expect(localTrack.stop).toHaveBeenCalledOnce();
  });


  it("validates gateway messages and reports socket and URL failures", async () => {
    const { dependencies } = createHarness();
    const socket = new FakeWebSocket();
    dependencies.createWebSocket = vi.fn()
      .mockReturnValueOnce(socket as unknown as WebSocket)
      .mockImplementation(() => new FakeWebSocket() as unknown as WebSocket);
    const events: string[] = [];
    const transport = new BrowserRealtimeTransport({
      dependencies,
      gatewayUrl: "https://gateway.example.test",
      onSessionEvent: (event) => events.push(event.type === "session.status" ? event.state : event.type === "session.error" ? event.code : event.type)
    });
    await transport.open({
      sessionId: "33333333-3333-4333-8333-333333333333",
      learnerId: "learner-1"
    });
    socket.dispatchEvent(new Event("open"));
    socket.dispatchEvent(new MessageEvent("message", { data: "invalid" }));
    socket.dispatchEvent(new MessageEvent("message", { data: new Blob(["binary"]) }));
    socket.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ protocolVersion: 2, type: "session.status", state: "speaking" }) }));
    socket.dispatchEvent(new MessageEvent("message", {
      data: JSON.stringify({ protocolVersion: 1, type: "session.status", state: "speaking" })
    }));
    socket.dispatchEvent(new Event("error"));

    expect(events).toContain("speaking");
    expect(events).toContain("GATEWAY_UNAVAILABLE");

    const invalidUrlEvents: string[] = [];
    const invalidUrlTransport = new BrowserRealtimeTransport({
      dependencies,
      gatewayUrl: "::invalid",
      onSessionEvent: (event) => {
        if (event.type === "session.error") invalidUrlEvents.push(event.code);
      }
    });
    await invalidUrlTransport.open({
      sessionId: "55555555-5555-4555-8555-555555555555",
      learnerId: "learner-1"
    });
    expect(invalidUrlEvents).toContain("GATEWAY_URL_INVALID");

    const throwingHarness = createHarness();
    const socketFailureEvents: string[] = [];
    const throwingTransport = new BrowserRealtimeTransport({
      dependencies: throwingHarness.dependencies,
      gatewayUrl: "https://gateway.example.test",
      onSessionEvent: (event) => {
        if (event.type === "session.error") socketFailureEvents.push(event.code);
      }
    });
    await throwingTransport.open({
      sessionId: "66666666-6666-4666-8666-666666666666",
      learnerId: "learner-1"
    });
    expect(socketFailureEvents).toContain("GATEWAY_UNAVAILABLE");
  });

  it("handles transcript, status, provider error, tool, and VAD events", async () => {
    const { peer, audio, dependencies } = createHarness();
    const eventTypes: string[] = [];
    const tools: string[] = [];
    const speechContexts: unknown[] = [];
    const transport = new BrowserRealtimeTransport({
      dependencies,
      gatewayUrl: "",
      onSessionEvent: (event) => eventTypes.push(event.type === "session.status" ? event.state : event.type),
      onToolCall: (tool) => tools.push(tool.name),
      onSpeechStarted: (context) => speechContexts.push(context)
    });
    await transport.open({ sessionId: "session-1", learnerId: "learner-1" });
    const dispatch = (event: object) => peer.channel.dispatchEvent(
      new MessageEvent("message", { data: JSON.stringify(event) })
    );
    dispatch({ type: "input_audio_buffer.speech_started", item_id: "input-0", audio_start_ms: 0 });
    dispatch({ type: "response.created" });
    dispatch({ type: "output_audio_buffer.started" });
    dispatch({ type: "response.output_text.delta", item_id: "turn-2", delta: "Atoms" });
    dispatch({ type: "response.output_text.done", item_id: "turn-2", text: "Atoms move." });
    dispatch({
      type: "response.function_call_arguments.done",
      item_id: "tool-1",
      call_id: "call-1",
      name: "stop_visual",
      arguments: JSON.stringify({ reason: "complete" })
    });
    dispatch({ type: "error", error: { code: "provider_busy" } });
    dispatch({ type: "output_audio_buffer.cleared" });
    dispatch({ type: "input_audio_buffer.speech_started", item_id: "input-1", audio_start_ms: 0 });
    dispatch({ type: "input_audio_buffer.speech_stopped", item_id: "input-1", audio_end_ms: 100 });

    expect(audio.muted).toBe(true);
    expect(speechContexts).toHaveLength(2);
    expect(speechContexts[0]).toBeNull();
    expect(eventTypes).toEqual(expect.arrayContaining([
      "thinking", "speaking", "transcript.delta", "transcript.final", "session.error", "listening"
    ]));
    expect(tools).toEqual(["stop_visual"]);
  });

  it("uses negotiation and microphone fallbacks for typed tutoring", async () => {
    const fallback = new Response(
      JSON.stringify({ mode: "text", recoverable: true, code: "OPENAI_NOT_CONFIGURED" }),
      { status: 503, headers: { "content-type": "application/json" } }
    );
    const fallbackHarness = createHarness(fallback);
    const fallbackTransport = new BrowserRealtimeTransport({
      dependencies: fallbackHarness.dependencies,
      gatewayUrl: ""
    });
    await fallbackTransport.open({ sessionId: "session-1", learnerId: "learner-1" });
    expect(fallbackTransport.mode).toBe("text");
    expect(fallbackHarness.localTrack.stop).toHaveBeenCalledOnce();

    const microphoneHarness = createHarness();
    microphoneHarness.dependencies.getUserMedia = vi.fn(async () => {
      throw new DOMException("Denied", "NotAllowedError");
    });
    let typedMutationCount = 0;
    const typedFetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toContain("/api/session/");
      if (String(url).includes("/recover")) {
        return Response.json({ state: { revision: 7 + typedMutationCount } });
      }
      expect(init?.method).toBe("POST");
      typedMutationCount += 1;
      return typedTurnResponse("Typed science reply", 7 + typedMutationCount);
    });
    microphoneHarness.dependencies.fetch = typedFetch;
    const received: string[] = [];
    const tools: string[] = [];
    const typedTransport = new BrowserRealtimeTransport({
      dependencies: microphoneHarness.dependencies,
      gatewayUrl: "",
      initialCommandRevision: 7,
      onSessionEvent: (event) => received.push(event.type),
      onToolCall: (tool) => tools.push(tool.name),
    });
    await typedTransport.open({
      sessionId: "33333333-3333-4333-8333-333333333333",
      learnerId: "learner-1"
    });
    await typedTransport.sendText("Explain atoms");
    await typedTransport.selectCard({ id: "one", title: "One", revision: 8 });
    await typedTransport.sendText("Go deeper");

    expect(received).toContain("transcript.final");
    expect(tools).toEqual(["present_cards", "present_cards", "present_cards"]);
    const typedBodies = typedFetch.mock.calls
      .filter((call) => call[1]?.method === "POST")
      .map((call) => JSON.parse(call[1]?.body as string));
    expect(typedBodies[0]).toMatchObject({
      protocolVersion: 1,
      revision: 8,
      text: "Explain atoms"
    });
    expect(typedBodies[1]).toMatchObject({
      protocolVersion: 1,
      revision: 8,
      cardId: "one",
    });
    expect(typedBodies[2]).toMatchObject({
      protocolVersion: 1,
      revision: 10,
      text: "Go deeper",
    });
  });

  it("stops the microphone before a never-settling close request times out", async () => {
    vi.useFakeTimers();
    const { localTrack, dependencies } = createHarness();
    const transport = new BrowserRealtimeTransport({ dependencies, gatewayUrl: "" });
    await transport.open({ sessionId: "session-timeout", learnerId: "learner-1" });
    dependencies.fetch = vi.fn((_input, init) => new Promise<Response>((_resolve, reject) => {
      if (init?.signal?.aborted) {
        reject(new DOMException("Aborted", "AbortError"));
        return;
      }
      init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), {
        once: true,
      });
    }));

    const closing = transport.close("abandoned");
    expect(localTrack.enabled).toBe(false);
    expect(localTrack.stop).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(10_000);
    await closing;
    expect(transport.mode).toBe("text");
  });

  it("closes typed sessions through HTTP exactly once with the next revision", async () => {
    const { dependencies } = createHarness();
    dependencies.getUserMedia = vi.fn(async () => {
      throw new DOMException("Denied", "NotAllowedError");
    });
    const fetchImplementation = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toContain("/close");
      expect(init?.method).toBe("POST");
      return Response.json({
        sessionId: "33333333-3333-4333-8333-333333333333",
        summary: "Session closed.",
        deleted: true,
      });
    });
    dependencies.fetch = fetchImplementation;
    const closed = vi.fn();
    window.addEventListener("axiom:session-closed", closed);
    const transport = new BrowserRealtimeTransport({
      dependencies,
      gatewayUrl: "",
      initialCommandRevision: 5,
    });
    await transport.open({
      sessionId: "33333333-3333-4333-8333-333333333333",
      learnerId: "learner-1"
    });

    await transport.close("complete");

    expect(fetchImplementation).toHaveBeenCalledOnce();
    expect(fetchImplementation).toHaveBeenCalledWith(
      "/api/session/33333333-3333-4333-8333-333333333333/close",
      expect.objectContaining({ method: "POST", credentials: "same-origin" })
    );
    expect(JSON.parse(fetchImplementation.mock.calls[0]?.[1]?.body as string)).toMatchObject({
      protocolVersion: 1,
      revision: 6,
      reason: "complete"
    });
    expect(JSON.parse(fetchImplementation.mock.calls[0]?.[1]?.body as string).commandId)
      .toEqual(expect.any(String));
    expect(closed).toHaveBeenCalledOnce();
    window.removeEventListener("axiom:session-closed", closed);
  });

  it("reports HTTP close failures as recoverable session errors before cleanup", async () => {
    const { dependencies } = createHarness();
    dependencies.getUserMedia = vi.fn(async () => {
      throw new DOMException("Denied", "NotAllowedError");
    });
    dependencies.fetch = vi.fn(async () => new Response("unavailable", { status: 503 }));
    const errors: string[] = [];
    const transport = new BrowserRealtimeTransport({
      dependencies,
      gatewayUrl: "",
      onSessionEvent: (event) => {
        if (event.type === "session.error") errors.push(event.code);
      }
    });
    await transport.open({
      sessionId: "33333333-3333-4333-8333-333333333333",
      learnerId: "learner-1"
    });

    await transport.close("complete");

    expect(errors).toContain("SESSION_CLOSE_FAILED");
    expect(dependencies.fetch).toHaveBeenCalledOnce();
  });

  it("reconnects and degrades after a failed reconnect", async () => {
    const successHarness = createHarness();
    let successPeerCalls = 0;
    successHarness.dependencies.createPeerConnection = () => {
      successPeerCalls += 1;
      return (successPeerCalls === 1
        ? successHarness.peer
        : new FakePeerConnection()) as unknown as RTCPeerConnection;
    };
    const successTransport = new BrowserRealtimeTransport({
      dependencies: successHarness.dependencies,
      gatewayUrl: ""
    });
    await successTransport.open({ sessionId: "session-1", learnerId: "learner-1" });
    expect(await successTransport.reconnect()).toBe(true);
    const attemptIds = vi.mocked(successHarness.dependencies.fetch).mock.calls
      .map(([, init]) => (init?.headers as Record<string, string> | undefined)?.["x-axiom-realtime-attempt"])
      .filter((value): value is string => typeof value === "string");
    expect(attemptIds).toHaveLength(2);
    expect(attemptIds[0]).not.toBe(attemptIds[1]);
    const negotiationHeaders = vi.mocked(successHarness.dependencies.fetch).mock.calls
      .map(([, init]) => init?.headers as Record<string, string> | undefined)
      .filter((headers): headers is Record<string, string> => Boolean(headers?.["x-axiom-realtime-attempt"]));
    expect(negotiationHeaders[0]?.["x-axiom-realtime-reconnect"]).toBeUndefined();
    expect(negotiationHeaders[1]?.["x-axiom-realtime-reconnect"]).toBe("1");
    await successTransport.resumeOutput();

    const failureHarness = createHarness();
    const successfulResponse = new Response("answer", {
      headers: { "content-type": "application/sdp", "x-axiom-openai-call-id": "rtc_first-call" }
    });
    failureHarness.dependencies.fetch = vi.fn()
      .mockResolvedValueOnce(successfulResponse)
      .mockRejectedValueOnce(new Error("offline"));
    const failureTransport = new BrowserRealtimeTransport({
      dependencies: failureHarness.dependencies,
      gatewayUrl: ""
    });
    await failureTransport.open({ sessionId: "session-2", learnerId: "learner-1" });
    expect(await failureTransport.reconnect()).toBe(false);
    expect(failureTransport.mode).toBe("text");
  });

  it("rejects non-recoverable negotiation responses and closed-channel commands", async () => {
    const rejectedHarness = createHarness(new Response("bad gateway", { status: 502 }));
    const rejectedTransport = new BrowserRealtimeTransport({
      dependencies: rejectedHarness.dependencies,
      gatewayUrl: ""
    });
    await expect(rejectedTransport.open({ sessionId: "session-1", learnerId: "learner-1" }))
      .rejects.toThrow("status 502");
    expect(rejectedHarness.localTrack.stop).toHaveBeenCalledOnce();
    expect(await rejectedTransport.reconnect()).toBe(false);

    const closedHarness = createHarness();
    const closedTransport = new BrowserRealtimeTransport({
      dependencies: closedHarness.dependencies,
      gatewayUrl: ""
    });
    await closedTransport.open({ sessionId: "session-2", learnerId: "learner-1" });
    await closedTransport.close("error");
    await expect(closedTransport.cancelResponse()).rejects.toThrow("not open");
  });

  it("reports one peer failure and covers direct card and media fallbacks", async () => {
    const failureHarness = createHarness();
    const connectionFailure = vi.fn();
    const transport = new BrowserRealtimeTransport({
      dependencies: failureHarness.dependencies,
      gatewayUrl: "",
      onConnectionFailure: connectionFailure
    });
    await transport.open({ sessionId: "session-3", learnerId: "learner-1" });
    failureHarness.peer.connectionState = "failed";
    failureHarness.peer.dispatchEvent(new Event("connectionstatechange"));
    failureHarness.peer.dispatchEvent(new Event("connectionstatechange"));
    failureHarness.dependencies.fetch = vi.fn(async (input) => {
      const url = String(input);
      if (url.includes("/recover")) return Response.json({ state: { revision: 1 } });
      if (url.includes("/card")) return typedTurnResponse("Gravity selected", 3);
      return new Response("unexpected", { status: 500 });
    });
    await transport.truncateAssistant("unknown-turn");
    await transport.selectCard({ id: "gravity", title: "Gravity", revision: 2 });

    expect(connectionFailure).toHaveBeenCalledOnce();
    expect(failureHarness.peer.channel.sent.map((message) => JSON.parse(message))).toEqual([
      { type: "conversation.item.truncate", item_id: "unknown-turn", content_index: 0, audio_end_ms: 0 }
    ]);
    expect(failureHarness.dependencies.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/card"),
      expect.objectContaining({ method: "POST" }),
    );

    const mediaHarness = createHarness();
    mediaHarness.dependencies.getUserMedia = vi.fn(async () => {
      throw new DOMException("Device failed", "NotReadableError");
    });
    const mediaTransport = new BrowserRealtimeTransport({
      dependencies: mediaHarness.dependencies,
      gatewayUrl: ""
    });
    await mediaTransport.open({ sessionId: "session-4", learnerId: "learner-1" });
    expect(mediaTransport.mode).toBe("text");
  });

  it("rejects transient speaker echo and auto-interrupts on sustained learner speech", async () => {
    vi.stubEnv("NEXT_PUBLIC_FAL_GROK_VOICE_ENABLED", "true");
    const sent: Record<string, unknown>[] = [];
    const closeConnection = vi.fn();
    let realtimeHandler!: {
      tokenProvider: (appId: string) => Promise<string>;
      onResult: (event: Record<string, unknown>) => void;
    };
    falMocks.connect.mockImplementation((
      app: string,
      handler: typeof realtimeHandler,
    ) => {
      realtimeHandler = handler;
      void handler.tokenProvider(app).then(() => {
        handler.onResult({ type: "session.created" });
      });
      return {
        send: (event: Record<string, unknown>) => sent.push(event),
        close: closeConnection,
      };
    });
    const inputProcessor = {
      connect: vi.fn(),
      disconnect: vi.fn(),
      onaudioprocess: null as ((event: {
        inputBuffer: { sampleRate: number; getChannelData: (channel: number) => Float32Array };
      }) => void) | null,
    };
    let finishOutput: (() => void) | undefined;
    const outputSource = {
      buffer: null as AudioBuffer | null,
      connect: vi.fn(),
      addEventListener: vi.fn((_type: string, listener: () => void) => {
        finishOutput = listener;
      }),
      start: vi.fn(),
      stop: vi.fn(),
    };
    class FakeAudioContext {
      readonly destination = {};
      readonly currentTime = 2;
      state = "running";
      createMediaStreamSource() {
        return { connect: vi.fn(), disconnect: vi.fn() };
      }
      createScriptProcessor() {
        return inputProcessor;
      }
      createGain() {
        return { connect: vi.fn(), disconnect: vi.fn(), gain: { value: 1 } };
      }
      createBuffer(_channels: number, length: number, sampleRate: number) {
        const samples = new Float32Array(length);
        return {
          duration: length / sampleRate,
          getChannelData: () => samples,
        };
      }
      createBufferSource() {
        return outputSource;
      }
      resume = vi.fn(async () => undefined);
      close = vi.fn(async () => {
        this.state = "closed";
      });
    }
    vi.stubGlobal("AudioContext", FakeAudioContext);
    const { dependencies } = createHarness();
    dependencies.createPeerConnection = vi.fn(() => {
      throw new Error("WebRTC must not be used for Grok Voice.");
    });
    dependencies.fetch = vi.fn(async (input) => {
      if (String(input).endsWith("/api/dev/fal-realtime-token")) {
        return Response.json({
          token: "fal-short-lived-token",
          expiresInSeconds: 120,
        });
      }
      if (String(input).includes("/close")) return Response.json({ deleted: true });
      return new Response("unexpected", { status: 500 });
    });
    const events: SessionEvent[] = [];
    const speechStarted = vi.fn();
    const transport = new BrowserRealtimeTransport({
      dependencies,
      gatewayUrl: "",
      onSessionEvent: (event) => events.push(event),
      onSpeechStarted: speechStarted,
    });

    await transport.open({
      sessionId: "33333333-3333-4333-8333-333333333333",
      learnerId: "learner-1",
    });
    await transport.sendText("Why does the Moon orbit Earth?");

    expect(transport.mode).toBe("voice");
    expect(falMocks.connect).toHaveBeenCalledWith(
      "xai/grok-voice/realtime",
      expect.objectContaining({ throttleInterval: 0, tokenExpirationSeconds: 120 }),
    );
    expect(dependencies.fetch).toHaveBeenCalledWith(
      "/api/dev/fal-realtime-token",
      expect.objectContaining({
        method: "POST",
        credentials: "same-origin",
      }),
    );
    expect(vi.mocked(dependencies.fetch).mock.calls[0]?.[1]?.body).toBeUndefined();
    expect(JSON.stringify(vi.mocked(dependencies.fetch).mock.calls)).not.toContain("server-only-key");
    expect(sent).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "x-fal-session.configure",
        prompt: expect.stringContaining("science tutor"),
        voice: "eve",
        turn_detection: {},
      }),
      expect.objectContaining({ type: "conversation.item.create" }),
      { type: "response.create" },
    ]));
    const configure = sent.find((event) => event.type === "x-fal-session.configure");
    expect(configure?.prompt).toEqual(expect.stringContaining(
      "automatic, invisible visualization subsystem silently consumes",
    ));
    expect(configure?.prompt).toEqual(expect.stringContaining(
      "Never ask the learner for a prompt, visual content or preferences, a visual style, permission, or what to show",
    ));
    expect(configure?.prompt).toEqual(expect.stringContaining(
      "Never explain, mention, or allude to visualization or its process, including videos, rendering, prompts, orchestrators, screens",
    ));
    expect(configure?.prompt).toEqual(expect.stringContaining(
      "on-screen typography, overlays, scene changes, or workflows",
    ));
    expect(configure?.prompt).toEqual(expect.stringContaining(
      "Never repeat process language from the learner or prior messages",
    ));
    expect(configure?.prompt).toEqual(expect.stringContaining(
      "Teach the current science topic directly",
    ));
    expect(configure?.prompt).toEqual(expect.stringContaining(
      "concrete, causal explanations grounded in the real world",
    ));
    expect(configure?.prompt).toEqual(expect.stringContaining(
      "Do not ask the learner questions, offer choices, or request confirmation",
    ));
    expect(configure?.prompt).toEqual(expect.stringContaining(
      "Keep spoken replies under 90 words",
    ));
    expect(configure?.prompt).not.toEqual(expect.stringContaining("show_visual"));
    const pcmBytes = new Uint8Array([0, 0, 255, 127]);
    realtimeHandler.onResult({
      type: "response.output_audio.delta",
      delta: btoa(String.fromCharCode(...pcmBytes)),
    });
    expect(outputSource.start).toHaveBeenCalledWith(2);
    expect(outputSource.buffer).not.toBeNull();

    const loudMicrophoneFrame = {
      inputBuffer: {
        sampleRate: 48_000,
        getChannelData: () => new Float32Array([0, 0.5, 1, -1]),
      },
    };
    inputProcessor.onaudioprocess?.(loudMicrophoneFrame);
    expect(sent).not.toContainEqual(expect.objectContaining({
      type: "input_audio_buffer.append",
    }));
    expect(outputSource.stop).not.toHaveBeenCalled();

    inputProcessor.onaudioprocess?.(loudMicrophoneFrame);
    inputProcessor.onaudioprocess?.(loudMicrophoneFrame);
    expect(outputSource.stop).toHaveBeenCalledOnce();
    expect(speechStarted).toHaveBeenCalledOnce();
    expect(sent).toContainEqual(expect.objectContaining({
      type: "input_audio_buffer.append",
    }));

    realtimeHandler.onResult({
      type: "input_audio_buffer.speech_started",
      item_id: "learner-speech",
      audio_start_ms: 0,
    });
    expect(speechStarted).toHaveBeenCalledOnce();
    realtimeHandler.onResult({ type: "response.done" });
    finishOutput?.();
    inputProcessor.onaudioprocess?.(loudMicrophoneFrame);
    const inputAudioEvent = sent.find((event) => event.type === "input_audio_buffer.append");
    expect(atob(String(inputAudioEvent?.audio))).toHaveLength(4);
    expect(events).toContainEqual({ protocolVersion: 1, type: "session.status", state: "listening" });
    transport.dispose();
    expect(closeConnection).toHaveBeenCalledOnce();
  });

  it("uses the browser microphone dependency and handles security denial", async () => {
    const originalDescriptor = Object.getOwnPropertyDescriptor(navigator, "mediaDevices");
    const getUserMedia = vi.fn(async () => {
      throw new DOMException("Blocked by policy", "SecurityError");
    });
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia }
    });
    try {
      const transport = new BrowserRealtimeTransport({ gatewayUrl: "" });
      await transport.open({ sessionId: "session-defaults", learnerId: "learner-1" });
      expect(transport.mode).toBe("text");
      expect(getUserMedia).toHaveBeenCalledWith({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
        },
        video: false,
      });
    } finally {
      if (originalDescriptor) Object.defineProperty(navigator, "mediaDevices", originalDescriptor);
      else Reflect.deleteProperty(navigator, "mediaDevices");
    }
  });
});
