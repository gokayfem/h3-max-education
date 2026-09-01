import type {
  ConceptMastery,
  LearnerPreferences,
  LearningEvidence,
  Misconception,
  SessionSummary,
} from "@axiom/domain";
import type { RedisCommands } from "./redis";
import { assertOperationalMetricSafe, LEARNING_CONTEXT_LIMITS } from "./types";
import type {
  CardInteractionInput,
  ExplorationEdgeInput,
  HydratedLearningContext,
  LearningRepository,
  OperationalMetricInput,
  PreferenceInput,
  ProfileInput,
  SessionSummaryInput,
  StoredProfile,
  VisualMetadataInput,
} from "./types";

type StoredRedisValue = { value: string | string[]; expiresAt?: number };

export class InMemoryRedis implements RedisCommands {
  private readonly values = new Map<string, StoredRedisValue>();
  private readonly visualActive = new Map<string, Map<string, number>>();
  readonly published: Array<{ channel: string; message: string }> = [];

  async get(key: string): Promise<unknown> {
    return this.live(key)?.value ?? null;
  }

  async set(key: string, value: string, options?: { ex?: number; nx?: boolean }): Promise<unknown> {
    if (options?.nx && this.live(key)) return null;
    this.values.set(key, { value, expiresAt: options?.ex ? Date.now() + options.ex * 1_000 : undefined });
    return "OK";
  }

  async del(...keys: string[]): Promise<number> {
    return keys.reduce((count, key) => count + (this.values.delete(key) ? 1 : 0), 0);
  }

  async expire(key: string, seconds: number): Promise<number> {
    const item = this.live(key);
    if (!item) return 0;
    item.expiresAt = Date.now() + seconds * 1_000;
    return 1;
  }

  async ttl(key: string): Promise<number> {
    const item = this.live(key);
    if (!item) return -2;
    if (!item.expiresAt) return -1;
    return Math.max(0, Math.ceil((item.expiresAt - Date.now()) / 1_000));
  }

  async rpush(key: string, ...values: string[]): Promise<number> {
    const current = this.live(key);
    const list = current?.value;
    if (list !== undefined && !Array.isArray(list)) throw new Error("WRONGTYPE");
    const next = list ?? [];
    next.push(...values);
    this.values.set(key, { value: next, expiresAt: current?.expiresAt });
    return next.length;
  }

  async lrange(key: string, start: number, stop: number): Promise<unknown[]> {
    const value = this.live(key)?.value;
    if (value === undefined) return [];
    if (!Array.isArray(value)) throw new Error("WRONGTYPE");
    const end = stop < 0 ? value.length + stop + 1 : stop + 1;
    return value.slice(start, end);
  }

  async publish(channel: string, message: string): Promise<number> {
    this.published.push({ channel, message });
    return 0;
  }

  async eval(script: string, keys: string[], args: Array<string | number>): Promise<unknown> {
    const key = keys[0];
    if (!key) throw new Error("Redis script requires a key");
    if (script.includes("axiom-anonymous-admission-release")) {
      const globalKey = key;
      const networkKey = keys[1];
      const learnerNetworkKey = keys[2];
      if (!networkKey || !learnerNetworkKey) throw new Error("Anonymous admission release keys are required");
      const marker = this.live(learnerNetworkKey)?.value;
      if (typeof marker !== "string" || marker !== String(args[0])) return 0;
      const global = this.live(globalKey);
      const network = this.live(networkKey);
      const globalCount = typeof global?.value === "string" ? Number(global.value) : 0;
      const networkCount = typeof network?.value === "string" ? Number(network.value) : 0;
      if (globalCount > 0) this.values.set(globalKey, { value: String(globalCount - 1), expiresAt: global?.expiresAt });
      if (networkCount > 0) this.values.set(networkKey, { value: String(networkCount - 1), expiresAt: network?.expiresAt });
      this.values.delete(learnerNetworkKey);
      return 1;
    }
    if (script.includes("axiom-event-stream-lease-acquire")) {
      const owner = this.live(key)?.value;
      if (owner !== undefined && owner !== String(args[0])) return 0;
      this.values.set(key, {
        value: String(args[0]),
        expiresAt: Date.now() + Number(args[1]) * 1_000,
      });
      return 1;
    }
    if (script.includes("axiom-event-stream-lease-release")) {
      if (this.live(key)?.value !== String(args[0])) return 0;
      this.values.delete(key);
      return 1;
    }
    if (script.includes("axiom-anonymous-admission")) {
      const globalKey = key;
      const networkKey = keys[1];
      const learnerNetworkKey = keys[2];
      if (!networkKey || !learnerNetworkKey) throw new Error("Anonymous admission keys are required");
      const globalValue = this.live(globalKey)?.value;
      const networkValue = this.live(networkKey)?.value;
      const globalCount = typeof globalValue === "string" ? Number(globalValue) : 0;
      const networkCount = typeof networkValue === "string" ? Number(networkValue) : 0;
      if (globalCount >= Number(args[0])) return [-1, await this.ttl(globalKey)];
      if (networkCount >= Number(args[1])) return [-2, await this.ttl(networkKey)];
      const windowMs = Number(args[2]) * 1_000;
      const globalExpiresAt = this.live(globalKey)?.expiresAt ?? Date.now() + windowMs;
      const networkExpiresAt = this.live(networkKey)?.expiresAt ?? Date.now() + windowMs;
      this.values.set(globalKey, { value: String(globalCount + 1), expiresAt: globalExpiresAt });
      this.values.set(networkKey, { value: String(networkCount + 1), expiresAt: networkExpiresAt });
      this.values.set(learnerNetworkKey, {
        value: String(args[3]),
        expiresAt: Date.now() + Number(args[4]) * 1_000,
      });
      return [1, Number(args[2])];
    }
    if (script.includes("axiom-visual-entitlement-reserve")) {
      const dailyKey = keys[2]!;
      const dailyValue = this.live(dailyKey)?.value;
      const used = typeof dailyValue === "string" ? Number(dailyValue) : 0;
      const remaining = Math.max(0, Number(args[4]) - used);
      if (this.live(keys[4]!)) return [-1, "", 0, remaining];
      const existing = this.live(key);
      if (existing) {
        if (typeof existing.value !== "string") throw new Error("WRONGTYPE");
        const lease = JSON.parse(existing.value) as {
          learner: string;
          duration: number;
          id: string;
          state: "pending" | "active" | "negotiating" | "connected";
        };
        const ttl = await this.ttl(key);
        if (lease.learner !== String(args[0]) || lease.duration !== Number(args[1])) {
          return [-1, "", ttl, remaining];
        }
        return lease.state === "active"
          ? [2, lease.id, ttl, remaining]
          : [3, lease.id, ttl, remaining];
      }
      const activeKey = keys[1]!;
      const nowSeconds = Number(args[2]);
      const active = this.visualActive.get(activeKey) ?? new Map<string, number>();
      for (const [member, expiry] of active) {
        if (expiry <= nowSeconds) active.delete(member);
      }
      this.visualActive.set(activeKey, active);
      if (active.size >= Number(args[3])) return [-2, "", 0, remaining];
      const globalDailyKey = keys[3]!;
      const globalDailyValue = this.live(globalDailyKey)?.value;
      const globalUsed = typeof globalDailyValue === "string" ? Number(globalDailyValue) : 0;
      const duration = Number(args[1]);
      const charge = Number(args[11]);
      if (used + charge > Number(args[4])) return [-3, "", 0, remaining];
      if (globalUsed + charge > Number(args[9])) return [-4, "", 0, remaining];
      const dailyExisting = this.live(dailyKey);
      const expiresAt = dailyExisting?.expiresAt ?? Date.now() + Number(args[5]) * 1_000;
      this.values.set(dailyKey, { value: String(used + charge), expiresAt });
      this.values.set(globalDailyKey, {
        value: String(globalUsed + charge),
        expiresAt: this.live(globalDailyKey)?.expiresAt ?? expiresAt,
      });
      const leaseSeconds = Number(args[7]);
      const reservationId = String(args[6]);
      this.values.set(key, {
        value: JSON.stringify({
          learner: String(args[0]),
          duration,
          charge,
          id: reservationId,
          state: "active",
          chargeDay: String(args[10]),
        }),
        expiresAt: Date.now() + leaseSeconds * 1_000,
      });
      active.set(String(args[8]), nowSeconds + leaseSeconds);
      return [2, reservationId, leaseSeconds, Math.max(0, Number(args[4]) - used - charge)];
    }
    if (script.includes("axiom-visual-entitlement-commit")) {
      const existing = this.live(key);
      if (!existing || typeof existing.value !== "string") return 0;
      const lease = JSON.parse(existing.value) as {
        id: string;
        state: "pending" | "active";
        [key: string]: unknown;
      };
      if (lease.id !== String(args[0])) return 0;
      if (this.live(keys[1]!)) return 0;
      if (lease.state !== "active") return 0;
      return this.ttl(key);
    }
    if (script.includes("axiom-visual-ice-permit") || script.includes("axiom-visual-ice-fallback")) {
      const existing = this.live(key);
      if (!existing || typeof existing.value !== "string") return 0;
      const lease = JSON.parse(existing.value) as {
        learner: string;
        id: string;
        duration: number;
        state: string;
        icePhase?: string;
      };
      if (
        lease.learner !== String(args[0])
        || lease.id !== String(args[1])
        || lease.duration !== Number(args[2])
        || lease.state !== "active"
      ) {
        return 0;
      }
      let icePhase: string;
      if (script.includes("ice-fallback")) {
        if (lease.icePhase !== "primary") return 0;
        icePhase = "fallback_allowed";
      } else if (String(args[3]) === "fallback") {
        if (lease.icePhase !== "fallback_allowed") return 0;
        icePhase = "fallback_used";
      } else {
        if (lease.icePhase) return 0;
        icePhase = "primary";
      }
      this.values.set(key, {
        value: JSON.stringify({ ...lease, icePhase }),
        expiresAt: existing.expiresAt,
      });
      return 1;
    }
    if (
      script.includes("axiom-visual-entitlement-verify")
      || script.includes("axiom-visual-entitlement-claim")
      || script.includes("axiom-visual-entitlement-bind-provider")
    ) {
      const existing = this.live(key);
      if (!existing || typeof existing.value !== "string") return 0;
      const lease = JSON.parse(existing.value) as {
        learner: string;
        id: string;
        duration: number;
        state: "active" | "negotiating" | "connected";
        providerSession?: string;
        icePhase?: string;
        deadlineMs?: number;
        heartbeatInFlight?: boolean;
        lastHeartbeatMs?: number;
      };
      if (
        lease.learner !== String(args[0])
        || lease.id !== String(args[1])
        || lease.duration !== Number(args[2])
      ) {
        return 0;
      }
      if (script.includes("verify-provider")) {
        return lease.state === "connected" && lease.providerSession === String(args[3]) ? 1 : 0;
      }
      if (script.includes("claim")) {
        if (lease.state !== "active" || !lease.icePhase) return 0;
        this.values.set(key, {
          value: JSON.stringify({ ...lease, state: "negotiating" }),
          expiresAt: existing.expiresAt,
        });
        return 1;
      }
      if (script.includes("bind-provider")) {
        if (lease.state !== "negotiating") return 0;
        this.values.set(key, {
          value: JSON.stringify({
            ...lease,
            state: "connected",
            providerSession: String(args[3]),
            deadlineMs: Number(args[4]),
          }),
          expiresAt: existing.expiresAt,
        });
        return 1;
      }
      return lease.state === "active" ? 1 : 0;
    }
    if (script.includes("axiom-visual-heartbeat-claim") || script.includes("axiom-visual-heartbeat-complete")) {
      const existing = this.live(key);
      if (!existing || typeof existing.value !== "string") return 0;
      const lease = JSON.parse(existing.value) as {
        learner: string;
        id: string;
        duration: number;
        state: string;
        providerSession?: string;
        deadlineMs?: number;
        heartbeatInFlight?: boolean;
        lastHeartbeatMs?: number;
      };
      if (
        lease.learner !== String(args[0])
        || lease.id !== String(args[1])
        || lease.providerSession !== String(script.includes("complete") ? args[2] : args[3])
      ) {
        return 0;
      }
      if (script.includes("complete")) {
        this.values.set(key, {
          value: JSON.stringify({
            ...lease,
            heartbeatInFlight: false,
            lastHeartbeatMs: Number(args[3]),
          }),
          expiresAt: existing.expiresAt,
        });
        return 1;
      }
      const nowMs = Number(args[4]);
      if (
        lease.state !== "connected"
        || nowMs >= Number(lease.deadlineMs)
        || lease.heartbeatInFlight
        || (lease.lastHeartbeatMs !== undefined && nowMs - lease.lastHeartbeatMs < Number(args[5]))
      ) {
        return 0;
      }
      this.values.set(key, {
        value: JSON.stringify({ ...lease, heartbeatInFlight: true }),
        expiresAt: existing.expiresAt,
      });
      return 1;
    }
    if (script.includes("axiom-visual-entitlement-release")) {
      const existing = this.live(key);
      const currentDailyKey = keys[2]!;
      if (!existing || typeof existing.value !== "string") {
        const current = this.live(currentDailyKey);
        const currentUsed = typeof current?.value === "string" ? Number(current.value) : 0;
        return [0, Math.max(0, Number(args[4]) - currentUsed)];
      }
      const lease = JSON.parse(existing.value) as {
        learner: string;
        id: string;
        duration: number;
        chargeDay: string;
        charge: number;
      };
      if (lease.learner !== String(args[0]) || lease.id !== String(args[1])) {
        const current = this.live(currentDailyKey);
        const currentUsed = typeof current?.value === "string" ? Number(current.value) : 0;
        return [0, Math.max(0, Number(args[4]) - currentUsed)];
      }
      this.values.delete(key);
      const activeKey = keys[1]!;
      const active = this.visualActive.get(activeKey);
      active?.delete(String(args[2]));
      if (active?.size === 0) this.visualActive.delete(activeKey);
      const chargeIsCurrent = lease.chargeDay === String(args[5]);
      const dailyKey = chargeIsCurrent ? keys[2]! : keys[4]!;
      const globalDailyKey = chargeIsCurrent ? keys[3]! : keys[5]!;
      if (String(args[3]) === "1") {
        const daily = this.live(dailyKey);
        const used = typeof daily?.value === "string" ? Number(daily.value) : 0;
        if (daily && used > lease.charge) daily.value = String(used - lease.charge);
        else this.values.delete(dailyKey);
        const globalDaily = this.live(globalDailyKey);
        const globalUsed = typeof globalDaily?.value === "string" ? Number(globalDaily.value) : 0;
        if (globalDaily && globalUsed > lease.charge) globalDaily.value = String(globalUsed - lease.charge);
        else this.values.delete(globalDailyKey);
      }
      const current = this.live(currentDailyKey);
      const currentUsed = typeof current?.value === "string" ? Number(current.value) : 0;
      return [1, Math.max(0, Number(args[4]) - currentUsed)];
    }
    if (script.includes("axiom-visual-daily-allowance")) {
      const current = this.live(key);
      const used = typeof current?.value === "string" ? Number(current.value) : 0;
      return Math.max(0, Number(args[0]) - used);
    }
    if (script.includes("axiom-realtime-admission-replace")) {
      const [leaseKey, terminalKey, attemptKey, mappingKey] = keys;
      if (!leaseKey || !terminalKey || !attemptKey || !mappingKey) throw new Error("Realtime replacement keys are required");
      if (this.live(terminalKey)) return [-5, await this.ttl(terminalKey), ""];
      const priorAttempt = this.live(attemptKey)?.value;
      if (typeof priorAttempt === "string") {
        const prior = JSON.parse(priorAttempt) as { session: string; attempt: string; leaseKey: string; leaseId: string };
        if (prior.session === String(args[2]) && prior.attempt === String(args[3]) && prior.leaseKey === leaseKey && this.live(leaseKey)?.value === prior.leaseId) {
          return [2, await this.ttl(leaseKey), prior.leaseId];
        }
        return [-4, await this.ttl(attemptKey), ""];
      }
      const mapping = this.live(mappingKey)?.value;
      if (typeof mapping !== "string") return [-4, 0, ""];
      const parsed = JSON.parse(mapping) as { leaseKey: string; leaseId: string };
      if (parsed.leaseKey !== leaseKey || this.live(leaseKey)?.value !== parsed.leaseId) {
        return [-4, await this.ttl(leaseKey), ""];
      }
      const leaseId = String(args[0]);
      const expiresAt = Date.now() + Number(args[1]) * 1_000;
      this.values.delete(mappingKey);
      this.values.set(leaseKey, { value: leaseId, expiresAt });
      this.values.set(attemptKey, {
        value: JSON.stringify({ session: String(args[2]), attempt: String(args[3]), leaseKey, leaseId }),
        expiresAt,
      });
      return [1, Number(args[1]), leaseId];
    }
    if (script.includes("axiom-realtime-admission-reserve")) {
      const [globalKey, minuteKey, dailyKey, leaseKey, terminalKey, attemptKey] = keys;
      if (!globalKey || !minuteKey || !dailyKey || !leaseKey || !terminalKey || !attemptKey) throw new Error("Realtime admission keys are required");
      if (this.live(terminalKey)) return [-5, await this.ttl(terminalKey), ""];
      const priorAttempt = this.live(attemptKey)?.value;
      if (typeof priorAttempt === "string") {
        const prior = JSON.parse(priorAttempt) as { session: string; attempt: string; leaseKey: string; leaseId: string };
        if (prior.session === String(args[7]) && prior.attempt === String(args[8]) && prior.leaseKey === leaseKey && this.live(leaseKey)?.value === prior.leaseId) {
          return [2, await this.ttl(leaseKey), prior.leaseId];
        }
        return [-4, await this.ttl(attemptKey), ""];
      }
      const counterKeys = [globalKey, minuteKey, dailyKey];
      const limits = [Number(args[0]), Number(args[1]), Number(args[2])];
      for (let index = 0; index < counterKeys.length; index += 1) {
        const current = this.live(counterKeys[index]!)?.value;
        const count = typeof current === "string" ? Number(current) : 0;
        if (count >= limits[index]!) return [-(index + 1), await this.ttl(counterKeys[index]!), ""];
      }
      if (this.live(leaseKey)) return [-4, await this.ttl(leaseKey), ""];
      for (let index = 0; index < counterKeys.length; index += 1) {
        const counterKey = counterKeys[index]!;
        const current = this.live(counterKey);
        const count = typeof current?.value === "string" ? Number(current.value) : 0;
        const ttlSeconds = index === 1 ? Number(args[4]) : Number(args[3]);
        this.values.set(counterKey, { value: String(count + 1), expiresAt: current?.expiresAt ?? Date.now() + ttlSeconds * 1_000 });
      }
      const leaseId = String(args[5]);
      const leaseExpiresAt = Date.now() + Number(args[6]) * 1_000;
      this.values.set(leaseKey, { value: leaseId, expiresAt: leaseExpiresAt });
      this.values.set(attemptKey, {
        value: JSON.stringify({ session: String(args[7]), attempt: String(args[8]), leaseKey, leaseId }),
        expiresAt: leaseExpiresAt,
      });
      return [1, Number(args[6]), leaseId];
    }
    if (script.includes("axiom-realtime-admission-activate")) {
      const lease = this.live(key);
      const sessionKey = keys[1];
      const terminalKey = keys[2];
      if (!lease || lease.value !== String(args[0]) || !sessionKey || !terminalKey || !lease.expiresAt) return 0;
      if (this.live(terminalKey)) {
        this.values.delete(key);
        return 0;
      }
      const ttl = await this.ttl(key);
      this.values.set(sessionKey, { value: String(args[1]), expiresAt: Date.now() + ttl * 1_000 });
      return ttl;
    }
    if (script.includes("axiom-realtime-call-verify")) {
      const mapping = this.live(key);
      const leaseKey = keys[1];
      if (!mapping || typeof mapping.value !== "string" || !leaseKey) return 0;
      const parsed = JSON.parse(mapping.value) as { leaseKey: string; leaseId: string; callId: string };
      return parsed.leaseKey === leaseKey
        && parsed.callId === String(args[0])
        && this.live(leaseKey)?.value === parsed.leaseId
        ? 1
        : 0;
    }
    if (script.includes("axiom-active-realtime-call-read")) {
      const mapping = this.live(key);
      const leaseKey = keys[1];
      const revisionKey = keys[2];
      const terminalKey = keys[3];
      if (terminalKey && this.live(terminalKey)) return [0, 0];
      if (!mapping || typeof mapping.value !== "string" || !leaseKey || !revisionKey) return [0, 0];
      const parsed = JSON.parse(mapping.value) as { leaseKey: string; leaseId: string; callId: string };
      if (
        parsed.leaseKey !== leaseKey
        || parsed.callId !== String(args[0])
        || this.live(leaseKey)?.value !== parsed.leaseId
      ) {
        return [0, 0];
      }
      const revision = this.live(revisionKey)?.value;
      return [1, typeof revision === "string" ? Number(revision) : 0];
    }
    if (script.includes("axiom-gateway-ticket-claim")) {
      const leaseKey = keys[1];
      const nonceKey = keys[2];
      const terminalKey = keys[3];
      if (!leaseKey || !nonceKey || !terminalKey || Number(args[2]) <= Number(args[1])) return 0;
      if (this.live(terminalKey) || this.live(nonceKey)) return 0;
      const mapping = this.live(key);
      if (!mapping || typeof mapping.value !== "string") return 0;
      const parsed = JSON.parse(mapping.value) as { leaseKey: string; leaseId: string; callId: string };
      if (
        parsed.leaseKey !== leaseKey
        || parsed.callId !== String(args[0])
        || this.live(leaseKey)?.value !== parsed.leaseId
      ) {
        return 0;
      }
      this.values.set(nonceKey, {
        value: "1",
        expiresAt: Date.now() + (Number(args[2]) - Number(args[1])) * 1_000,
      });
      return 1;
    }
    if (script.includes("axiom-realtime-session-release")) {
      const mapping = this.live(key);
      if (!mapping || typeof mapping.value !== "string") return 0;
      const parsed = JSON.parse(mapping.value) as { leaseKey: string; leaseId: string };
      if (this.live(parsed.leaseKey)?.value === parsed.leaseId) this.values.delete(parsed.leaseKey);
      this.values.delete(key);
      return 1;
    }
    if (script.includes("axiom-realtime-admission-release")) {
      const existing = this.live(key)?.value;
      if (existing !== String(args[0])) return 0;
      this.values.delete(key);
      return 1;
    }
    if (script.includes("axiom-active-state-get")) {
      const state = this.live(key)?.value;
      const revisionKey = keys[1];
      if (typeof state !== "string" || !revisionKey) return [false, -1];
      const revision = this.live(revisionKey)?.value;
      return [state, typeof revision === "string" ? Number(revision) : -1];
    }
    if (script.includes("axiom-active-state-set")) {
      const revisionKey = keys[1];
      const terminalKey = keys[2];
      if (!revisionKey || !terminalKey) throw new Error("Active state keys are required");
      if (this.live(terminalKey)) return 0;
      const expiresAt = Date.now() + Number(args[2]) * 1_000;
      this.values.set(key, { value: String(args[0]), expiresAt });
      this.values.set(revisionKey, { value: String(args[1]), expiresAt });
      return 1;
    }
    if (script.includes("axiom-session-create-if-absent")) {
      const revisionKey = keys[1];
      const terminalKey = keys[2];
      const completedKey = keys[3];
      const mutationIndexKey = keys[4];
      if (!revisionKey || !terminalKey || !completedKey || !mutationIndexKey) throw new Error("Session create keys are required");
      if (this.live(terminalKey)) return [0, ""];
      const completed = this.live(completedKey);
      if (completed && typeof completed.value === "string") return [2, completed.value];
      if (this.live(key) || this.live(revisionKey)) return [0, ""];
      const stateExpiresAt = Date.now() + Number(args[2]) * 1_000;
      this.values.set(key, { value: String(args[0]), expiresAt: stateExpiresAt });
      this.values.set(revisionKey, { value: "0", expiresAt: stateExpiresAt });
      this.values.set(completedKey, {
        value: String(args[1]),
        expiresAt: Date.now() + Number(args[3]) * 1_000,
      });
      await this.rpush(mutationIndexKey, completedKey);
      await this.expire(mutationIndexKey, Number(args[3]));
      return [1, ""];
    }
    if (script.includes("axiom-mutation-attempt-reserve")) {
      const revisionKey = keys[1];
      const terminalKey = keys[2];
      const completedKey = keys[3];
      const attemptKey = keys[4];
      if (!revisionKey || !terminalKey || !completedKey || !attemptKey) throw new Error("Mutation attempt keys are required");
      if (this.live(terminalKey)) return [-3, "", await this.ttl(terminalKey)];
      const completed = this.live(completedKey);
      if (completed && typeof completed.value === "string") return [3, completed.value, await this.ttl(completedKey)];
      const current = this.live(revisionKey)?.value;
      const currentRevision = typeof current === "string" ? Number(current) : -1;
      if (currentRevision !== Number(args[0])) return [-2, String(currentRevision), 0];
      if (this.live(attemptKey)) return [2, "", await this.ttl(attemptKey)];
      this.values.set(attemptKey, {
        value: String(args[1]),
        expiresAt: Date.now() + Number(args[2]) * 1_000,
      });
      return [1, String(args[1]), Number(args[2])];
    }
    if (script.includes("axiom-mutation-attempt-release")) {
      if (this.live(key)?.value !== String(args[0])) return 0;
      this.values.delete(key);
      return 1;
    }
    if (script.includes("axiom-session-terminal-commit")) {
      const responseKey = keys[1];
      const revisionKey = keys[2];
      const terminalKey = keys[3];
      const mutationIndexKey = keys[7];
      if (!responseKey || !revisionKey || !terminalKey || !mutationIndexKey) {
        throw new Error("Terminal session keys are required");
      }
      if (this.live(terminalKey)) return this.live(responseKey) ? 1 : 0;
      const current = this.live(key);
      const currentRevision = this.live(revisionKey)?.value;
      if (!current || Number(currentRevision) !== Number(args[0])) return 0;
      const stateExpiresAt = Date.now() + Number(args[4]) * 1_000;
      const terminalExpiresAt = Date.now() + Number(args[5]) * 1_000;
      this.values.set(key, { value: String(args[1]), expiresAt: stateExpiresAt });
      this.values.set(revisionKey, { value: String(args[3]), expiresAt: stateExpiresAt });
      this.values.set(terminalKey, { value: "1", expiresAt: terminalExpiresAt });
      const realtimeMappingKey = keys[6];
      const realtimeMapping = realtimeMappingKey ? this.live(realtimeMappingKey) : undefined;
      if (realtimeMapping && typeof realtimeMapping.value === "string") {
        const parsed = JSON.parse(realtimeMapping.value) as { leaseKey: string; leaseId: string };
        if (this.live(parsed.leaseKey)?.value === parsed.leaseId) this.values.delete(parsed.leaseKey);
      }
      const visualLeaseKey = keys[11];
      const visualLease = visualLeaseKey ? this.live(visualLeaseKey)?.value : undefined;
      if (typeof visualLease === "string") {
        const lease = JSON.parse(visualLease) as { learner: string; charge: number; chargeDay: string };
        this.visualActive.get(`axiom:visual:active:${lease.learner}`)?.delete(String(args[6]));
        for (const chargeKey of [
          `axiom:visual:daily:${lease.learner}:${lease.chargeDay}`,
          `axiom:visual:daily:global:${lease.chargeDay}`,
        ]) {
          const current = this.live(chargeKey);
          const used = typeof current?.value === "string" ? Number(current.value) : 0;
          if (used <= lease.charge) this.values.delete(chargeKey);
          else this.values.set(chargeKey, { value: String(used - lease.charge), expiresAt: current?.expiresAt });
        }
      }
      const indexed = await this.lrange(mutationIndexKey, 0, -1);
      for (const indexedKey of indexed) this.values.delete(String(indexedKey));
      for (const purgeKey of keys.slice(4)) this.values.delete(purgeKey);
      this.values.set(responseKey, { value: String(args[2]), expiresAt: terminalExpiresAt });
      return 1;
    }
    if (script.includes("axiom-session-mutation-commit")) {
      const responseKey = keys[1];
      const revisionKey = keys[2];
      const mutationIndexKey = keys[3];
      const terminalKey = keys[4];
      const attemptKey = keys[5];
      if (!responseKey || !revisionKey || !mutationIndexKey || !terminalKey || !attemptKey) throw new Error("Session mutation keys are required");
      if (this.live(terminalKey) || this.live(responseKey)) return 0;
      if (this.live(attemptKey)?.value !== String(args[6])) return 0;
      const current = this.live(key);
      const currentRevision = this.live(revisionKey)?.value;
      const expectedRevision = Number(args[0]);
      if (!current || Number(currentRevision) !== expectedRevision) return 0;
      const stateExpiresAt = Date.now() + Number(args[4]) * 1_000;
      this.values.set(key, { value: String(args[1]), expiresAt: stateExpiresAt });
      this.values.set(responseKey, {
        value: String(args[2]),
        expiresAt: Date.now() + Number(args[5]) * 1_000,
      });
      this.values.set(revisionKey, { value: String(args[3]), expiresAt: stateExpiresAt });
      this.values.delete(attemptKey);
      const indexed = await this.rpush(mutationIndexKey, responseKey);
      if (indexed === 1) await this.expire(mutationIndexKey, Number(args[5]));
      return 1;
    }
    if (script.includes("axiom-encrypted-transcript-append-many-once")) {
      const terminalKey = keys[1]!;
      if (this.live(terminalKey)) return 0;
      const initialLength = (await this.lrange(key, 0, -1)).length;
      let appended = 0;
      for (let index = 2; index < keys.length; index += 1) {
        const markerKey = keys[index]!;
        if (this.live(markerKey)) continue;
        await this.rpush(key, String(args[index]));
        await this.set(markerKey, "1", { ex: Number(args[1]) });
        appended += 1;
      }
      if (initialLength === 0 && appended > 0) await this.expire(key, Number(args[0]));
      return appended;
    }
    if (script.includes("axiom-session-event-fanout-many-once")) {
      const terminalKey = keys[1]!;
      if (this.live(terminalKey)) return 0;
      const initialLength = (await this.lrange(key, 0, -1)).length;
      let appended = 0;
      for (let index = 2; index < keys.length; index += 1) {
        const markerKey = keys[index]!;
        if (this.live(markerKey)) continue;
        const encrypted = String(args[index]);
        await this.rpush(key, encrypted);
        await this.publish(key, encrypted);
        await this.set(markerKey, "1", { ex: Number(args[1]) });
        appended += 1;
      }
      if (initialLength === 0 && appended > 0) await this.expire(key, Number(args[0]));
      return appended;
    }
    if (script.includes("axiom-encrypted-transcript-append-once")) {
      const markerKey = keys[1]!;
      const terminalKey = keys[2]!;
      if (this.live(terminalKey) || this.live(markerKey)) return 0;
      const length = await this.rpush(key, String(args[0]));
      if (length === 1) await this.expire(key, Number(args[1]));
      await this.set(markerKey, "1", { ex: Number(args[2]) });
      return 1;
    }
    if (script.includes("axiom-encrypted-transcript-append")) {
      const terminalKey = keys[1]!;
      if (this.live(terminalKey)) return 0;
      const length = await this.rpush(key, String(args[0]));
      if (length === 1) await this.expire(key, Number(args[1]));
      return length;
    }
    if (script.includes("axiom-session-event-fanout-once")) {
      const markerKey = keys[1]!;
      const terminalKey = keys[2]!;
      if (this.live(terminalKey) || this.live(markerKey)) return 0;
      const length = await this.rpush(key, String(args[0]));
      if (length === 1) await this.expire(key, Number(args[1]));
      await this.set(markerKey, "1", { ex: Number(args[3]) });
      return this.publish(key, String(args[2]));
    }
    if (script.includes("axiom-session-event-fanout")) {
      const terminalKey = keys[1]!;
      if (this.live(terminalKey)) return 0;
      const retained = String(args[0]);
      const length = await this.rpush(key, retained);
      if (length === 1) await this.expire(key, Number(args[1]));
      return this.publish(key, String(args[2]));
    }
    if (!script.includes("axiom-fixed-window-rate-limit")) throw new Error("Unsupported in-memory script");
    const currentValue = this.live(key)?.value;
    const count = (typeof currentValue === "string" ? Number(currentValue) : 0) + 1;
    const windowSeconds = Number(args[0]);
    const existing = this.live(key);
    this.values.set(key, {
      value: String(count),
      expiresAt: existing?.expiresAt ?? Date.now() + windowSeconds * 1_000,
    });
    return [count, await this.ttl(key)];
  }

  private live(key: string): StoredRedisValue | undefined {
    const item = this.values.get(key);
    if (item?.expiresAt !== undefined && item.expiresAt <= Date.now()) {
      this.values.delete(key);
      return undefined;
    }
    return item;
  }
}

interface MutableLearner {
  mastery: Map<string, ConceptMastery>;
  misconceptions: Map<string, Misconception>;
  preferences: LearnerPreferences;
  summaries: SessionSummary[];
}
export class InMemoryLearningRepository implements LearningRepository {
  private readonly learners = new Map<string, MutableLearner>();
  private readonly mutationEffects = new Set<string>();
  readonly profiles: StoredProfile[] = [];
  readonly sessionSummaries: SessionSummaryInput[] = [];
  readonly explorationEdges: Array<{ sessionId: string; edge: ExplorationEdgeInput }> = [];
  readonly cardInteractions: CardInteractionInput[] = [];
  readonly visualMetadata: VisualMetadataInput[] = [];
  readonly operationalMetrics: OperationalMetricInput[] = [];

  async load(learnerId: string): Promise<HydratedLearningContext> {
    return this.loadLearningContext(learnerId);
  }

  async loadLearningContext(learnerId: string): Promise<HydratedLearningContext> {
    const learner = this.getLearner(learnerId);
    return {
      learnerId,
      mastery: [...learner.mastery.values()].map((item) => ({ ...item })),
      misconceptions: [...learner.misconceptions.values()].map((item) => ({ ...item })),
      preferences: { ...learner.preferences, interests: [...learner.preferences.interests] },
      recentSummaries: learner.summaries.map((item) => ({ ...item, concepts: [...item.concepts], explorationEdges: item.explorationEdges.map((edge) => ({ ...edge })) })),
      recentCardInteractions: this.cardInteractions
        .filter((item) => item.learnerId === learnerId)
        .sort((left, right) => right.occurredAt.getTime() - left.occurredAt.getTime())
        .slice(0, LEARNING_CONTEXT_LIMITS.cardInteractions)
        .map((item) => ({ ...item })),
      recentVisualMetadata: this.visualMetadata
        .filter((item) => item.learnerId === learnerId)
        .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())
        .slice(0, LEARNING_CONTEXT_LIMITS.visualMetadata)
        .map((item) => ({ ...item })),
    };
  }

  async recordEvidence(learnerId: string, evidence: LearningEvidence, operationId?: string): Promise<HydratedLearningContext> {
    if (operationId && this.mutationEffects.has(operationId)) return this.load(learnerId);
    if (operationId) this.mutationEffects.add(operationId);
    const learner = this.getLearner(learnerId);
    const concept = evidence.concept.trim();
    if (!concept) throw new Error("Evidence concept is required");
    const conceptKey = concept.toLocaleLowerCase();
    const current = learner.mastery.get(conceptKey);
    learner.mastery.set(conceptKey, {
      concept: current?.concept ?? concept,
      confidence: Math.max(0, Math.min(1, (current?.confidence ?? 0.5) + evidence.confidenceDelta)),
      evidenceCount: (current?.evidenceCount ?? 0) + 1,
    });
    while (learner.mastery.size > LEARNING_CONTEXT_LIMITS.mastery) {
      learner.mastery.delete(learner.mastery.keys().next().value as string);
    }
    const misconception = evidence.misconception?.trim();
    if (misconception) {
      const misconceptionKey = `${conceptKey}\u0000${misconception.toLocaleLowerCase()}`;
      const existing = learner.misconceptions.get(misconceptionKey);
      learner.misconceptions.set(misconceptionKey, {
        concept: current?.concept ?? concept,
        description: existing?.description ?? misconception,
        evidenceCount: (existing?.evidenceCount ?? 0) + 1,
      });
      while (learner.misconceptions.size > LEARNING_CONTEXT_LIMITS.misconceptions) {
        learner.misconceptions.delete(learner.misconceptions.keys().next().value as string);
      }
    }
    if (evidence.preferenceSignals) {
      const interests = [...learner.preferences.interests];
      for (const signal of evidence.preferenceSignals.interests ?? []) {
        const normalized = signal.trim();
        if (!normalized || interests.some((item) => item.toLocaleLowerCase() === normalized.toLocaleLowerCase())) continue;
        interests.push(normalized);
      }
      learner.preferences = {
        ...learner.preferences,
        ...evidence.preferenceSignals,
        interests: interests.slice(-LEARNING_CONTEXT_LIMITS.interests),
      };
    }
    return this.load(learnerId);
  }

  async recordSessionSummary(learnerId: string, summary: SessionSummary): Promise<void> {
    const learner = this.getLearner(learnerId);
    learner.summaries = [
      { ...summary, explorationEdges: summary.explorationEdges.slice(0, LEARNING_CONTEXT_LIMITS.explorationEdgesPerSummary) },
      ...learner.summaries.filter((item) => item.sessionId !== summary.sessionId),
    ].slice(0, LEARNING_CONTEXT_LIMITS.sessionSummaries);
  }

  async upsertProfile(input: ProfileInput): Promise<void> {
    const index = this.profiles.findIndex((profile) => profile.learnerId === input.learnerId);
    const now = new Date();
    const stored: StoredProfile = {
      ...input,
      createdAt: index >= 0 ? this.profiles[index]!.createdAt : now,
      updatedAt: now,
    };
    if (index >= 0) this.profiles[index] = stored;
    else this.profiles.push(stored);
    this.getLearner(input.learnerId);
  }

  async getProfile(learnerId: string): Promise<StoredProfile | null> {
    const profile = this.profiles.find((candidate) => candidate.learnerId === learnerId);
    return profile ? { ...profile } : null;
  }

  async updatePreferences(input: PreferenceInput): Promise<void> {
    const learner = this.getLearner(input.learnerId);
    learner.preferences = {
      ...learner.preferences,
      ...(input.explanationMode ? { explanationMode: input.explanationMode } : {}),
      ...(input.pace ? { pace: input.pace } : {}),
      ...(input.challenge ? { challenge: input.challenge } : {}),
    };
  }

  async addInterest(learnerId: string, topic: string): Promise<void> {
    const learner = this.getLearner(learnerId);
    const normalized = topic.trim();
    if (!normalized) throw new Error("Interest topic is required");
    const interests = learner.preferences.interests.filter((item) => item.toLocaleLowerCase() !== normalized.toLocaleLowerCase());
    learner.preferences = {
      ...learner.preferences,
      interests: [normalized, ...interests].slice(0, LEARNING_CONTEXT_LIMITS.interests),
    };
  }

  async saveCompactSessionSummary(input: SessionSummaryInput): Promise<void> {
    const compact: SessionSummaryInput = {
      sessionId: input.sessionId,
      userId: input.userId,
      summary: input.summary.trim().slice(0, 2_000),
      concepts: [...new Set(
        input.concepts.map((concept) => concept.trim().toLocaleLowerCase()).filter(Boolean),
      )].slice(0, 20),
      explorationEdges: input.explorationEdges?.slice(0, LEARNING_CONTEXT_LIMITS.explorationEdgesPerSummary) ?? [],
      startedAt: input.startedAt,
      endedAt: input.endedAt,
    };
    if (!compact.summary) throw new Error("Session summary is required");
    this.sessionSummaries.push(compact);
    for (let index = this.sessionSummaries.length - 1, retained = 0; index >= 0; index -= 1) {
      if (this.sessionSummaries[index]!.userId !== input.userId) continue;
      retained += 1;
      if (retained > LEARNING_CONTEXT_LIMITS.sessionSummaries) this.sessionSummaries.splice(index, 1);
    }
    await this.recordSessionSummary(compact.userId, {
      sessionId: compact.sessionId,
      summary: compact.summary,
      concepts: compact.concepts,
      explorationEdges: compact.explorationEdges ?? [],
      completedAt: compact.endedAt,
    });
    await this.recordExplorationEdges(compact.sessionId, compact.explorationEdges ?? []);
  }

  async recordExplorationEdges(sessionId: string, edges: readonly ExplorationEdgeInput[]): Promise<void> {
    const retained = edges.slice(0, LEARNING_CONTEXT_LIMITS.explorationEdgesPerSummary);
    this.explorationEdges.push(...retained.map((edge) => ({ sessionId, edge: { ...edge } })));
  }
  async recordOperationalMetric(input: OperationalMetricInput): Promise<void> {
    assertOperationalMetricSafe(input);
    this.operationalMetrics.push(input);
  }
  async recordCardInteraction(input: CardInteractionInput, operationId?: string): Promise<void> {
    if (operationId && this.mutationEffects.has(operationId)) return;
    if (operationId) this.mutationEffects.add(operationId);
    this.cardInteractions.push({
      sessionId: input.sessionId,
      learnerId: input.learnerId,
      cardId: input.cardId,
      purpose: input.purpose,
      action: input.action,
      ...(input.concept ? { concept: input.concept } : {}),
      occurredAt: input.occurredAt,
    });
    this.trimLearnerRecords(this.cardInteractions, input.learnerId, "occurredAt", LEARNING_CONTEXT_LIMITS.cardInteractions);
  }

  async recordVisualMetadata(input: VisualMetadataInput): Promise<void> {
    this.visualMetadata.push({
      sessionId: input.sessionId,
      ...(input.learnerId ? { learnerId: input.learnerId } : {}),
      visualId: input.visualId,
      concept: input.concept,
      durationSeconds: input.durationSeconds,
      resolution: input.resolution,
      outcome: input.outcome,
      promptVersion: input.promptVersion,
      ...(input.latencyMs === undefined ? {} : { latencyMs: input.latencyMs }),
      createdAt: input.createdAt,
    });
    if (input.learnerId) {
      this.trimLearnerRecords(this.visualMetadata, input.learnerId, "createdAt", LEARNING_CONTEXT_LIMITS.visualMetadata);
    }
  }

  private trimLearnerRecords<T extends { learnerId?: string }>(
    records: T[],
    learnerId: string,
    timestamp: keyof T,
    limit: number,
  ): void {
    const excess = records
      .map((record, index) => ({ record, index }))
      .filter(({ record }) => record.learnerId === learnerId)
      .sort((left, right) => (left.record[timestamp] as Date).getTime() - (right.record[timestamp] as Date).getTime())
      .slice(0, Math.max(0, records.filter((record) => record.learnerId === learnerId).length - limit))
      .map(({ index }) => index)
      .sort((left, right) => right - left);
    for (const index of excess) records.splice(index, 1);
  }

  private getLearner(learnerId: string): MutableLearner {
    let learner = this.learners.get(learnerId);
    if (!learner) {
      learner = { mastery: new Map(), misconceptions: new Map(), preferences: { interests: [] }, summaries: [] };
      this.learners.set(learnerId, learner);
    }
    return learner;
  }
}
