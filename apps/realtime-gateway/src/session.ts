import { createHash, randomUUID } from "node:crypto";
import { RevisionedLearningCanvas } from "@axiom/domain";
import { browserCommandSchema, type BrowserCommand, type SessionEvent, type TutorToolCall } from "@axiom/protocol";
import type WebSocket from "ws";
import type { AuthenticatedLearner } from "./auth.js";
import type { GatewayConfig } from "./config.js";
import type {
  GatewaySessionLease,
  SessionEventBus,
  SocketPermit
} from "./event-bus.js";
import type { SafeLogger } from "./logger.js";
import type { GatewayMetrics } from "./metrics.js";
import { OpenAiRealtimeSideband, OpenAiTextTutor, type RealtimeSideband, type SidebandCallbacks, type TextTutor } from "./providers.js";

const IDLE_TTL_MS = 5 * 60 * 1_000;
const MAX_SUMMARY_TURNS = 20;
const MAX_TRANSCRIPT_TEXT = 16_384;

type GatewayState = "connecting" | "listening" | "thinking" | "speaking" | "redirecting" | "text_only" | "reconnecting" | "ended";
type VisualClientCommand = Extract<BrowserCommand, { type: "visual.authorized" | "visual.ready" | "visual.failed" }>;
type LearnerCommand = Exclude<BrowserCommand, VisualClientCommand>;

interface SessionRecord {
  readonly id: string;
  readonly learner: AuthenticatedLearner;
  readonly sessionRef: string;
  readonly sockets: Set<WebSocket>;
  readonly socketPermits: Map<WebSocket, SocketPermit>;
  readonly canvas: RevisionedLearningCanvas;
  readonly summaryTurns: string[];
  readonly concepts: Set<string>;
  readonly mastery: Map<string, { confidence: number; evidenceCount: number }>;
  readonly explorationEdges: Array<{ from: string; to: string; relation?: string }>;
  readonly processedEvidence: Set<string>;
  readonly cardPurposes: Map<string, "branch" | "predict" | "compare" | "sequence" | "check">;
  lastExplorationNode?: string;
  readonly learnerContext: string;
  readonly textTutor: TextTutor;
  sideband?: RealtimeSideband;
  sidebandCallId?: string;
  lease: GatewaySessionLease;
  providerReady: boolean;
  unsubscribe: () => void;
  readonly startedAt: Date;
  lastActivity: number;
  lastCommandRevision: number;
  eventRevision: number;
  reconnectAttempted: boolean;
  state: GatewayState;
  readonly transcriptOverflowTurns: Set<string>;
  currentAssistantTurn?: string;
  currentAssistantText: string;
  readonly interruptedTurns: Set<string>;
  activeCommandEvents?: SessionEvent[];
  visualCompletionTimer?: NodeJS.Timeout;
  closePromise?: Promise<void>;
  closing: boolean;
  activeVisual?: {
    readonly id: string;
    reservationId?: string;
    readonly concept: string;
    readonly durationSeconds: 5 | 10 | 15;
    readonly resolution: "480p";
    readonly promptVersion: number;
    readonly authorizedAt: number;
    status: "pending" | "authorized" | "ready" | "failed";
    readonly resolveAuthorization: (result: unknown) => void;
    authorizationTimer: NodeJS.Timeout;
  };
  commandQueue: Promise<void>;
  receiveQueue: Promise<void>;
}

export interface SessionAttachment {
  readonly session: SessionRecord;
  readonly detach: () => Promise<void>;
}
export type TextTutorFactory = (learnerContext: string) => TextTutor;


export interface GatewaySessionManagerOptions {
  readonly idleTtlMs?: number;
  readonly cleanupIntervalMs?: number;
  readonly sessionOwnerRefreshIntervalMs?: number;
  readonly now?: () => number;
  readonly socketPermitRefreshIntervalMs?: number;
  readonly sidebandFactory?: (callId: string, callbacks: SidebandCallbacks, learnerContext: string) => RealtimeSideband;
  readonly textTutorFactory?: TextTutorFactory;
}

export class GatewaySessionManager {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly sessionOwnerRefreshTimer: NodeJS.Timeout;
  private readonly cleanupTimer: NodeJS.Timeout;
  private readonly socketPermitRefreshTimer: NodeJS.Timeout;
  private activeSockets = 0;
  private readonly attachQueues = new Map<string, Promise<void>>();
  private shuttingDown = false;

  private readonly idleTtlMs: number;
  private readonly now: () => number;
  private readonly sidebandFactory: (callId: string, callbacks: SidebandCallbacks, learnerContext: string) => RealtimeSideband;
  private readonly textTutorFactory: TextTutorFactory;

  constructor(
    private readonly config: GatewayConfig,
    private readonly bus: SessionEventBus,
    private readonly metrics: GatewayMetrics,
    private readonly logger: SafeLogger,
    options: GatewaySessionManagerOptions = {}
  ) {
    this.idleTtlMs = options.idleTtlMs ?? this.config.sessionIdleTimeoutMs ?? IDLE_TTL_MS;
    this.now = options.now ?? Date.now;
    this.sidebandFactory = options.sidebandFactory ??
      ((callId, callbacks, learnerContext) =>
        new OpenAiRealtimeSideband(callId, this.config.openAiApiKey!, callbacks, learnerContext));
    this.textTutorFactory = options.textTutorFactory ??
      ((learnerContext) => new OpenAiTextTutor(
        this.config.openAiApiKey,
        this.config.openAiTextModel,
        learnerContext
      ));
    this.cleanupTimer = setInterval(() => void this.cleanupIdle(), options.cleanupIntervalMs ?? 30_000);
    this.cleanupTimer.unref();
    this.socketPermitRefreshTimer = setInterval(
      () => void this.refreshSocketPermits(),
      options.socketPermitRefreshIntervalMs ?? 5 * 60 * 1_000
    );
    this.sessionOwnerRefreshTimer = setInterval(
      () => void this.refreshSessionOwners(),
      options.sessionOwnerRefreshIntervalMs ?? 10_000
    );
    this.sessionOwnerRefreshTimer.unref();
    this.socketPermitRefreshTimer.unref();
  }

  async attach(
    sessionId: string,
    learner: AuthenticatedLearner,
    socket: WebSocket,
    callId?: string,
    connectionIdentity = "local"
  ): Promise<SessionAttachment> {
    const permit = await this.bus.reserveSocketPermit(sessionId, learner.learnerId, connectionIdentity);
    if (!permit) {
      this.metrics.recordSocketAdmissionRejection();
      throw new Error("Live socket limit rejected");
    }
    try {
      return await this.withAttachLock(sessionId, async () => {
        if (this.shuttingDown) throw new Error("Gateway is shutting down");
        let session = this.sessions.get(sessionId);
        if (session?.closing) throw new Error("Session is closing");
        if (session && session.learner.learnerId !== learner.learnerId) {
          throw new Error("Session ownership mismatch");
        }

        let isNew = false;
        let isProviderHandoff = false;
        if (!session) {
          const lease = await this.bus.bindSessionOwner(sessionId, learner.learnerId, callId);
          if (!lease) throw new Error("Session ownership or learner session limit rejected");
          try {
            session = await this.createSession(sessionId, learner, lease);
            this.sessions.set(sessionId, session);
            this.metrics.setActiveSessions(this.sessions.size);
            isNew = true;
          } catch (error) {
            await this.bus.releaseSessionOwner(lease);
            throw error;
          }
        } else {
          const retained = await this.bus.refreshSessionOwner(session.lease, callId ?? session.sidebandCallId);
          if (!retained) throw new Error("Session ownership lease lost");
          if (callId) session.lease = { ...session.lease, callId };
          if (callId && session.sidebandCallId && callId !== session.sidebandCallId) {
            if (session.reconnectAttempted) throw new Error("Provider reconnect already attempted");
            session.reconnectAttempted = true;
            isProviderHandoff = true;
            session.providerReady = false;
            const previousSideband = session.sideband;
            session.sideband = undefined;
            await previousSideband?.close();
          }
        }
        if (session.closing) throw new Error("Session is closing");

        session.sockets.add(socket);
        session.socketPermits.set(socket, permit);
        session.lastActivity = this.now();
        this.activeSockets += 1;
        this.metrics.setActiveSockets(this.activeSockets);
        try {
          if (isNew || isProviderHandoff || (callId && !session.sideband)) {
            await this.openProvider(session, callId, isProviderHandoff);
          }
          this.replayToSocket(session, socket);
        } catch (error) {
          session.socketPermits.delete(socket);
          session.sockets.delete(socket);
          this.activeSockets = Math.max(0, this.activeSockets - 1);
          this.metrics.setActiveSockets(this.activeSockets);
          if (isNew) await this.discardCreatedSession(session);
          throw error;
        }

        const attachedSession = session;
        return {
          session: attachedSession,
          detach: async () => {
            const heldPermit = attachedSession.socketPermits.get(socket);
            if (!heldPermit) return;
            attachedSession.socketPermits.delete(socket);
            attachedSession.sockets.delete(socket);
            attachedSession.lastActivity = this.now();
            this.activeSockets = Math.max(0, this.activeSockets - 1);
            this.metrics.setActiveSockets(this.activeSockets);
            await this.releasePermit(heldPermit);
            if (attachedSession.sockets.size === 0) {
              await this.withAttachLock(attachedSession.id, async () => {
                if (attachedSession.sockets.size === 0 && this.sessions.get(attachedSession.id) === attachedSession) {
                  await this.closeSession(attachedSession, "abandoned");
                }
              });
            }
          }
        };
      });
    } catch (error) {
      await this.releasePermit(permit);
      throw error;
    }
  }

  handleRawMessage(session: SessionRecord, raw: WebSocket.RawData, binary: boolean): Promise<void> {
    const execution = session.receiveQueue.then(() => this.processRawMessage(session, raw, binary));
    session.receiveQueue = execution.then(() => undefined, () => undefined);
    return execution;
  }

  private async processRawMessage(session: SessionRecord, raw: WebSocket.RawData, binary: boolean): Promise<void> {
    session.lastActivity = this.now();
    if (session.closing || this.sessions.get(session.id) !== session) return;
    if (!(await this.bus.refreshSessionOwner(session.lease, session.sidebandCallId))) {
      await this.fenceLostSession(session);
      return;
    }
    if (binary || raw.toString().length > 16_384) {
      this.metrics.increment("validation_failures", "reason=\"frame\"");
      await this.emit(session, this.errorEvent(true, "invalid_command"));
      return;
    }
    let candidate: unknown;
    try {
      candidate = JSON.parse(raw.toString());
    } catch {
      this.metrics.increment("validation_failures", "reason=\"json\"");
      await this.emit(session, this.errorEvent(true, "invalid_command"));
      return;
    }
    const parsed = browserCommandSchema.safeParse(candidate);
    if (!parsed.success) {
      this.metrics.increment("validation_failures", "reason=\"schema\"");
      await this.emit(session, this.errorEvent(true, "invalid_command"));
      return;
    }
    const command = parsed.data;
    this.metrics.recordCommand("received", "control", "ok");
    if (
      command.type === "visual.authorized"
      || command.type === "visual.ready"
      || command.type === "visual.failed"
    ) {
      await this.handleVisualAcknowledgement(session, command);
      return;
    }
    this.metrics.recordCommand("queued", "control", "ok");
    await this.enqueueSessionTask(session, async () => {
      if (session.closing) return;
      await this.executeCommand(session, command);
    });
  }

  private async createSession(
    id: string,
    learner: AuthenticatedLearner,
    lease: GatewaySessionLease
  ): Promise<SessionRecord> {
    const sessionRef = createHash("sha256").update(id).digest("hex").slice(0, 12);
    const [persisted, transcript, learnerMemory] = await Promise.all([
      this.bus.hydrateSessionState(id),
      this.bus.hydrateTranscript(id),
      this.bus.loadLearnerContext(learner.learnerId)
    ]);
    const canvas = this.hydrateCanvas(persisted?.canvas);
    const persistedCommandRevision = await this.bus.readCommandRevision(id, persisted?.lastCommandRevision ?? 0);
    const learnerContext = [
      ...(learnerMemory.ageBand ? [`Learner age band: ${learnerMemory.ageBand}`] : []),
      ...learnerMemory.instructionLines
    ].join("; ").slice(0, 4_000);
    const record: SessionRecord = {
      id,
      learner,
      sessionRef,
      sockets: new Set(),
      socketPermits: new Map(),
      processedEvidence: new Set(),
      canvas,
      summaryTurns: [],
      concepts: new Set(learnerMemory.mastery.map((entry) => entry.concept)),
      mastery: new Map(learnerMemory.mastery.map((entry) => [
        entry.concept,
        { confidence: entry.confidence, evidenceCount: entry.evidenceCount }
      ])),
      cardPurposes: new Map(),
      explorationEdges: [],
      learnerContext,
      textTutor: this.textTutorFactory(learnerContext),
      receiveQueue: Promise.resolve(),
      lease,
      providerReady: false,
      startedAt: new Date(this.now()),
      unsubscribe: () => undefined,
      lastActivity: this.now(),
      lastCommandRevision: persistedCommandRevision,
      eventRevision: persisted?.eventRevision ?? 0,
      reconnectAttempted: false,
      state: "connecting",
      currentAssistantText: "",
      transcriptOverflowTurns: new Set(),
      interruptedTurns: new Set(),
      closing: false,
      commandQueue: Promise.resolve()
    };
    if (
      canvas.snapshot.visual.spec
      && canvas.snapshot.visual.visualOperationId
      && ["starting", "playing", "redirecting"].includes(canvas.snapshot.visual.status)
    ) {
      const visualOperationId = canvas.snapshot.visual.visualOperationId;
      record.activeVisual = {
        id: visualOperationId,
        concept: canvas.snapshot.visual.spec.concept,
        durationSeconds: canvas.snapshot.visual.spec.durationSeconds,
        resolution: "480p",
        promptVersion: canvas.snapshot.revision,
        authorizedAt: performance.now(),
        status: "pending",
        resolveAuthorization: () => undefined,
        authorizationTimer: setTimeout(() => {
          void this.handleVisualAcknowledgement(record, {
            protocolVersion: 1,
            type: "visual.failed",
            sessionId: record.id,
            visualOperationId,
            visualRevision: record.canvas.snapshot.revision,
            reason: "authorization_failed"
          });
        }, 15_000)
      };
      record.activeVisual.authorizationTimer.unref();
    }
    for (const entry of transcript) {
      if (entry.finalized === true && typeof entry.text === "string") {
        this.rememberTurn(record, `${entry.role === "learner" ? "Learner" : "Tutor"}: ${entry.text}`);
      }
    }
    record.unsubscribe = this.bus.subscribe(id, learner.learnerId, (event) => {
      if (record.closing || this.sessions.get(id) !== record) return;
      for (const socket of record.sockets) this.send(socket, event);
    });
    this.logger.write("info", "Session created", { event: "session_created", sessionRef, provider: "gateway" });
    return record;
  }

  private hydrateCanvas(snapshot: SessionRecord["canvas"]["snapshot"] | undefined): RevisionedLearningCanvas {
    const canvas = new RevisionedLearningCanvas();
    if (!snapshot || snapshot.revision === 0) return canvas;
    const hasVisual = snapshot.visual.spec !== null;
    const needsStop = hasVisual && (snapshot.visual.status === "held" || snapshot.visual.status === "idle");
    if (snapshot.visual.spec && !snapshot.visual.visualOperationId) {
      throw new Error("Persisted visual operation identity is missing");
    }
    const eventCount = (snapshot.cards.length > 0 ? 1 : 0) + (hasVisual ? 1 : 0) + (needsStop ? 1 : 0);
    let revision = Math.max(1, snapshot.revision - eventCount + 1);
    if (snapshot.cards.length > 0) {
      canvas.apply({
        protocolVersion: 1,
        type: "canvas.cards.replace",
        revision,
        purpose: "branch",
        prompt: snapshot.cardPrompt ?? "Continue",
        cards: snapshot.cards.map((card) => ({ ...card, spokenAliases: [...card.spokenAliases] }))
      });
      revision += 1;
    }
    if (snapshot.visual.spec) {
      canvas.apply({
        protocolVersion: 1,
        type: snapshot.visual.status === "redirecting" ? "visual.redirect" : "visual.start",
        revision,
        visualOperationId: snapshot.visual.visualOperationId!,
        spec: snapshot.visual.spec
      });
      if (snapshot.visual.lastFrameUrl) canvas.markFrameAvailable(revision, snapshot.visual.lastFrameUrl);
      if (needsStop) {
        revision += 1;
        canvas.apply({ protocolVersion: 1, type: "visual.stop", revision, reason: "complete" });
      }
    }
    return canvas;
  }

  private async openProvider(session: SessionRecord, callId?: string, reconnecting = false): Promise<void> {
    await this.setState(session, reconnecting ? "reconnecting" : "connecting");
    if (!callId || !this.config.openAiApiKey) {
      await this.degradeToText(session, "realtime_not_configured");
      return;
    }
    const startedAt = performance.now();
    const sideband = this.sidebandFactory(callId, {
      onTranscriptDelta: (turnId, text) => {
        void this.enqueueSessionTask(session, async () => {
          if (!this.isCurrentProvider(session, sideband) || session.interruptedTurns.has(turnId)) return;
          if (session.currentAssistantTurn !== turnId) session.currentAssistantText = "";
          session.currentAssistantTurn = turnId;
          const remaining = MAX_TRANSCRIPT_TEXT - session.currentAssistantText.length;
          if (remaining > 0) session.currentAssistantText += text.slice(0, remaining);
          if (text.length > remaining && !session.transcriptOverflowTurns.has(turnId)) {
            session.transcriptOverflowTurns.add(turnId);
            await this.emit(session, this.errorEvent(true, "provider_transcript_too_large"));
          }
          session.lastActivity = this.now();
        });
      },
      onTranscriptFinal: (turnId, text) => {
        void this.enqueueSessionTask(session, async () => {
          if (!this.isCurrentProvider(session, sideband) || session.interruptedTurns.has(turnId)) return;
          const boundedText = text.slice(0, MAX_TRANSCRIPT_TEXT);
          if (boundedText.length !== text.length && !session.transcriptOverflowTurns.has(turnId)) {
            session.transcriptOverflowTurns.add(turnId);
            await this.emit(session, this.errorEvent(true, "provider_transcript_too_large"));
          }
          session.currentAssistantTurn = turnId;
          session.currentAssistantText = boundedText;
          this.rememberTurn(session, `Tutor: ${boundedText}`);
          await this.bus.appendTranscript(session.id, `${turnId}:assistant:final`, {
            turnId,
            role: "assistant",
            text: boundedText,
            finalized: true,
            interrupted: false,
            recordedAt: new Date(this.now()).toISOString()
          });
          await this.emit(session, {
            protocolVersion: 1,
            type: "transcript.final",
            turnId,
            text: boundedText,
            interrupted: false
          });
          await this.refreshSessionLease(session);
        });
      },
      onToolCall: async (providerCallId, call) => this.enqueueSessionTask(session, async () => {
        if (!this.isCurrentProvider(session, sideband)) return { accepted: false, reason: "session_unavailable" };
        return this.executeTool(session, providerCallId, call);
      }),
      onState: (state) => {
        void this.enqueueSessionTask(session, async () => {
          if (this.isCurrentProvider(session, sideband)) await this.setState(session, state);
        });
      },
      onDisconnect: () => {
        if (session.sideband === sideband) session.providerReady = false;
        void this.enqueueSessionTask(session, async () => {
          if (this.isCurrentProvider(session, sideband)) await this.handleProviderDisconnect(session);
        });
      },
      onProviderError: (code) => {
        void this.enqueueSessionTask(session, async () => {
          if (!this.isCurrentProvider(session, sideband)) return;
          this.metrics.increment("provider_failures", "provider=\"openai\"");
          await this.emit(session, this.errorEvent(
            true,
            code === "rate_limit_exceeded"
              ? "provider_rate_limited"
              : code === "provider_frame_too_large"
                ? "provider_frame_too_large"
                : "provider_error"
          ));
        });
      }
    }, session.learnerContext);
    session.sideband = sideband;
    session.sidebandCallId = callId;
    session.providerReady = false;
    try {
      await sideband.connect();
      if (!this.isCurrentProvider(session, sideband)) {
        await sideband.close();
        return;
      }
      session.providerReady = true;
      this.metrics.observeLatency("openai_sideband_connect", "ok", performance.now() - startedAt);
      this.metrics.incrementRealtimeEstablishment("ok");
      await this.setState(session, "listening");
    } catch {
      if (session.sideband !== sideband || session.closing) return;
      session.providerReady = false;
      this.metrics.observeLatency("openai_sideband_connect", "error", performance.now() - startedAt);
      this.metrics.incrementRealtimeEstablishment("error");
      this.metrics.increment("provider_failures", "provider=\"openai\"");
      if (reconnecting) await this.degradeToText(session, "realtime_unavailable");
      else await this.handleProviderDisconnect(session);
    }
  }

  private async handleProviderDisconnect(session: SessionRecord): Promise<void> {
    if (session.closing || session.state === "ended" || session.state === "text_only" || session.state === "reconnecting") return;
    const sideband = session.sideband;
    session.providerReady = false;
    if (session.reconnectAttempted || !sideband) {
      await this.degradeToText(session, "realtime_unavailable");
      return;
    }
    if (!(await this.refreshSessionLease(session))) return;
    session.reconnectAttempted = true;
    this.metrics.increment("provider_reconnects", "provider=\"openai\"");
    await this.setState(session, "reconnecting");
    const startedAt = performance.now();
    try {
      await sideband.connect();
      if (!this.isCurrentProvider(session, sideband)) return;
      session.providerReady = true;
      this.metrics.observeLatency("openai_sideband_reconnect", "ok", performance.now() - startedAt);
      await this.setState(session, "listening");
      for (const socket of session.sockets) this.replayToSocket(session, socket);
    } catch {
      if (!this.isCurrentProvider(session, sideband)) return;
      this.metrics.observeLatency("openai_sideband_reconnect", "degraded", performance.now() - startedAt);
      await this.degradeToText(session, "realtime_unavailable");
    }
  }

  private async degradeToText(session: SessionRecord, code: string): Promise<void> {
    session.providerReady = false;
    session.sideband = undefined;
    await this.emit(session, this.errorEvent(true, code));
    await this.setState(session, "text_only", "Voice unavailable; continue by typing.");
  }

  private async executeCommand(session: SessionRecord, command: LearnerCommand): Promise<void> {
    const operation = await this.bus.beginCommandOperation(
      session.id,
      command.commandId,
      command.revision,
      session.lastCommandRevision
    );
    if (operation.state === "completed") {
      this.metrics.recordCommand("replayed", "control", "ok");
      return;
    }
    if (operation.state === "pending") {
      await this.emit(session, this.errorEvent(true, "command_pending"));
      return;
    }
    if (operation.state === "stale") {
      await this.emit(session, this.errorEvent(true, "stale_command"));
      return;
    }
    if (operation.state !== "accepted") return;
    session.lastCommandRevision = command.revision;
    session.activeCommandEvents = [];
    await this.persistState(session);
    this.metrics.increment("commands", `type="${command.type}"`);
    const startedAt = performance.now();
    try {
      switch (command.type) {
        case "learner.text":
          await this.handleLearnerText(session, command.text, command.commandId);
          break;
        case "learner.card.select":
          await this.handleCardSelection(session, command.cardId, command.commandId);
          break;
        case "learner.speech.start":
          await this.handleInterruption(session, command.turnId, command.heardCharacters);
          break;
        case "learner.speech.end":
          if (session.state === "redirecting") await this.setState(session, "listening");
          break;
      }
      const completed = await this.bus.completeCommandOperation(
        session.id,
        command.commandId,
        operation.attemptToken,
        session.activeCommandEvents ?? []
      );
      if (!completed) throw new Error("Command operation attempt lost");
      this.metrics.observeLatency("browser_command", "ok", performance.now() - startedAt);
    } catch {
      this.metrics.observeLatency("browser_command", "error", performance.now() - startedAt);
      if (!session.closing) await this.emit(session, this.errorEvent(true, "command_failed"));
    } finally {
      session.activeCommandEvents = undefined;
    }
  }

  private async handleLearnerText(session: SessionRecord, text: string, operationId: string): Promise<void> {
    if (session.sideband && session.state !== "text_only") {
      if (!session.providerReady || !session.sideband.sendLearnerText(text, operationId)) {
        this.metrics.recordCommand("delivered", "control", "error");
        throw new Error("Realtime provider is not ready");
      }
      this.metrics.recordCommand("delivered", "control", "ok");
      this.rememberTurn(session, `Learner: ${text}`);
      await this.bus.appendTranscript(session.id, `${operationId}:learner`, {
        turnId: operationId,
        role: "learner",
        text,
        finalized: true,
        recordedAt: new Date(this.now()).toISOString()
      });
      await this.setState(session, "thinking");
      return;
    }
    if (!(await this.bus.reservePaidCommand(session.learner.learnerId, `text:${session.id}:${operationId}`))) {
      await this.emit(session, this.errorEvent(true, "text_quota_exceeded"));
      await this.setState(session, "text_only", "Paid text limit reached.");
      return;
    }
    this.rememberTurn(session, `Learner: ${text}`);
    await this.bus.appendTranscript(session.id, `${operationId}:learner`, {
      turnId: operationId,
      role: "learner",
      text,
      finalized: true,
      recordedAt: new Date(this.now()).toISOString()
    });
    await this.setState(session, "thinking");
    const turnId = randomUUID();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await session.textTutor.respond(text, controller.signal, operationId);
      this.rememberTurn(session, `Tutor: ${response}`);
      await this.bus.appendTranscript(session.id, `${operationId}:assistant`, {
        turnId,
        role: "assistant",
        text: response,
        finalized: true,
        interrupted: false,
        recordedAt: new Date(this.now()).toISOString()
      });
      await this.emit(session, { protocolVersion: 1, type: "transcript.final", turnId, text: response, interrupted: false });
    } catch {
      await this.emit(session, this.errorEvent(true, "text_tutor_unavailable"));
    } finally {
      clearTimeout(timeout);
      await this.setState(session, "text_only", "Continue by typing.");
    }
  }

  private async handleCardSelection(session: SessionRecord, cardId: string, operationId: string): Promise<void> {
    const card = session.canvas.snapshot.cards.find((candidate) => candidate.id === cardId);
    if (!card) {
      this.metrics.recordStaleRevision("cards", "dropped");
      await this.emit(session, this.errorEvent(true, "stale_card"));
      return;
    }
    if (session.sideband) {
      if (!session.providerReady || !session.sideband.selectCard(card.id, card.title, operationId)) {
        this.metrics.recordCommand("delivered", "control", "error");
        throw new Error("Realtime provider is not ready");
      }
      this.metrics.recordCommand("delivered", "control", "ok");
    } else {
      await this.handleLearnerText(session, `I choose “${card.title}”.`, `card:${card.id}:${session.lastCommandRevision}`);
    }
    this.rememberTurn(session, `Learner selected: ${card.title}`);
    this.recordExploration(session, card.title, "selected");
    await this.bus.writeCardInteraction(`card:selected:${session.id}:${operationId}`, {
      sessionId: session.id,
      learnerId: session.learner.learnerId,
      cardId: card.id,
      purpose: session.cardPurposes.get(card.id) ?? "branch",
      action: "selected",
      occurredAt: new Date(this.now())
    });
  }

  private async handleInterruption(
    session: SessionRecord,
    turnId: string | null,
    heardCharacters: number
  ): Promise<void> {
    await this.setState(session, "redirecting", "Changing direction…");
    if (session.currentAssistantTurn) session.interruptedTurns.add(session.currentAssistantTurn);
    if (session.sideband && session.providerReady) {
      const detectedAt = performance.now();
      session.sideband.cancelResponse();
      session.sideband.clearOutputAudio();
      this.metrics.observeLaunchGate("speech_detection_to_audio_cutoff", performance.now() - detectedAt);
      if (session.currentAssistantTurn && turnId === session.currentAssistantTurn) {
        const heardText = session.currentAssistantText.slice(0, heardCharacters);
        session.sideband.truncateAssistant(session.currentAssistantTurn, heardText.length);
        await this.bus.appendTranscript(
          session.id,
          `${session.currentAssistantTurn}:assistant:interrupted`,
          {
            turnId: session.currentAssistantTurn,
            role: "assistant",
            text: heardText,
            finalized: true,
            interrupted: true,
            recordedAt: new Date(this.now()).toISOString()
          }
        );
        await this.emit(session, {
          protocolVersion: 1,
          type: "transcript.final",
          turnId: session.currentAssistantTurn,
          text: heardText,
          interrupted: true
        });
      }
    }
    if (session.canvas.snapshot.cards.length > 0) {
      session.eventRevision = await this.bus.nextEventRevision(session.id, session.eventRevision);
      const clearCards: SessionEvent = {
        protocolVersion: 1,
        type: "canvas.cards.replace",
        revision: session.eventRevision,
        purpose: "branch",
        prompt: "Choose a new direction.",
        cards: []
      };
      session.canvas.apply(clearCards);
      session.cardPurposes.clear();
      await this.persistState(session);
      await this.emit(session, clearCards);
    }
    if (session.canvas.snapshot.visual.spec) {
      if (session.visualCompletionTimer) {
        clearTimeout(session.visualCompletionTimer);
        session.visualCompletionTimer = undefined;
      }
      session.eventRevision = await this.bus.nextEventRevision(session.id, session.eventRevision);
      const stopVisual: SessionEvent = {
        protocolVersion: 1,
        type: "visual.stop",
        revision: session.eventRevision,
        reason: "interrupted"
      };
      session.canvas.apply(stopVisual);
      await this.persistState(session);
      await this.emit(session, stopVisual);
      await this.persistVisualOutcome(session, "interrupted");
    }
    session.currentAssistantTurn = undefined;
    session.currentAssistantText = "";
    this.metrics.recordInterruptionAcknowledgement("control", "ok");
    await this.setState(session, session.providerReady ? "listening" : "text_only");
  }

  private async executeTool(session: SessionRecord, callId: string, call: TutorToolCall): Promise<unknown> {
    const startedAt = performance.now();
    let outcome: "ok" | "error" = "ok";
    try {
      switch (call.name) {
        case "show_visual": {
          const previousVisual = session.activeVisual;
          if (previousVisual) {
            clearTimeout(previousVisual.authorizationTimer);
            previousVisual.resolveAuthorization({ accepted: false, reason: "superseded" });
            await this.persistVisualOutcome(session, "interrupted");
          }
          session.concepts.add(call.arguments.concept);
          this.recordExploration(session, call.arguments.concept, "visualized");
          session.eventRevision = await this.bus.nextEventRevision(session.id, session.eventRevision);
          const visualRevision = session.eventRevision;
          const visualOperationId = `visual_${createHash("sha256")
            .update(`${session.id}:${callId}`)
            .digest("base64url")
            .slice(0, 24)}`;
          let resolveAuthorization!: (result: unknown) => void;
          const authorization = new Promise<unknown>((resolve) => { resolveAuthorization = resolve; });
          const isActive = ["starting", "playing", "redirecting"].includes(session.canvas.snapshot.visual.status);
          const event: SessionEvent = isActive
            ? {
                protocolVersion: 1,
                type: "visual.redirect",
                revision: visualRevision,
                visualOperationId,
                spec: call.arguments
              }
            : {
                protocolVersion: 1,
                type: "visual.start",
                revision: visualRevision,
                visualOperationId,
                spec: call.arguments
              };
          clearTimeout(session.visualCompletionTimer);
          session.visualCompletionTimer = undefined;
          const activeVisual: NonNullable<SessionRecord["activeVisual"]> = {
            id: visualOperationId,
            concept: call.arguments.concept,
            durationSeconds: call.arguments.durationSeconds,
            resolution: "480p",
            promptVersion: visualRevision,
            authorizedAt: performance.now(),
            status: "pending",
            resolveAuthorization,
            authorizationTimer: setTimeout(() => {
              void this.handleVisualAcknowledgement(session, {
                protocolVersion: 1,
                type: "visual.failed",
                sessionId: session.id,
                visualOperationId,
                visualRevision,
                reason: "authorization_failed"
              });
            }, 15_000)
          };
          activeVisual.authorizationTimer.unref();
          session.activeVisual = activeVisual;
          session.canvas.apply(event);
          await this.persistState(session);
          await this.emit(session, event);
          return await authorization;
        }
        case "present_cards": {
          session.eventRevision = await this.bus.nextEventRevision(session.id, session.eventRevision);
          const cards = call.arguments.cards.map((card, index) => ({
            ...card,
            id: `card_${createHash("sha256")
              .update(`${session.id}:${callId}:${session.eventRevision}:${index}`)
              .digest("base64url")
              .slice(0, 24)}`
          }));
          const event: SessionEvent = {
            protocolVersion: 1,
            type: "canvas.cards.replace",
            revision: session.eventRevision,
            purpose: call.arguments.purpose,
            prompt: call.arguments.prompt,
            cards
          };
          session.canvas.apply(event);
          session.cardPurposes.clear();
          for (const card of cards) session.cardPurposes.set(card.id, call.arguments.purpose);
          await Promise.all(cards.map((card) => this.bus.writeCardInteraction(
            `card:shown:${session.id}:${callId}:${card.id}`,
            {
              sessionId: session.id,
              learnerId: session.learner.learnerId,
              cardId: card.id,
              purpose: call.arguments.purpose,
              action: "shown",
              occurredAt: new Date(this.now())
            }
          )));
          await this.persistState(session);
          await this.emit(session, event);
          return { accepted: true, revision: session.eventRevision };
        }
        case "stop_visual": {
          clearTimeout(session.visualCompletionTimer);
          session.visualCompletionTimer = undefined;
          session.eventRevision = await this.bus.nextEventRevision(session.id, session.eventRevision);
          const event: SessionEvent = { protocolVersion: 1, type: "visual.stop", revision: session.eventRevision, reason: call.arguments.reason };
          session.canvas.apply(event);
          await this.persistState(session);
          await this.emit(session, event);
          await this.persistVisualOutcome(
            session,
            call.arguments.reason === "complete" ? "completed" : "interrupted"
          );
          return { accepted: true, revision: session.eventRevision };
        }
        case "record_learning_evidence": {
          if (session.processedEvidence.has(callId)) return { accepted: true };
          const stored = await this.bus.writeDurableEvent(
            "learning_evidence",
            `tool:${session.id}:${callId}`,
            session.id,
            session.learner.learnerId,
            call.arguments
          );
          if (!stored) return { accepted: false };
          session.processedEvidence.add(callId);
          session.concepts.add(call.arguments.concept);
          this.recordExploration(session, call.arguments.concept, "evidence");
          const previous = session.mastery.get(call.arguments.concept) ?? { confidence: 0.5, evidenceCount: 0 };
          const aggregate = {
            confidence: Math.round(
              Math.min(1, Math.max(0, previous.confidence + call.arguments.confidenceDelta)) * 1_000
            ) / 1_000,
            evidenceCount: Math.min(Number.MAX_SAFE_INTEGER, previous.evidenceCount + 1)
          };
          session.mastery.set(call.arguments.concept, aggregate);
          await this.emit(session, {
            protocolVersion: 1,
            type: "learning.progress",
            concepts: [{
              concept: call.arguments.concept,
              mastery: aggregate.confidence,
              evidenceCount: aggregate.evidenceCount
            }]
          });
          return { accepted: true };
        }
      }
    } catch (error) {
      outcome = "error";
      throw error;
    } finally {
      this.metrics.observeLatency("tutor_tool", outcome, performance.now() - startedAt);
    }
  }

  private async completeVisualIfCurrent(session: SessionRecord, visualRevision: number): Promise<void> {
    const active = session.activeVisual;
    if (
      session.closing
      || !active
      || active.promptVersion !== visualRevision
      || active.status !== "ready"
    ) return;
    session.eventRevision = await this.bus.nextEventRevision(session.id, session.eventRevision);
    const event: SessionEvent = {
      protocolVersion: 1,
      type: "visual.stop",
      revision: session.eventRevision,
      reason: "complete"
    };
    session.canvas.apply(event);
    await this.persistState(session);
    await this.emit(session, event);
    session.visualCompletionTimer = undefined;
    await this.persistVisualOutcome(session, "completed");
  }

  private persistState(session: SessionRecord): Promise<void> {
    return this.bus.persistSessionState(session.id, {
      eventRevision: session.eventRevision,
      lastCommandRevision: session.lastCommandRevision,
      canvas: session.canvas.snapshot
    });
  }

  private rememberTurn(session: SessionRecord, turn: string): void {
    session.summaryTurns.push(turn.slice(0, 2_000));
    if (session.summaryTurns.length > MAX_SUMMARY_TURNS) session.summaryTurns.shift();
  }

  private closeSession(session: SessionRecord, _reason: "complete" | "abandoned" | "error"): Promise<void> {
    void _reason;
    if (session.closePromise) return session.closePromise;
    session.closing = true;
    session.providerReady = false;
    session.closePromise = this.performSessionClose(session);
    return session.closePromise;
  }

  private async performSessionClose(session: SessionRecord): Promise<void> {
    try {

      await session.sideband?.close();
      this.metrics.recordCleanup("provider", "ok");
    } catch {
      this.metrics.recordCleanup("provider", "error");
    }
    session.sideband = undefined;
    clearTimeout(session.visualCompletionTimer);
    session.visualCompletionTimer = undefined;
    await this.persistVisualOutcome(session, "interrupted");
    await this.setState(session, "ended").catch(() => undefined);
    for (const socket of session.sockets) socket.close(1000, "gateway session ended");
    const permits = [...session.socketPermits.values()];
    session.socketPermits.clear();
    session.sockets.clear();
    this.activeSockets = Math.max(0, this.activeSockets - permits.length);
    this.metrics.setActiveSockets(this.activeSockets);
    await Promise.all(permits.map((permit) => this.releasePermit(permit)));
    session.unsubscribe();
    if (this.sessions.get(session.id) === session) this.sessions.delete(session.id);
    const released = await this.bus.releaseSessionOwner(session.lease);
    this.metrics.recordOwnerFence("release", released ? "ok" : "conflict");
    this.logger.write("info", "Gateway session resources released", {
      event: "session_resources_released",
      sessionRef: session.sessionRef,
      provider: "gateway"
    });
    this.metrics.setActiveSessions(this.sessions.size);
    this.metrics.recordCleanup("session", "ok");
  }
  private async handleVisualAcknowledgement(
    session: SessionRecord,
    command: VisualClientCommand
  ): Promise<void> {
    const active = session.activeVisual;
    if (
      command.sessionId !== session.id
      || !active
      || active.id !== command.visualOperationId
      || active.promptVersion !== command.visualRevision
      || active.status === "failed"
    ) {
      this.metrics.recordVisual("readiness", "stale");
      this.metrics.recordStaleRevision("visual", "dropped");
      return;
    }
    if (command.type === "visual.authorized") {
      if (active.status !== "pending") {
        this.metrics.recordVisual("readiness", "stale");
        return;
      }
      clearTimeout(active.authorizationTimer);
      active.reservationId = command.reservationId;
      active.status = "authorized";
      active.resolveAuthorization({
        accepted: true,
        status: "authorized_pending",
        visualOperationId: active.id,
        reservationId: command.reservationId,
        revision: active.promptVersion,
        resolution: active.resolution
      });
      return;
    }
    if (command.type === "visual.failed") {
      clearTimeout(active.authorizationTimer);
      clearTimeout(session.visualCompletionTimer);
      session.visualCompletionTimer = undefined;
      active.status = "failed";
      const isStaticFallback = command.reason === "reduced_motion";
      active.resolveAuthorization(isStaticFallback
        ? { accepted: true, status: "static_fallback", visualOperationId: active.id, revision: active.promptVersion }
        : { accepted: false, reason: command.reason, visualOperationId: active.id, revision: active.promptVersion });
      this.metrics.recordVisual("readiness", isStaticFallback ? "fallback" : "error");
      session.eventRevision = await this.bus.nextEventRevision(session.id, session.eventRevision);
      const event: SessionEvent = {
        protocolVersion: 1,
        type: "visual.stop",
        revision: session.eventRevision,
        reason: isStaticFallback ? "complete" : "failed"
      };
      session.canvas.apply(event);
      await this.persistState(session);
      await this.emit(session, event);
      await this.persistVisualOutcome(session, isStaticFallback ? "completed" : "failed");
      return;
    }
    if (
      active.status !== "authorized"
      || (command.reservationId !== undefined && command.reservationId !== active.reservationId)
    ) {
      this.metrics.recordVisual("readiness", "stale");
      this.metrics.recordStaleRevision("visual", "dropped");
      return;
    }
    active.status = "ready";
    this.metrics.recordVisual("readiness", "ok");
    session.visualCompletionTimer = setTimeout(() => {
      void this.completeVisualIfCurrent(session, active.promptVersion);
    }, active.durationSeconds * 1_000);
    session.visualCompletionTimer.unref();
  }

  private async persistVisualOutcome(
    session: SessionRecord,
    outcome: "completed" | "interrupted" | "failed"
  ): Promise<void> {
    const visual = session.activeVisual;
    if (!visual) return;
    session.activeVisual = undefined;
    clearTimeout(visual.authorizationTimer);
    if (visual.status === "pending") visual.resolveAuthorization({ accepted: false, reason: outcome });
    await this.bus.writeVisualMetadata(`visual:${session.id}:${visual.id}:${outcome}`, {
      sessionId: session.id,
      learnerId: session.learner.learnerId,
      visualId: visual.reservationId ?? visual.id,
      concept: visual.concept,
      durationSeconds: visual.durationSeconds,
      resolution: visual.resolution,
      outcome,
      promptVersion: visual.promptVersion,
      latencyMs: Math.max(0, Math.round(performance.now() - visual.authorizedAt)),
      createdAt: new Date(this.now())
    });
  }

  private recordExploration(session: SessionRecord, node: string, relation: string): void {
    const normalized = node.trim().slice(0, 160);
    if (!normalized) return;
    if (session.lastExplorationNode && session.lastExplorationNode !== normalized) {
      session.explorationEdges.push({
        from: session.lastExplorationNode,
        to: normalized,
        relation: relation.slice(0, 80)
      });
      if (session.explorationEdges.length > 24) session.explorationEdges.shift();
    }
    session.lastExplorationNode = normalized;
  }

  private isCurrentProvider(session: SessionRecord, sideband: RealtimeSideband): boolean {
    return !session.closing && this.sessions.get(session.id) === session && session.sideband === sideband;
  }

  private async refreshSessionLease(session: SessionRecord): Promise<boolean> {
    if (session.closing) return false;
    try {
      const retained = await this.bus.refreshSessionOwner(session.lease, session.sidebandCallId);
      this.metrics.recordOwnerFence("refresh", retained ? "ok" : "conflict");
      if (!retained) await this.fenceLostSession(session);
      return retained;
    } catch {
      this.metrics.recordOwnerFence("refresh", "error");
      await this.fenceLostSession(session);
      return false;
    }
  }

  private async refreshSessionOwners(): Promise<void> {
    await Promise.allSettled([...this.sessions.values()].map((session) => this.refreshSessionLease(session)));
  }

  private async fenceLostSession(session: SessionRecord): Promise<void> {
    if (session.closing) return;
    const event = this.errorEvent(false, "session_lease_lost");
    for (const socket of session.sockets) this.send(socket, event);
    await this.closeSession(session, "error");
  }

  private async discardCreatedSession(session: SessionRecord): Promise<void> {
    session.closing = true;
    session.providerReady = false;
    clearTimeout(session.visualCompletionTimer);
    await session.sideband?.close().catch(() => undefined);
    session.unsubscribe();
    if (this.sessions.get(session.id) === session) this.sessions.delete(session.id);
    const released = await this.bus.releaseSessionOwner(session.lease);
    this.metrics.recordOwnerFence("release", released ? "ok" : "conflict");
    this.metrics.setActiveSessions(this.sessions.size);
  }

  private replayToSocket(session: SessionRecord, socket: WebSocket): void {
    const snapshot = session.canvas.snapshot;
    const hasCards = snapshot.cards.length > 0;
    const hasVisual = snapshot.visual.spec !== null && snapshot.visual.visualOperationId !== null;
    const stoppedVisual = hasVisual && (snapshot.visual.status === "held" || snapshot.visual.status === "idle");
    const replayCount = (hasCards ? 1 : 0) + (hasVisual ? 1 : 0) + (stoppedVisual ? 1 : 0);
    let revision = Math.max(1, snapshot.revision - replayCount + 1);
    if (snapshot.visual.spec) {
      this.send(socket, {
        protocolVersion: 1,
        type: snapshot.visual.status === "redirecting" ? "visual.redirect" : "visual.start",
        revision,
        visualOperationId: snapshot.visual.visualOperationId!,
        spec: snapshot.visual.spec
      });
      if (stoppedVisual) {
        revision += 1;
        this.send(socket, { protocolVersion: 1, type: "visual.stop", revision, reason: "complete" });
      }
      revision += 1;
    }
    if (hasCards) {
      this.send(socket, {
        protocolVersion: 1,
        type: "canvas.cards.replace",
        revision: Math.max(revision, snapshot.revision),
        purpose: "branch",
        prompt: snapshot.cardPrompt ?? "Continue",
        cards: [...snapshot.cards]
      });
    }
    if (session.currentAssistantTurn && session.currentAssistantText) {
      this.send(socket, {
        protocolVersion: 1,
        type: "transcript.delta",
        turnId: session.currentAssistantTurn,
        text: session.currentAssistantText
      });
    }
    this.send(socket, this.statusEvent(session.state));
  }

  private async withAttachLock<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.attachQueues.get(sessionId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.catch(() => undefined).then(() => current);
    this.attachQueues.set(sessionId, tail);
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (this.attachQueues.get(sessionId) === tail) this.attachQueues.delete(sessionId);
    }
  }

  private enqueueSessionTask<T>(session: SessionRecord, operation: () => Promise<T>): Promise<T> {
    const execution = session.commandQueue.then(operation);
    session.commandQueue = execution.then(() => undefined, () => undefined);
    return execution;
  }

  private async releasePermit(permit: SocketPermit): Promise<void> {
    try {
      await this.bus.releaseSocketPermit(permit);
      this.metrics.recordSocketPermit("release", "ok");
    } catch {
      this.metrics.recordSocketPermit("release", "error");
      this.logger.write("warn", "Socket permit release deferred to lease expiry", {
        event: "socket_permit_release_failed",
        provider: "redis",
        recoverable: true
      });
    }
  }

  private async refreshSocketPermits(): Promise<void> {
    for (const session of this.sessions.values()) {
      for (const [socket, permit] of session.socketPermits) {
        let retained = false;
        try {
          retained = await this.bus.refreshSocketPermit(permit);
          this.metrics.recordSocketPermit("renewal", retained ? "ok" : "error");
        } catch {
          retained = false;
          this.metrics.recordSocketPermit("renewal", "error");
        }
        if (retained || session.socketPermits.get(socket)?.id !== permit.id) continue;
        session.socketPermits.delete(socket);
        session.sockets.delete(socket);
        this.activeSockets = Math.max(0, this.activeSockets - 1);
        this.metrics.setActiveSockets(this.activeSockets);
        socket.close(1013, "socket admission lease lost");
        await this.releasePermit(permit);
      }
    }
  }

  private async cleanupIdle(): Promise<void> {
    const now = this.now();
    const expired = [...this.sessions.values()].filter((session) => now - session.lastActivity >= this.idleTtlMs);
    await Promise.allSettled(expired.map((session) => this.closeSession(session, "abandoned")));
  }

  private setState(session: SessionRecord, state: GatewayState, detail?: string): Promise<void> {
    session.state = state;
    return this.emit(session, this.statusEvent(state, detail));
  }

  private emit(session: SessionRecord, event: SessionEvent): Promise<void> {
    session.activeCommandEvents?.push(event);
    return this.bus.publish(session.id, session.learner.learnerId, event);
  }

  private statusEvent(state: GatewayState, detail?: string): SessionEvent {
    return { protocolVersion: 1, type: "session.status", state, ...(detail ? { detail } : {}) };
  }

  private errorEvent(recoverable: boolean, code: string): SessionEvent {
    return { protocolVersion: 1, type: "session.error", recoverable, code };
  }

  private send(socket: WebSocket, event: SessionEvent): void {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(event));
  }

  async close(): Promise<void> {
    this.shuttingDown = true;
    clearInterval(this.cleanupTimer);
    clearInterval(this.socketPermitRefreshTimer);
    clearInterval(this.sessionOwnerRefreshTimer);
    await Promise.allSettled([...this.sessions.values()].map((session) => this.closeSession(session, "abandoned")));
  }
}
