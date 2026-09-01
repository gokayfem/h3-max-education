import "server-only";

import {
  createPersistenceFromEnv,
  InMemoryLearningRepository,
  InMemoryRedis,
  RedisSessionStore,
  SessionClosureService,
  type ActiveSessionState,
  type LearningRepository,
} from "@axiom/persistence";
import { activeLessonStateSchema } from "./schemas";
import { SessionService } from "./service";

const DEVELOPMENT_TRANSCRIPT_KEY = Buffer.alloc(32, 19).toString("base64");
export interface PersistenceRuntimeServices {
  repository: LearningRepository;
  sessions: RedisSessionStore;
  closure: SessionClosureService;
}

const PERSISTENCE_RUNTIME_KEY = Symbol.for("axiom.persistence.runtime");
interface PersistenceRuntimeGlobal {
  [PERSISTENCE_RUNTIME_KEY]?: PersistenceRuntimeServices;
}


let persistenceServices: PersistenceRuntimeServices | undefined;
let service: SessionService | undefined;

function createDevelopmentPersistence(): PersistenceRuntimeServices {
  const repository = new InMemoryLearningRepository();
  const sessions = new RedisSessionStore(new InMemoryRedis(), {
    transcriptEncryptionKey: DEVELOPMENT_TRANSCRIPT_KEY,
  });
  return {
    repository,
    sessions,
    closure: new SessionClosureService(repository, sessions),
  };
}
export function getPersistenceServicesFromEnv(): PersistenceRuntimeServices {
  if (persistenceServices) return persistenceServices;
  const hasPersistenceEnvironment = Boolean(
    process.env.DATABASE_URL
    || process.env.UPSTASH_REDIS_REST_URL
    || process.env.UPSTASH_REDIS_REST_TOKEN,
  );
  if (!hasPersistenceEnvironment && process.env.NODE_ENV === "production") {
    throw new Error("Persistent session storage is required in production");
  }
  if (hasPersistenceEnvironment) {
    persistenceServices = createPersistenceFromEnv();
    return persistenceServices;
  }
  const runtimeGlobal = globalThis as typeof globalThis & PersistenceRuntimeGlobal;
  runtimeGlobal[PERSISTENCE_RUNTIME_KEY] ??= createDevelopmentPersistence();
  persistenceServices = runtimeGlobal[PERSISTENCE_RUNTIME_KEY];
  return persistenceServices;
}


export function createSessionServiceFromEnv(): SessionService {
  if (service) return service;
  const persistence = getPersistenceServicesFromEnv();
  service = new SessionService({
    sessions: {
      setActiveState(sessionId, state) {
        return persistence.sessions.setActiveState(sessionId, state as unknown as ActiveSessionState);
      },
      async getActiveState(sessionId) {
        const state = await persistence.sessions.getActiveState(sessionId);
        return state === null ? null : activeLessonStateSchema.parse(state);
      },
      getSessionRevision(sessionId) {
        return persistence.sessions.getSessionRevision(sessionId);
      },
      deleteActiveState(sessionId) {
        return persistence.sessions.deleteActiveState(sessionId);
      },
      appendTranscriptOnce(sessionId, operationId, entry) {
        return persistence.sessions.appendTranscriptOnce(sessionId, operationId, entry);
      },
      appendTranscriptsOnce(sessionId, entries) {
        return persistence.sessions.appendTranscriptsOnce(sessionId, entries);
      },
      readTranscript(sessionId) {
        return persistence.sessions.readTranscript(sessionId);
      },
      deleteTranscript(sessionId) {
        return persistence.sessions.deleteTranscript(sessionId);
      },
      claimIdempotencyKey(scope, idempotencyKey) {
        return persistence.sessions.claimIdempotencyKey(scope, idempotencyKey);
      },
      readCommittedMutation(scope, idempotencyKey) {
        return persistence.sessions.readCommittedMutation(scope, idempotencyKey);
      },
      createSessionIfAbsent(sessionId, mutationId, initialState, response) {
        return persistence.sessions.createSessionIfAbsent(
          sessionId,
          mutationId,
          initialState as unknown as ActiveSessionState,
          response,
        );
      },
      reserveMutationAttempt(sessionId, expectedRevision, mutationId) {
        return persistence.sessions.reserveMutationAttempt(sessionId, expectedRevision, mutationId);
      },
      releaseMutationAttempt(sessionId, mutationId, attemptToken) {
        return persistence.sessions.releaseMutationAttempt(sessionId, mutationId, attemptToken);
      },
      commitMutation(input) {
        return persistence.sessions.commitMutation({
          ...input,
          state: input.state as unknown as ActiveSessionState,
        });
      },
      commitTerminalMutation(input) {
        return persistence.sessions.commitTerminalMutation({
          ...input,
          state: input.state as unknown as ActiveSessionState,
        });
      },
      isMutationEffectComplete(scope, idempotencyKey, effectId) {
        return persistence.sessions.isMutationEffectComplete(scope, idempotencyKey, effectId);
      },
      markMutationEffectComplete(scope, idempotencyKey, effectId) {
        return persistence.sessions.markMutationEffectComplete(scope, idempotencyKey, effectId);
      },
      consumeRateLimit(subject, policy) {
        return persistence.sessions.consumeRateLimit(subject, policy);
      },
      publishOnce(sessionId, operationId, event) {
        return persistence.sessions.publishOnce(sessionId, operationId, event);
      },
      publishManyOnce(sessionId, entries) {
        return persistence.sessions.publishManyOnce(sessionId, entries);
      },
      readFanout(sessionId, cursor, limit) {
        return persistence.sessions.readFanout(sessionId, cursor, limit);
      },
      acquireEventStreamLease(sessionId, leaseId, ttlSeconds) {
        return persistence.sessions.acquireEventStreamLease(sessionId, leaseId, ttlSeconds);
      },
      releaseEventStreamLease(sessionId, leaseId) {
        return persistence.sessions.releaseEventStreamLease(sessionId, leaseId);
      },
      releaseRealtimeSession(sessionId) {
        return persistence.sessions.releaseRealtimeSession(sessionId);
      },
    },
    memory: {
      loadLearnerProfile(learnerId) {
        return persistence.repository.load(learnerId);
      },
      recordEvidence(learnerId, evidence, operationId) {
        return persistence.repository.recordEvidence(learnerId, evidence, operationId);
      },
      recordCardInteraction(input, operationId) {
        return persistence.repository.recordCardInteraction(input, operationId);
      },
    },
    closure: {
      close(input) {
        return persistence.closure.close(input);
      },
    },
  });
  return service;
}
