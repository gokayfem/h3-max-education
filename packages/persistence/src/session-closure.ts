import type { RedisSessionStore } from "./redis";
import type { LearningRepository, SessionSummaryInput } from "./types";

export class SessionClosureService {
  constructor(
    private readonly repository: LearningRepository,
    private readonly sessions: RedisSessionStore,
  ) {}

  async close(input: SessionSummaryInput): Promise<void> {
    await this.repository.saveCompactSessionSummary(input);
    await Promise.all([
      this.sessions.deleteTranscript(input.sessionId),
      this.sessions.deleteActiveState(input.sessionId),
      this.sessions.deleteFanout(input.sessionId),
    ]);
  }
}
