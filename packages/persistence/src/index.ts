import {
  createPostgresLearningRepository,
  createRedisSessionStore,
  parsePersistenceEnvironment,
  type PersistenceEnvironment,
} from "./clients";
import type { PostgresLearningRepository } from "./postgres";
import type { RedisSessionStore } from "./redis";
import { SessionClosureService } from "./session-closure";

export * from "./types";
export * from "./postgres";
export * from "./redis";
export * from "./memory";
export * from "./clients";
export * from "./session-closure";

export interface PersistenceServices {
  repository: PostgresLearningRepository;
  sessions: RedisSessionStore;
  closure: SessionClosureService;
}

export function createPersistenceFromEnv(environment: NodeJS.ProcessEnv = process.env): PersistenceServices {
  const parsed: PersistenceEnvironment = parsePersistenceEnvironment(environment);
  const repository = createPostgresLearningRepository(parsed.DATABASE_URL);
  const sessions = createRedisSessionStore(parsed);
  return { repository, sessions, closure: new SessionClosureService(repository, sessions) };
}
