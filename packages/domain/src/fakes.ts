import type { CardSelection, TutorCloseReason, TutorOpenContext, TutorTransport } from "./tutor-session";

export class FakeTutorTransport implements TutorTransport {
  readonly calls: string[] = [];
  reconnectResults: boolean[] = [true];
  mode: "voice" | "text" = "voice";
  openError: Error | undefined;
  sendError: Error | undefined;
  cardError: Error | undefined;

  async open(context: TutorOpenContext): Promise<void> {
    this.calls.push(`open:${context.sessionId}`);
    if (this.openError) throw this.openError;
  }
  async muteOutput(): Promise<void> { this.calls.push("muteOutput"); }
  async cancelResponse(): Promise<void> { this.calls.push("cancelResponse"); }
  async clearOutputAudio(): Promise<void> { this.calls.push("clearOutputAudio"); }
  async truncateAssistant(turnId: string, heardCharacters: number): Promise<void> { this.calls.push(`truncateAssistant:${turnId}:${heardCharacters}`); }
  async sendText(text: string): Promise<void> {
    this.calls.push(`sendText:${text}`);
    if (this.sendError) throw this.sendError;
  }
  async selectCard(selection: CardSelection): Promise<void> {
    this.calls.push(`selectCard:${selection.id}:${selection.title}:${selection.revision}`);
    if (this.cardError) throw this.cardError;
  }
  async reconnect(): Promise<boolean> { this.calls.push("reconnect"); return this.reconnectResults.shift() ?? false; }
  async resumeOutput(): Promise<void> { this.calls.push("resumeOutput"); }
  async close(reason: TutorCloseReason): Promise<void> { this.calls.push(`close:${reason}`); }
}
