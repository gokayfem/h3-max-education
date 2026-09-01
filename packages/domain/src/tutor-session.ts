import type { SessionEvent, SessionState } from "@axiom/protocol";

export interface TutorOpenContext { sessionId: string; learnerId: string }
export interface TutorInterruption { turnId: string; heardCharacters: number }
export interface CardSelection { id: string; title: string; revision: number }
export type TutorCloseReason = "complete" | "abandoned" | "error";

export interface TutorTransport {
  readonly mode: "voice" | "text";
  open(context: TutorOpenContext): Promise<void>;
  muteOutput(): Promise<void>;
  cancelResponse(): Promise<void>;
  clearOutputAudio(): Promise<void>;
  truncateAssistant(turnId: string, heardCharacters: number): Promise<void>;
  sendText(text: string): Promise<void>;
  selectCard(selection: CardSelection): Promise<void>;
  reconnect(): Promise<boolean>;
  resumeOutput(): Promise<void>;
  close(reason: TutorCloseReason): Promise<void>;
}

export interface TutorSession {
  readonly state: SessionState;
  open(context: TutorOpenContext): Promise<void>;
  interrupt(interruption: TutorInterruption): Promise<void>;
  responseStarted(turnId: string): Promise<void>;
  resume(): Promise<void>;
  sendText(text: string): Promise<void>;
  selectCard(selection: CardSelection): Promise<void>;
  close(reason: TutorCloseReason): Promise<void>;
}

export class RealtimeTutorSession implements TutorSession {
  private currentState: SessionState = "ended";
  private readonly transcripts = new Map<string, string>();
  private reconnectAttempted = false;
  private interruptionTail: Promise<void> = Promise.resolve();
  private outputMuted = false;

  constructor(private readonly transport: TutorTransport, private readonly emit: (event: SessionEvent) => void) {}

  get state(): SessionState { return this.currentState; }

  async open(context: TutorOpenContext): Promise<void> {
    if (this.currentState !== "ended") throw new Error("Tutor session is already open");
    this.setState("connecting");
    try {
      await this.transport.open(context);
      this.reconnectAttempted = false;
      this.setState(this.transport.mode === "text" ? "text_only" : "listening");
    } catch (error) {
      this.emit({ protocolVersion: 1, type: "session.error", recoverable: true, code: "open_failed" });
      this.setState("ended");
      throw error;
    }
  }

  async responseStarted(turnId: string): Promise<void> {
    if (!turnId) throw new Error("turnId is required");
    await this.interruptionTail;
    this.assertActive();
    if (!this.outputMuted) return;
    await this.transport.resumeOutput();
    this.outputMuted = false;
    this.setState(this.transport.mode === "text" ? "text_only" : "listening");
  }

  appendAssistantTranscript(turnId: string, text: string): void {
    if (!turnId) throw new Error("turnId is required");
    this.transcripts.set(turnId, (this.transcripts.get(turnId) ?? "") + text);
  }

  interrupt(interruption: TutorInterruption): Promise<void> {
    const operation = this.interruptionTail.then(() => this.performInterruption(interruption));
    this.interruptionTail = operation.catch(() => undefined);
    return operation;
  }

  async resume(): Promise<void> {
    await this.interruptionTail;
    this.assertActive();
    await this.transport.resumeOutput();
    this.outputMuted = false;
    this.setState(this.transport.mode === "text" ? "text_only" : "listening");
  }

  async sendText(text: string): Promise<void> {
    this.assertActive();
    const trimmed = text.trim();
    if (!trimmed) throw new Error("Learner text must not be empty");
    const previousState = this.currentState;
    this.setState("thinking");
    try {
      await this.transport.sendText(trimmed);
    } catch (error) {
      this.setState(previousState);
      throw error;
    }
  }
  async selectCard(selection: CardSelection): Promise<void> {
    this.assertActive();
    if (!selection.id || !selection.title || !Number.isInteger(selection.revision) || selection.revision < 1) throw new Error("Invalid card selection");
    const previousState = this.currentState;
    this.setState("thinking");
    try {
      await this.transport.selectCard(selection);
    } catch (error) {
      this.setState(previousState);
      throw error;
    }
  }

  async handleConnectionFailure(): Promise<void> {
    if (this.currentState === "ended" || this.currentState === "text_only") return;
    if (this.reconnectAttempted) {
      this.setState("text_only", "Voice unavailable; continue by typing.");
      return;
    }
    this.reconnectAttempted = true;
    this.setState("reconnecting");
    try {
      if (await this.transport.reconnect()) {
        this.setState("listening");
        return;
      }
    } catch {
      // A single failed reconnect follows the same deterministic text fallback.
    }
    this.emit({ protocolVersion: 1, type: "session.error", recoverable: true, code: "realtime_unavailable" });
    this.setState("text_only", "Voice unavailable; continue by typing.");
  }

  async close(reason: TutorCloseReason): Promise<void> {
    if (this.currentState === "ended") return;
    await this.interruptionTail;
    await this.transport.close(reason);
    this.transcripts.clear();
    this.outputMuted = false;
    this.setState("ended");
  }

  private async performInterruption({ turnId, heardCharacters }: TutorInterruption): Promise<void> {
    this.assertActive();
    if (!Number.isInteger(heardCharacters) || heardCharacters < 0) throw new Error("heardCharacters must be a non-negative integer");
    this.setState("redirecting", "Changing direction…");
    await this.transport.muteOutput();
    this.outputMuted = true;
    await this.transport.cancelResponse();
    await this.transport.clearOutputAudio();
    await this.transport.truncateAssistant(turnId, heardCharacters);
    const transcript = this.transcripts.get(turnId) ?? "";
    this.transcripts.delete(turnId);
    this.emit({ protocolVersion: 1, type: "transcript.final", turnId, text: transcript.slice(0, heardCharacters), interrupted: true });
    this.setState("listening");
  }

  private assertActive(): void {
    if (this.currentState === "ended" || this.currentState === "connecting") throw new Error("Tutor session is not active");
  }

  private setState(state: SessionState, detail?: string): void {
    this.currentState = state;
    this.emit({ protocolVersion: 1, type: "session.status", state, ...(detail ? { detail } : {}) });
  }
}
