import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { sessionEventSchema, type SessionEvent } from "@axiom/protocol";
import { z } from "zod";
import type {
  ActiveSessionState,
  RateLimitPolicy,
  RateLimitResult,
  TranscriptEntry,
} from "./types";

const MAX_TRANSCRIPT_TTL_SECONDS = 86_400;
const DEFAULT_ACTIVE_TTL_SECONDS = 300;
const FANOUT_TTL_SECONDS = 3_600;
const RATE_LIMIT_SCRIPT = `-- axiom-fixed-window-rate-limit
local current = redis.call('INCR', KEYS[1])
if current == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
local ttl = redis.call('TTL', KEYS[1])
return {current, ttl}`;
const ANONYMOUS_ADMISSION_SCRIPT = `-- axiom-anonymous-admission
local globalCount = tonumber(redis.call('GET', KEYS[1]) or '0')
local ipCount = tonumber(redis.call('GET', KEYS[2]) or '0')
if globalCount >= tonumber(ARGV[1]) then return {-1, redis.call('TTL', KEYS[1])} end
if ipCount >= tonumber(ARGV[2]) then return {-2, redis.call('TTL', KEYS[2])} end
globalCount = redis.call('INCR', KEYS[1])
ipCount = redis.call('INCR', KEYS[2])
if globalCount == 1 then redis.call('EXPIRE', KEYS[1], ARGV[3]) end
if ipCount == 1 then redis.call('EXPIRE', KEYS[2], ARGV[3]) end
redis.call('SET', KEYS[3], ARGV[4], 'EX', ARGV[5])
return {1, ARGV[3]}`;
const ANONYMOUS_ADMISSION_RELEASE_SCRIPT = `-- axiom-anonymous-admission-release
local marker = redis.call('GET', KEYS[3])
if not marker or marker ~= ARGV[1] then return 0 end
local globalCount = tonumber(redis.call('GET', KEYS[1]) or '0')
local networkCount = tonumber(redis.call('GET', KEYS[2]) or '0')
if globalCount > 0 then redis.call('DECR', KEYS[1]) end
if networkCount > 0 then redis.call('DECR', KEYS[2]) end
redis.call('DEL', KEYS[3])
return 1`;
const EVENT_STREAM_LEASE_ACQUIRE_SCRIPT = `-- axiom-event-stream-lease-acquire
local owner = redis.call('GET', KEYS[1])
if owner and owner ~= ARGV[1] then return 0 end
redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2])
return 1`;
const EVENT_STREAM_LEASE_RELEASE_SCRIPT = `-- axiom-event-stream-lease-release
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
return redis.call('DEL', KEYS[1])`;
const TRANSCRIPT_APPEND_SCRIPT = `-- axiom-encrypted-transcript-append
if redis.call('GET', KEYS[2]) then return 0 end
local length = redis.call('RPUSH', KEYS[1], ARGV[1])
if length == 1 then redis.call('EXPIRE', KEYS[1], ARGV[2]) end
return length`;
const TRANSCRIPT_APPEND_ONCE_SCRIPT = `-- axiom-encrypted-transcript-append-once
if redis.call('GET', KEYS[3]) or redis.call('GET', KEYS[2]) then return 0 end
local length = redis.call('RPUSH', KEYS[1], ARGV[1])
if length == 1 then redis.call('EXPIRE', KEYS[1], ARGV[2]) end
redis.call('SET', KEYS[2], '1', 'EX', ARGV[3])
return 1`;
const TRANSCRIPT_APPEND_MANY_ONCE_SCRIPT = `-- axiom-encrypted-transcript-append-many-once
if redis.call('GET', KEYS[2]) then return 0 end
local initialLength = redis.call('LLEN', KEYS[1])
local appended = 0
for index = 3, #KEYS do
  if not redis.call('GET', KEYS[index]) then
    redis.call('RPUSH', KEYS[1], ARGV[index])
    redis.call('SET', KEYS[index], '1', 'EX', ARGV[2])
    appended = appended + 1
  end
end
if initialLength == 0 and appended > 0 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
return appended`;
const FANOUT_SCRIPT = `-- axiom-session-event-fanout
if redis.call('GET', KEYS[2]) then return 0 end
local length = redis.call('RPUSH', KEYS[1], ARGV[1])
if length == 1 then redis.call('EXPIRE', KEYS[1], ARGV[2]) end
return redis.call('PUBLISH', KEYS[1], ARGV[3])`;
const FANOUT_ONCE_SCRIPT = `-- axiom-session-event-fanout-once
if redis.call('GET', KEYS[3]) or redis.call('GET', KEYS[2]) then return 0 end
local length = redis.call('RPUSH', KEYS[1], ARGV[1])
if length == 1 then redis.call('EXPIRE', KEYS[1], ARGV[2]) end
redis.call('SET', KEYS[2], '1', 'EX', ARGV[4])
return redis.call('PUBLISH', KEYS[1], ARGV[3])`;
const FANOUT_MANY_ONCE_SCRIPT = `-- axiom-session-event-fanout-many-once
if redis.call('GET', KEYS[2]) then return 0 end
local initialLength = redis.call('LLEN', KEYS[1])
local appended = 0
for index = 3, #KEYS do
  if not redis.call('GET', KEYS[index]) then
    redis.call('RPUSH', KEYS[1], ARGV[index])
    redis.call('PUBLISH', KEYS[1], ARGV[index])
    redis.call('SET', KEYS[index], '1', 'EX', ARGV[2])
    appended = appended + 1
  end
end
if initialLength == 0 and appended > 0 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
return appended`;
const ACTIVE_STATE_SET_SCRIPT = `-- axiom-active-state-set
if redis.call('GET', KEYS[3]) then return 0 end
redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[3])
redis.call('SET', KEYS[2], ARGV[2], 'EX', ARGV[3])
return 1`;
const ACTIVE_STATE_GET_SCRIPT = `-- axiom-active-state-get
local state = redis.call('GET', KEYS[1])
if not state then return {false, -1} end
local revision = tonumber(redis.call('GET', KEYS[2]) or '-1')
return {state, revision}`;
const MUTATION_ATTEMPT_RESERVE_SCRIPT = `-- axiom-mutation-attempt-reserve
if redis.call('GET', KEYS[3]) then return {-3, '', redis.call('TTL', KEYS[3])} end
local completed = redis.call('GET', KEYS[4])
if completed then return {3, completed, redis.call('TTL', KEYS[4])} end
local current = tonumber(redis.call('GET', KEYS[2]) or '-1')
if current ~= tonumber(ARGV[1]) then return {-2, tostring(current), 0} end
local pending = redis.call('GET', KEYS[5])
if pending then return {2, '', redis.call('TTL', KEYS[5])} end
redis.call('SET', KEYS[5], ARGV[2], 'EX', ARGV[3])
return {1, ARGV[2], ARGV[3]}`;
const MUTATION_ATTEMPT_RELEASE_SCRIPT = `-- axiom-mutation-attempt-release
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
return redis.call('DEL', KEYS[1])`;
const SESSION_CREATE_SCRIPT = `-- axiom-session-create-if-absent
if redis.call('GET', KEYS[3]) then return {0, ''} end
local completed = redis.call('GET', KEYS[4])
if completed then return {2, completed} end
if redis.call('GET', KEYS[1]) or redis.call('GET', KEYS[2]) then return {0, ''} end
redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[3])
redis.call('SET', KEYS[2], '0', 'EX', ARGV[3])
redis.call('SET', KEYS[4], ARGV[2], 'EX', ARGV[4])
local indexed = redis.call('RPUSH', KEYS[5], KEYS[4])
if indexed == 1 then redis.call('EXPIRE', KEYS[5], ARGV[4]) end
return {1, ''}`;
const SESSION_MUTATION_COMMIT_SCRIPT = `-- axiom-session-mutation-commit
if redis.call('GET', KEYS[5]) or redis.call('GET', KEYS[2]) then return 0 end
if redis.call('GET', KEYS[6]) ~= ARGV[7] then return 0 end
local current = redis.call('GET', KEYS[1])
local currentRevision = redis.call('GET', KEYS[3])
if not current or tonumber(currentRevision) ~= tonumber(ARGV[1]) then return 0 end
redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[5])
redis.call('SET', KEYS[2], ARGV[3], 'EX', ARGV[6])
redis.call('SET', KEYS[3], ARGV[4], 'EX', ARGV[5])
redis.call('DEL', KEYS[6])
local indexed = redis.call('RPUSH', KEYS[4], KEYS[2])
if indexed == 1 then redis.call('EXPIRE', KEYS[4], ARGV[6]) end
return 1`;
const SESSION_TERMINAL_COMMIT_SCRIPT = `-- axiom-session-terminal-commit
if redis.call('GET', KEYS[4]) then
  if redis.call('GET', KEYS[2]) then return 1 end
  return 0
end
local current = redis.call('GET', KEYS[1])
local currentRevision = redis.call('GET', KEYS[3])
if not current or tonumber(currentRevision) ~= tonumber(ARGV[1]) then return 0 end
redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[5])
redis.call('SET', KEYS[3], ARGV[4], 'EX', ARGV[5])
redis.call('SET', KEYS[4], '1', 'EX', ARGV[6])
local mapping = redis.call('GET', KEYS[7])
if mapping then
  local parsed = cjson.decode(mapping)
  if redis.call('GET', parsed.leaseKey) == parsed.leaseId then redis.call('DEL', parsed.leaseKey) end
end
local visual = redis.call('GET', KEYS[12])
if visual then
  local lease = cjson.decode(visual)
  local activeKey = 'axiom:visual:active:' .. lease.learner
  local dailyKey = 'axiom:visual:daily:' .. lease.learner .. ':' .. lease.chargeDay
  local globalKey = 'axiom:visual:daily:global:' .. lease.chargeDay
  local charge = tonumber(lease.charge) or 0
  redis.call('DEL', KEYS[12])
  redis.call('ZREM', activeKey, ARGV[7])
  local dailyUsed = tonumber(redis.call('GET', dailyKey) or '0')
  if dailyUsed <= charge then redis.call('DEL', dailyKey) else redis.call('DECRBY', dailyKey, charge) end
  local globalUsed = tonumber(redis.call('GET', globalKey) or '0')
  if globalUsed <= charge then redis.call('DEL', globalKey) else redis.call('DECRBY', globalKey, charge) end
end
local mutationKeys = redis.call('LRANGE', KEYS[8], 0, -1)
for _, mutationKey in ipairs(mutationKeys) do redis.call('DEL', mutationKey) end
redis.call('DEL', KEYS[5], KEYS[6], KEYS[7], KEYS[8], KEYS[9], KEYS[10], KEYS[11])
redis.call('SET', KEYS[2], ARGV[3], 'EX', ARGV[6])
return 1`;
const VISUAL_RESERVE_SCRIPT = `-- axiom-visual-entitlement-reserve
local used = tonumber(redis.call('GET', KEYS[3]) or '0')
local charge = tonumber(ARGV[12])
local remaining = math.max(0, tonumber(ARGV[5]) - used)
if redis.call('GET', KEYS[5]) then return {-1, '', 0, remaining} end
local existing = redis.call('GET', KEYS[1])
if existing then
  local lease = cjson.decode(existing)
  local ttl = redis.call('TTL', KEYS[1])
  if lease.learner ~= ARGV[1] or tonumber(lease.duration) ~= tonumber(ARGV[2]) then
    return {-1, '', ttl, remaining}
  end
  if lease.state == 'active' then return {2, lease.id, ttl, remaining} end
  return {3, lease.id, ttl, remaining}
end
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', ARGV[3])
if redis.call('ZCARD', KEYS[2]) >= tonumber(ARGV[4]) then return {-2, '', 0, remaining} end
if used + charge > tonumber(ARGV[5]) then return {-3, '', 0, remaining} end
local globalUsed = tonumber(redis.call('GET', KEYS[4]) or '0')
if globalUsed + charge > tonumber(ARGV[10]) then return {-4, '', 0, remaining} end
local charged = redis.call('INCRBY', KEYS[3], charge)
if charged == charge then redis.call('EXPIRE', KEYS[3], ARGV[6]) end
local globalCharged = redis.call('INCRBY', KEYS[4], charge)
if globalCharged == charge then redis.call('EXPIRE', KEYS[4], ARGV[6]) end
local lease = cjson.encode({learner=ARGV[1], duration=tonumber(ARGV[2]), charge=charge, id=ARGV[7], state='active', chargeDay=ARGV[11]})
redis.call('SET', KEYS[1], lease, 'EX', ARGV[8])
redis.call('ZADD', KEYS[2], tonumber(ARGV[3]) + tonumber(ARGV[8]), ARGV[9])
redis.call('EXPIRE', KEYS[2], ARGV[8])
return {2, ARGV[7], tonumber(ARGV[8]), math.max(0, tonumber(ARGV[5]) - charged)}`;
const VISUAL_COMMIT_SCRIPT = `-- axiom-visual-entitlement-commit
local existing = redis.call('GET', KEYS[1])
if not existing then return 0 end
local lease = cjson.decode(existing)
if lease.id ~= ARGV[1] then return 0 end
if redis.call('GET', KEYS[2]) then return 0 end
if lease.state == 'active' then return redis.call('TTL', KEYS[1]) end
return 0`;
const VISUAL_VERIFY_SCRIPT = `-- axiom-visual-entitlement-verify
local existing = redis.call('GET', KEYS[1])
if not existing then return 0 end
local lease = cjson.decode(existing)
if lease.learner ~= ARGV[1] or lease.id ~= ARGV[2] or tonumber(lease.duration) ~= tonumber(ARGV[3]) then return 0 end
if lease.state ~= 'active' then return 0 end
return 1`;
const VISUAL_ICE_PERMIT_SCRIPT = `-- axiom-visual-ice-permit
local existing = redis.call('GET', KEYS[1])
if not existing then return 0 end
local lease = cjson.decode(existing)
if lease.learner ~= ARGV[1] or lease.id ~= ARGV[2] or tonumber(lease.duration) ~= tonumber(ARGV[3]) then return 0 end
if lease.state ~= 'active' then return 0 end
if ARGV[4] == 'primary' then
  if lease.icePhase then return 0 end
  lease.icePhase = 'primary'
else
  if lease.icePhase ~= 'fallback_allowed' then return 0 end
  lease.icePhase = 'fallback_used'
end
redis.call('SET', KEYS[1], cjson.encode(lease), 'KEEPTTL')
return 1`;
const VISUAL_ICE_FALLBACK_SCRIPT = `-- axiom-visual-ice-fallback
local existing = redis.call('GET', KEYS[1])
if not existing then return 0 end
local lease = cjson.decode(existing)
if lease.learner ~= ARGV[1] or lease.id ~= ARGV[2] or tonumber(lease.duration) ~= tonumber(ARGV[3]) then return 0 end
if lease.state ~= 'active' or lease.icePhase ~= 'primary' then return 0 end
lease.icePhase = 'fallback_allowed'
redis.call('SET', KEYS[1], cjson.encode(lease), 'KEEPTTL')
return 1`;
const VISUAL_CLAIM_SCRIPT = `-- axiom-visual-entitlement-claim
local existing = redis.call('GET', KEYS[1])
if not existing then return 0 end
local lease = cjson.decode(existing)
if lease.learner ~= ARGV[1] or lease.id ~= ARGV[2] or tonumber(lease.duration) ~= tonumber(ARGV[3]) then return 0 end
if lease.state ~= 'active' or not lease.icePhase then return 0 end
lease.state = 'negotiating'
redis.call('SET', KEYS[1], cjson.encode(lease), 'KEEPTTL')
return 1`;
const VISUAL_BIND_SCRIPT = `-- axiom-visual-entitlement-bind-provider
local existing = redis.call('GET', KEYS[1])
if not existing then return 0 end
local lease = cjson.decode(existing)
if lease.learner ~= ARGV[1] or lease.id ~= ARGV[2] or tonumber(lease.duration) ~= tonumber(ARGV[3]) then return 0 end
if lease.state ~= 'negotiating' then return 0 end
lease.state = 'connected'
lease.providerSession = ARGV[4]
lease.deadlineMs = tonumber(ARGV[5])
redis.call('SET', KEYS[1], cjson.encode(lease), 'KEEPTTL')
return 1`;
const VISUAL_PROVIDER_VERIFY_SCRIPT = `-- axiom-visual-entitlement-verify-provider
local existing = redis.call('GET', KEYS[1])
if not existing then return 0 end
local lease = cjson.decode(existing)
if lease.learner ~= ARGV[1] or lease.id ~= ARGV[2] or tonumber(lease.duration) ~= tonumber(ARGV[3]) then return 0 end
if lease.state ~= 'connected' or lease.providerSession ~= ARGV[4] then return 0 end
return 1`;
const VISUAL_HEARTBEAT_CLAIM_SCRIPT = `-- axiom-visual-heartbeat-claim
local existing = redis.call('GET', KEYS[1])
if not existing then return 0 end
local lease = cjson.decode(existing)
if lease.learner ~= ARGV[1] or lease.id ~= ARGV[2] or tonumber(lease.duration) ~= tonumber(ARGV[3]) then return 0 end
if lease.state ~= 'connected' or lease.providerSession ~= ARGV[4] then return 0 end
local now = tonumber(ARGV[5])
if now >= tonumber(lease.deadlineMs) then return -3 end
if lease.heartbeatInFlight then return -2 end
if lease.lastHeartbeatMs and now - tonumber(lease.lastHeartbeatMs) < tonumber(ARGV[6]) then return -1 end
lease.heartbeatInFlight = true
redis.call('SET', KEYS[1], cjson.encode(lease), 'KEEPTTL')
return 1`;
const VISUAL_HEARTBEAT_COMPLETE_SCRIPT = `-- axiom-visual-heartbeat-complete
local existing = redis.call('GET', KEYS[1])
if not existing then return 0 end
local lease = cjson.decode(existing)
if lease.learner ~= ARGV[1] or lease.id ~= ARGV[2] or lease.providerSession ~= ARGV[3] then return 0 end
lease.heartbeatInFlight = false
lease.lastHeartbeatMs = tonumber(ARGV[4])
redis.call('SET', KEYS[1], cjson.encode(lease), 'KEEPTTL')
return 1`;
const VISUAL_RELEASE_SCRIPT = `-- axiom-visual-entitlement-release
local existing = redis.call('GET', KEYS[1])
local dailyKey = KEYS[3]
local globalKey = KEYS[4]
if existing then
  local lease = cjson.decode(existing)
  if lease.chargeDay ~= ARGV[6] then
    dailyKey = KEYS[5]
    globalKey = KEYS[6]
  end
  local used = tonumber(redis.call('GET', dailyKey) or '0')
  if lease.learner ~= ARGV[1] or lease.id ~= ARGV[2] then
    local currentUsed = tonumber(redis.call('GET', KEYS[3]) or '0')
    return {0, math.max(0, tonumber(ARGV[5]) - currentUsed)}
  end
  redis.call('DEL', KEYS[1])
  redis.call('ZREM', KEYS[2], ARGV[3])
  if ARGV[4] == '1' then
    local duration = tonumber(lease.charge)
    if used <= duration then
      redis.call('DEL', dailyKey)
      used = 0
    else
      used = tonumber(redis.call('DECRBY', dailyKey, duration))
    end
    local globalUsed = tonumber(redis.call('GET', globalKey) or '0')
    if globalUsed <= duration then redis.call('DEL', globalKey) else redis.call('DECRBY', globalKey, duration) end
  end
  local currentUsed = tonumber(redis.call('GET', KEYS[3]) or '0')
  return {1, math.max(0, tonumber(ARGV[5]) - currentUsed)}
end
local currentUsed = tonumber(redis.call('GET', dailyKey) or '0')
return {0, math.max(0, tonumber(ARGV[5]) - currentUsed)}`;
const VISUAL_ALLOWANCE_SCRIPT = `-- axiom-visual-daily-allowance
local used = tonumber(redis.call('GET', KEYS[1]) or '0')
return math.max(0, tonumber(ARGV[1]) - used)`;
const REALTIME_RESERVE_SCRIPT = `-- axiom-realtime-admission-reserve
if redis.call('GET', KEYS[5]) then return {-5, redis.call('TTL', KEYS[5]), ''} end
local priorAttempt = redis.call('GET', KEYS[6])
if priorAttempt then
  local prior = cjson.decode(priorAttempt)
  if prior.session == ARGV[8] and prior.attempt == ARGV[9]
    and prior.leaseKey == KEYS[4] and redis.call('GET', KEYS[4]) == prior.leaseId then
    return {2, redis.call('TTL', KEYS[4]), prior.leaseId}
  end
  return {-4, redis.call('TTL', KEYS[6]), ''}
end
local globalCount = tonumber(redis.call('GET', KEYS[1]) or '0')
local minuteCount = tonumber(redis.call('GET', KEYS[2]) or '0')
local dailyCount = tonumber(redis.call('GET', KEYS[3]) or '0')
if redis.call('GET', KEYS[4]) then return {-4, redis.call('TTL', KEYS[4]), ''} end
if globalCount >= tonumber(ARGV[1]) then return {-1, redis.call('TTL', KEYS[1]), ''} end
if minuteCount >= tonumber(ARGV[2]) then return {-2, redis.call('TTL', KEYS[2]), ''} end
if dailyCount >= tonumber(ARGV[3]) then return {-3, redis.call('TTL', KEYS[3]), ''} end
globalCount = redis.call('INCR', KEYS[1])
minuteCount = redis.call('INCR', KEYS[2])
dailyCount = redis.call('INCR', KEYS[3])
if globalCount == 1 then redis.call('EXPIRE', KEYS[1], ARGV[4]) end
if minuteCount == 1 then redis.call('EXPIRE', KEYS[2], ARGV[5]) end
if dailyCount == 1 then redis.call('EXPIRE', KEYS[3], ARGV[4]) end
redis.call('SET', KEYS[4], ARGV[6], 'EX', ARGV[7])
local attempt = cjson.encode({session=ARGV[8], attempt=ARGV[9], leaseKey=KEYS[4], leaseId=ARGV[6]})
redis.call('SET', KEYS[6], attempt, 'EX', ARGV[7])
return {1, ARGV[7], ARGV[6]}`;
const REALTIME_REPLACE_SCRIPT = `-- axiom-realtime-admission-replace
if redis.call('GET', KEYS[2]) then return {-5, redis.call('TTL', KEYS[2]), ''} end
local priorAttempt = redis.call('GET', KEYS[3])
if priorAttempt then
  local prior = cjson.decode(priorAttempt)
  if prior.session == ARGV[3] and prior.attempt == ARGV[4]
    and prior.leaseKey == KEYS[1] and redis.call('GET', KEYS[1]) == prior.leaseId then
    return {2, redis.call('TTL', KEYS[1]), prior.leaseId}
  end
  return {-4, redis.call('TTL', KEYS[3]), ''}
end
local mapping = redis.call('GET', KEYS[4])
if not mapping then return {-4, 0, ''} end
local parsed = cjson.decode(mapping)
if parsed.leaseKey ~= KEYS[1] or redis.call('GET', KEYS[1]) ~= parsed.leaseId then
  return {-4, redis.call('TTL', KEYS[1]), ''}
end
redis.call('DEL', KEYS[1], KEYS[4])
redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2])
local attempt = cjson.encode({session=ARGV[3], attempt=ARGV[4], leaseKey=KEYS[1], leaseId=ARGV[1]})
redis.call('SET', KEYS[3], attempt, 'EX', ARGV[2])
return {1, ARGV[2], ARGV[1]}`;
const REALTIME_RELEASE_SCRIPT = `-- axiom-realtime-admission-release
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
return redis.call('DEL', KEYS[1])`;
const REALTIME_ACTIVATE_SCRIPT = `-- axiom-realtime-admission-activate
if redis.call('GET', KEYS[3]) then
  if redis.call('GET', KEYS[1]) == ARGV[1] then redis.call('DEL', KEYS[1]) end
  return 0
end
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
local ttl = redis.call('TTL', KEYS[1])
if ttl <= 0 then return 0 end
redis.call('SET', KEYS[2], ARGV[2], 'EX', ttl)
return ttl`;
const REALTIME_SESSION_RELEASE_SCRIPT = `-- axiom-realtime-session-release
local mapping = redis.call('GET', KEYS[1])
if not mapping then return 0 end
local parsed = cjson.decode(mapping)
if redis.call('GET', parsed.leaseKey) == parsed.leaseId then redis.call('DEL', parsed.leaseKey) end
redis.call('DEL', KEYS[1])
return 1`;
const REALTIME_VERIFY_SCRIPT = `-- axiom-realtime-call-verify
local mapping = redis.call('GET', KEYS[1])
if not mapping then return 0 end
local parsed = cjson.decode(mapping)
if parsed.leaseKey ~= KEYS[2] or parsed.callId ~= ARGV[1] then return 0 end
if redis.call('GET', KEYS[2]) ~= parsed.leaseId then return 0 end
return 1`;
const ACTIVE_REALTIME_CALL_SCRIPT = `-- axiom-active-realtime-call-read
if redis.call('GET', KEYS[4]) then return {0, 0} end
local mapping = redis.call('GET', KEYS[1])
if not mapping then return {0, 0} end
local parsed = cjson.decode(mapping)
if parsed.leaseKey ~= KEYS[2] or parsed.callId ~= ARGV[1] then return {0, 0} end
if redis.call('GET', KEYS[2]) ~= parsed.leaseId then return {0, 0} end
local revision = tonumber(redis.call('GET', KEYS[3]) or '0')
if revision < 0 then return {0, 0} end
return {1, revision}`;
const GATEWAY_TICKET_CLAIM_SCRIPT = `-- axiom-gateway-ticket-claim
if tonumber(ARGV[3]) <= tonumber(ARGV[2]) then return 0 end
if redis.call('GET', KEYS[4]) or redis.call('GET', KEYS[3]) then return 0 end
local mapping = redis.call('GET', KEYS[1])
if not mapping then return 0 end
local parsed = cjson.decode(mapping)
if parsed.leaseKey ~= KEYS[2] or parsed.callId ~= ARGV[1] then return 0 end
if redis.call('GET', KEYS[2]) ~= parsed.leaseId then return 0 end
local ttl = tonumber(ARGV[3]) - tonumber(ARGV[2])
local claimed = redis.call('SET', KEYS[3], '1', 'EX', ttl, 'NX')
if not claimed then return 0 end
return 1`;


const transcriptEntrySchema = z.object({
  turnId: z.string().min(1).max(200),
  role: z.enum(["learner", "assistant"]),
  text: z.string().max(100_000),
  finalized: z.boolean(),
  interrupted: z.boolean().optional(),
  recordedAt: z.string().datetime(),
});

export interface TranscriptBatchEntry {
  operationId: string;
  entry: TranscriptEntry;
}

export interface FanoutBatchEntry {
  operationId: string;
  event: SessionEvent;
}
export interface RedisCommands {
  get(key: string): Promise<unknown>;
  set(key: string, value: string, options?: { ex?: number; nx?: boolean }): Promise<unknown>;
  del(...keys: string[]): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
  ttl(key: string): Promise<number>;
  rpush(key: string, ...values: string[]): Promise<number>;
  lrange(key: string, start: number, stop: number): Promise<unknown[]>;
  publish(channel: string, message: string): Promise<number>;
  eval(script: string, keys: string[], args: Array<string | number>): Promise<unknown>;
}

export interface RedisSessionStoreOptions {
  transcriptEncryptionKey: string;
  transcriptTtlSeconds?: number;
  activeStateTtlSeconds?: number;
  idempotencyTtlSeconds?: number;
}

export interface FanoutPage {
  events: SessionEvent[];
  cursor: number;
}
export interface SessionMutationCommit {
  scope: string;
  idempotencyKey: string;
  sessionId: string;
  expectedRevision: number;
  state: ActiveSessionState;
  response: unknown;
  attemptToken: string;
}
export interface SessionTerminalMutationCommit {
  scope: string;
  idempotencyKey: string;
  sessionId: string;
  expectedRevision: number | null;
  state: ActiveSessionState;
  response: unknown;
}
export type MutationAttemptReservation =
  | { status: "acquired"; attemptToken: string }
  | { status: "in_progress"; retryAfterSeconds: number }
  | { status: "completed"; response: unknown }
  | { status: "stale"; currentRevision: number }
  | { status: "terminal" };
export type SessionCreateResult =
  | { status: "created" }
  | { status: "completed"; response: unknown }
  | { status: "conflict" };

export interface VisualEntitlementRequest {
  learnerId: string;
  sessionId: string;
  durationSeconds: 5 | 10 | 15;
  dailyLimitSeconds: number;
  maxConcurrent: number;
  globalDailyLimitSeconds: number;
  leaseSeconds?: number;
}
export interface VisualEntitlementIdentity {
  learnerId: string;
  sessionId: string;
  reservationId: string;
  durationSeconds: 5 | 10 | 15;
}
export type VisualEntitlementResult =
  | { status: "reserved"; reservationId: string; leaseExpiresInSeconds: number; remainingSeconds: number }
  | { status: "active"; reservationId: string; leaseExpiresInSeconds: number; remainingSeconds: number }
  | { status: "pending"; reservationId: string; retryAfterSeconds: number; remainingSeconds: number }
  | { status: "conflict" | "concurrency_limit" | "daily_limit" | "global_limit"; remainingSeconds: number };
export interface VisualEntitlementReleaseResult {
  released: boolean;
  remainingSeconds: number;
}
export type RealtimeCallAdmission =
  | { allowed: true; leaseId: string }
  | {
    allowed: false;
    reason: "rate_limit" | "daily_limit" | "concurrency_limit" | "terminal";
    retryAfterSeconds: number;
  };
export interface ActiveRealtimeCall {
  commandRevision: number;
}
export interface GatewayTicketClaim {
  nonce: string;
  learnerId: string;
  sessionId: string;
  callId: string;
  expiresAtUnixSeconds: number;
}
export interface AnonymousAdmissionRequest {
  learnerId: string;
  networkId: string;
  globalLimit: number;
  networkLimit: number;
  windowSeconds: number;
}
export interface AnonymousAdmissionReleaseRequest {
  learnerId: string;
  networkId: string;
}
export type AnonymousAdmissionResult =
  | { allowed: true }
  | { allowed: false; reason: "global_limit" | "network_limit"; retryAfterSeconds: number };



function sessionKey(sessionId: string, suffix: string): string {
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(sessionId)) throw new Error("Invalid session identifier");
  return `axiom:session:${sessionId}:${suffix}`;
}

export function decodeRetainedPayloadKey(encoded: string): Buffer {
  const key = Buffer.from(encoded, "base64");
  if (key.length !== 32 || key.toString("base64") !== encoded) {
    throw new Error("TRANSCRIPT_ENCRYPTION_KEY must be a canonical base64-encoded 32-byte key");
  }
  return key;
}

export function encryptRetainedPayload(plaintext: string, key: Buffer, aad: string): string {
  if (!aad) throw new Error("Retained payload AAD is required");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return ["v2", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ciphertext.toString("base64url")].join(".");
}

export function decryptRetainedPayload(payload: string, key: Buffer, aad: string): string {
  if (!aad) throw new Error("Retained payload AAD is required");
  const [version, iv, tag, ciphertext, extra] = payload.split(".");
  if (version !== "v2" || !iv || !tag || !ciphertext || extra) throw new Error("Invalid encrypted retained payload");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
  decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64url")), decipher.final()]).toString("utf8");
}

function numberPair(value: unknown): [number, number] {
  if (!Array.isArray(value) || value.length !== 2) throw new Error("Unexpected Redis rate-limit response");
  const count = Number(value[0]);
  const ttl = Number(value[1]);
  if (!Number.isFinite(count) || !Number.isFinite(ttl)) throw new Error("Unexpected Redis rate-limit response");
  return [count, ttl];
}
function realtimeAdmissionResult(value: unknown): [number, number, string] {
  if (!Array.isArray(value) || value.length !== 3) throw new Error("Unexpected Redis realtime admission response");
  const status = Number(value[0]);
  const ttl = Number(value[1]);
  const leaseId = String(value[2]);
  if (!Number.isInteger(status) || !Number.isFinite(ttl)) {
    throw new Error("Unexpected Redis realtime admission response");
  }
  return [status, ttl, leaseId];
}

function rateLimitKey(subject: string, windowSeconds: number): string {
  const subjectKey = createHash("sha256").update(subject).digest("base64url");
  return sessionKey(subjectKey, `rate:${windowSeconds}`);
}

function serializeRetainedJson(value: unknown, label: string, rejectRawMediaKeys = false): string {
  const pending: Array<{ value: unknown; exiting: boolean; path: string }> = [
    { value, exiting: false, path: "$" },
  ];
  const active = new WeakMap<object, string>();
  const visited = new WeakSet<object>();
  while (pending.length) {
    const frame = pending.pop();
    const current = frame?.value;
    if (typeof current === "number" && !Number.isFinite(current)) {
      throw new Error(`${label} contains a non-finite number`);
    }
    if (current === undefined || typeof current === "bigint" || typeof current === "function" || typeof current === "symbol") {
      throw new Error(`${label} contains a non-JSON value`);
    }
    if (!current || typeof current !== "object") continue;
    if (frame?.exiting) {
      active.delete(current);
      visited.add(current);
      continue;
    }
    if (visited.has(current)) continue;
    const ancestorPath = active.get(current);
    if (ancestorPath) {
      throw new Error(`${label} contains an object cycle at ${frame.path} back to ${ancestorPath}`);
    }
    active.set(current, frame.path);
    pending.push({ value: current, exiting: true, path: frame.path });
    if (Array.isArray(current)) {
      for (let index = 0; index < current.length; index += 1) {
        pending.push({ value: current[index], exiting: false, path: `${frame.path}[${index}]` });
      }
      continue;
    }
    for (const [key, child] of Object.entries(current)) {
      if (rejectRawMediaKeys && /(?:raw)?(?:audio|video)(?:data|payload|bytes|blob|file)/i.test(key)) {
        throw new Error(`Raw media is not allowed in active-session state: ${key}`);
      }
      pending.push({ value: child, exiting: false, path: `${frame.path}.${key}` });
    }
  }
  const serialized = JSON.stringify(value);
  if (typeof serialized !== "string") throw new Error(`${label} must be JSON serializable`);
  if (Buffer.byteLength(serialized, "utf8") > 262_144) throw new Error(`${label} exceeds 256 KiB`);
  return serialized;
}

function serializeActiveState(state: ActiveSessionState): string {
  return serializeRetainedJson(state, "Active-session state", true);
}
function opaqueVisualKey(value: string): string {
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(value)) throw new Error("Invalid visual entitlement identifier");
  return createHash("sha256").update(value).digest("base64url");
}

function positiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
}

function visualResult(value: unknown): [number, string, number, number] {
  if (!Array.isArray(value) || value.length !== 4) throw new Error("Unexpected Redis visual entitlement response");
  const status = Number(value[0]);
  const reservationId = String(value[1]);
  const ttl = Number(value[2]);
  const remainingSeconds = Number(value[3]);
  if (!Number.isInteger(status) || !Number.isFinite(ttl) || !Number.isSafeInteger(remainingSeconds)) {
    throw new Error("Unexpected Redis visual entitlement response");
  }
  return [status, reservationId, ttl, remainingSeconds];
}
function authSessionKey(sessionId: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(sessionId)) {
    throw new Error("Invalid authentication session identifier");
  }
  return `axiom:auth:session:${createHash("sha256").update(sessionId).digest("base64url")}`;
}

export class RedisSessionStore {
  readonly transcriptTtlSeconds: number;
  readonly activeStateTtlSeconds: number;
  readonly idempotencyTtlSeconds: number;
  private readonly encryptionKey: Buffer;

  constructor(private readonly redis: RedisCommands, options: RedisSessionStoreOptions) {
    this.encryptionKey = decodeRetainedPayloadKey(options.transcriptEncryptionKey);
    this.transcriptTtlSeconds = Math.min(options.transcriptTtlSeconds ?? MAX_TRANSCRIPT_TTL_SECONDS, MAX_TRANSCRIPT_TTL_SECONDS);
    this.activeStateTtlSeconds = options.activeStateTtlSeconds ?? DEFAULT_ACTIVE_TTL_SECONDS;
    this.idempotencyTtlSeconds = options.idempotencyTtlSeconds ?? MAX_TRANSCRIPT_TTL_SECONDS;
    for (const ttl of [this.transcriptTtlSeconds, this.activeStateTtlSeconds, this.idempotencyTtlSeconds]) {
      if (!Number.isInteger(ttl) || ttl <= 0) throw new Error("Redis TTL values must be positive integers");
    }
  }

  async setActiveState(sessionId: string, state: ActiveSessionState): Promise<void> {
    if (!Number.isInteger(state.revision) || state.revision < 0) throw new Error("Active-session revision must be non-negative");
    const stateKey = sessionKey(sessionId, "state");
    const stateAad = `active-state|${sessionId}|${stateKey}`;
    const stored = await this.redis.eval(
      ACTIVE_STATE_SET_SCRIPT,
      [stateKey, sessionKey(sessionId, "revision"), sessionKey(sessionId, "terminal")],
      [this.encrypt(serializeActiveState(state), stateAad), state.revision, this.activeStateTtlSeconds],
    );
    if (Number(stored) !== 1) throw new Error("Terminal session state cannot be replaced");
  }

  async getActiveState<T extends ActiveSessionState = ActiveSessionState>(sessionId: string): Promise<T | null> {
    const stateKey = sessionKey(sessionId, "state");
    const value = await this.redis.eval(
      ACTIVE_STATE_GET_SCRIPT,
      [stateKey, sessionKey(sessionId, "revision")],
      [],
    );
    if (!Array.isArray(value) || value.length !== 2) throw new Error("Invalid active-session state response");
    if (value[0] === false || value[0] === null || value[0] === undefined) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(this.decrypt(String(value[0]), `active-state|${sessionId}|${stateKey}`));
    } catch {
      throw new Error("Invalid active-session state");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid active-session state");
    const candidate = parsed as Partial<ActiveSessionState>;
    const revision = Number(value[1]);
    if (!Number.isSafeInteger(revision) || revision < 0 || typeof candidate.status !== "string") {
      throw new Error("Invalid active-session state");
    }
    return { ...parsed, revision } as T;
  }

  async getSessionRevision(sessionId: string): Promise<number | null> {
    const value = await this.redis.get(sessionKey(sessionId, "revision"));
    if (value === null || value === undefined) return null;
    const revision = Number(value);
    if (!Number.isSafeInteger(revision) || revision < 0) throw new Error("Invalid active-session revision");
    return revision;
  }

  async deleteActiveState(sessionId: string): Promise<void> {
    await this.redis.del(sessionKey(sessionId, "state"), sessionKey(sessionId, "revision"));
  }

  async appendTranscript(sessionId: string, entry: TranscriptEntry): Promise<void> {
    const validated = transcriptEntrySchema.parse(entry);
    const transcriptKey = sessionKey(sessionId, "transcript");
    const aad = `transcript|${sessionId}|${transcriptKey}`;
    await this.redis.eval(
      TRANSCRIPT_APPEND_SCRIPT,
      [transcriptKey, sessionKey(sessionId, "terminal")],
      [this.encrypt(JSON.stringify(validated), aad), this.transcriptTtlSeconds],
    );
  }
  async appendTranscriptOnce(sessionId: string, operationId: string, entry: TranscriptEntry): Promise<void> {
    if (!/^[A-Za-z0-9._:-]{1,500}$/.test(operationId)) throw new Error("Invalid transcript operation identifier");
    const validated = transcriptEntrySchema.parse(entry);
    const marker = createHash("sha256").update(operationId).digest("base64url");
    const transcriptKey = sessionKey(sessionId, "transcript");
    const aad = `transcript|${sessionId}|${transcriptKey}`;
    await this.redis.eval(
      TRANSCRIPT_APPEND_ONCE_SCRIPT,
      [transcriptKey, sessionKey(sessionId, `transcript-effect:${marker}`), sessionKey(sessionId, "terminal")],
      [this.encrypt(JSON.stringify(validated), aad), this.transcriptTtlSeconds, this.idempotencyTtlSeconds],
    );
  }

  async appendTranscriptsOnce(sessionId: string, entries: readonly TranscriptBatchEntry[]): Promise<void> {
    if (entries.length === 0 || entries.length > 32) throw new Error("Transcript batch must contain between 1 and 32 entries");
    const transcriptKey = sessionKey(sessionId, "transcript");
    const aad = `transcript|${sessionId}|${transcriptKey}`;
    const markerKeys: string[] = [];
    const encryptedEntries: string[] = [];
    for (const item of entries) {
      if (!/^[A-Za-z0-9._:-]{1,500}$/.test(item.operationId)) {
        throw new Error("Invalid transcript operation identifier");
      }
      const marker = createHash("sha256").update(item.operationId).digest("base64url");
      markerKeys.push(sessionKey(sessionId, `transcript-effect:${marker}`));
      encryptedEntries.push(this.encrypt(JSON.stringify(transcriptEntrySchema.parse(item.entry)), aad));
    }
    await this.redis.eval(
      TRANSCRIPT_APPEND_MANY_ONCE_SCRIPT,
      [transcriptKey, sessionKey(sessionId, "terminal"), ...markerKeys],
      [this.transcriptTtlSeconds, this.idempotencyTtlSeconds, ...encryptedEntries],
    );
  }

  async readTranscript(sessionId: string): Promise<TranscriptEntry[]> {
    const transcriptKey = sessionKey(sessionId, "transcript");
    const values = await this.redis.lrange(transcriptKey, 0, -1);
    const aad = `transcript|${sessionId}|${transcriptKey}`;
    return values.map((value) => transcriptEntrySchema.parse(JSON.parse(this.decrypt(String(value), aad))));
  }

  async deleteTranscript(sessionId: string): Promise<void> {
    await this.redis.del(sessionKey(sessionId, "transcript"));
  }

  async claimIdempotencyKey(scope: string, idempotencyKey: string): Promise<boolean> {
    if (!/^[A-Za-z0-9._:-]{1,300}$/.test(idempotencyKey)) throw new Error("Invalid idempotency key");
    const result = await this.redis.set(sessionKey(scope, `idempotency:${idempotencyKey}`), "1", {
      ex: this.idempotencyTtlSeconds,
      nx: true,
    });
    return result === "OK" || result === true;
  }

  async isMutationEffectComplete(scope: string, idempotencyKey: string, effectId: string): Promise<boolean> {
    if (!/^[A-Za-z0-9._:-]{1,300}$/.test(idempotencyKey) || !/^[A-Za-z0-9._:-]{1,100}$/.test(effectId)) {
      throw new Error("Invalid mutation effect identifier");
    }
    const value = await this.redis.get(sessionKey(scope, `effect:${idempotencyKey}:${effectId}`));
    return value !== null && value !== undefined;
  }

  async markMutationEffectComplete(scope: string, idempotencyKey: string, effectId: string): Promise<void> {
    if (!/^[A-Za-z0-9._:-]{1,300}$/.test(idempotencyKey) || !/^[A-Za-z0-9._:-]{1,100}$/.test(effectId)) {

      throw new Error("Invalid mutation effect identifier");
    }
    await this.redis.set(sessionKey(scope, `effect:${idempotencyKey}:${effectId}`), "1", {
      ex: this.idempotencyTtlSeconds,
    });
  }
  async createSessionIfAbsent(
    sessionId: string,
    mutationId: string,
    initialState: ActiveSessionState,
    response: unknown,
  ): Promise<SessionCreateResult> {
    if (!/^[A-Za-z0-9._:-]{1,300}$/u.test(mutationId) || initialState.revision !== 0) {
      throw new Error("Invalid initial session mutation");
    }
    const stateKey = sessionKey(sessionId, "state");
    const completedKey = sessionKey(sessionId, `mutation:${mutationId}`);
    const result = await this.redis.eval(
      SESSION_CREATE_SCRIPT,
      [
        stateKey,
        sessionKey(sessionId, "revision"),
        sessionKey(sessionId, "terminal"),
        completedKey,
        sessionKey(sessionId, "mutation-index"),
      ],
      [
        this.encrypt(serializeActiveState(initialState), `active-state|${sessionId}|${stateKey}`),
        this.encrypt(serializeRetainedJson(response, "Mutation response"), `mutation-response|${sessionId}|${completedKey}`),
        this.activeStateTtlSeconds,
        this.idempotencyTtlSeconds,
      ],
    );
    if (!Array.isArray(result) || result.length !== 2) throw new Error("Unexpected session create response");
    const status = Number(result[0]);
    if (status === 1) return { status: "created" };
    if (status === 2) {
      return {
        status: "completed",
        response: JSON.parse(this.decrypt(String(result[1]), `mutation-response|${sessionId}|${completedKey}`)) as unknown,
      };
    }
    return { status: "conflict" };
  }

  async reserveMutationAttempt(
    sessionId: string,
    expectedRevision: number,
    mutationId: string,
  ): Promise<MutationAttemptReservation> {
    if (!/^[A-Za-z0-9._:-]{1,300}$/u.test(mutationId) || !Number.isInteger(expectedRevision) || expectedRevision < 0) {
      throw new Error("Invalid mutation attempt");
    }
    const completedKey = sessionKey(sessionId, `mutation:${mutationId}`);
    const attemptKey = sessionKey(sessionId, `attempt:${mutationId}`);
    const attemptToken = randomUUID();
    const result = await this.redis.eval(
      MUTATION_ATTEMPT_RESERVE_SCRIPT,
      [
        sessionKey(sessionId, "state"),
        sessionKey(sessionId, "revision"),
        sessionKey(sessionId, "terminal"),
        completedKey,
        attemptKey,
      ],
      [expectedRevision, attemptToken, 60],
    );
    if (!Array.isArray(result) || result.length !== 3) throw new Error("Unexpected mutation attempt response");
    const status = Number(result[0]);
    if (status === 1) return { status: "acquired", attemptToken: String(result[1]) };
    if (status === 2) return { status: "in_progress", retryAfterSeconds: Math.max(1, Number(result[2])) };
    if (status === 3) {
      const response = JSON.parse(this.decrypt(String(result[1]), `mutation-response|${sessionId}|${completedKey}`)) as unknown;
      return { status: "completed", response };
    }
    if (status === -2) return { status: "stale", currentRevision: Number(result[1]) };
    if (status === -3) return { status: "terminal" };
    throw new Error("Unexpected mutation attempt status");
  }

  async releaseMutationAttempt(sessionId: string, mutationId: string, attemptToken: string): Promise<boolean> {
    if (
      !/^[A-Za-z0-9._:-]{1,300}$/u.test(mutationId)
      || !/^[0-9a-f-]{36}$/iu.test(attemptToken)
    ) {
      throw new Error("Invalid mutation attempt release");
    }
    return Number(await this.redis.eval(
      MUTATION_ATTEMPT_RELEASE_SCRIPT,
      [sessionKey(sessionId, `attempt:${mutationId}`)],
      [attemptToken],
    )) === 1;
  }

  async readCommittedMutation(scope: string, idempotencyKey: string): Promise<unknown | null> {
    if (!/^[A-Za-z0-9._:-]{1,300}$/.test(idempotencyKey)) throw new Error("Invalid idempotency key");
    const mutationKey = sessionKey(scope, `mutation:${idempotencyKey}`);
    const value = await this.redis.get(mutationKey);
    if (value === null || value === undefined) return null;
    const parsed: unknown = JSON.parse(this.decrypt(String(value), `mutation-response|${scope}|${mutationKey}`));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Invalid retained mutation response");
    }
    return parsed;
  }

  async commitMutation(input: SessionMutationCommit): Promise<boolean> {
    this.validateMutationCommit(input);
    const serializedResponse = serializeRetainedJson(input.response, "Mutation response");
    const stateKey = sessionKey(input.sessionId, "state");
    const mutationKey = sessionKey(input.sessionId, `mutation:${input.idempotencyKey}`);
    const attemptKey = sessionKey(input.sessionId, `attempt:${input.idempotencyKey}`);
    const result = await this.redis.eval(
      SESSION_MUTATION_COMMIT_SCRIPT,
      [
        stateKey,
        mutationKey,
        sessionKey(input.sessionId, "revision"),
        sessionKey(input.sessionId, "mutation-index"),
        sessionKey(input.sessionId, "terminal"),
        attemptKey,
      ],
      [
        input.expectedRevision,
        this.encrypt(serializeActiveState(input.state), `active-state|${input.sessionId}|${stateKey}`),
        this.encrypt(serializedResponse, `mutation-response|${input.sessionId}|${mutationKey}`),
        input.state.revision,
        this.activeStateTtlSeconds,
        this.idempotencyTtlSeconds,
        input.attemptToken,
      ],
    );
    return Number(result) === 1;
  }

  async commitTerminalMutation(input: SessionTerminalMutationCommit): Promise<boolean> {
    this.validateMutationCommit(input);
    if (input.expectedRevision === null) throw new Error("Terminal mutation requires an expected revision");
    const serializedResponse = serializeRetainedJson(input.response, "Mutation response");
    const stateKey = sessionKey(input.sessionId, "state");
    const mutationKey = sessionKey(input.scope, `mutation:${input.idempotencyKey}`);
    const session = createHash("sha256").update(input.sessionId).digest("base64url");
    const result = await this.redis.eval(
      SESSION_TERMINAL_COMMIT_SCRIPT,
      [
        stateKey,
        mutationKey,
        sessionKey(input.sessionId, "revision"),
        sessionKey(input.sessionId, "terminal"),
        sessionKey(input.sessionId, "transcript"),
        sessionKey(input.sessionId, "events"),
        `axiom:realtime:session:${session}`,
        sessionKey(input.sessionId, "mutation-index"),
        `axiom:session-transcript:${input.sessionId}`,
        `axiom:session-state:${input.sessionId}`,
        `axiom:session:${input.sessionId}:gateway-state`,
        `axiom:visual:lease:${session}`,
      ],
      [
        input.expectedRevision,
        this.encrypt(serializeActiveState(input.state), `active-state|${input.sessionId}|${stateKey}`),
        this.encrypt(serializedResponse, `mutation-response|${input.scope}|${mutationKey}`),
        input.state.revision,
        this.activeStateTtlSeconds,
        this.idempotencyTtlSeconds,
        session,
      ],
    );
    return Number(result) === 1;
  }

  private validateMutationCommit(input: SessionTerminalMutationCommit): void {
    if (!/^[A-Za-z0-9._:-]{1,300}$/.test(input.idempotencyKey)) throw new Error("Invalid idempotency key");
    if (input.expectedRevision !== null && (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 0)) {
      throw new Error("Expected revision must be non-negative");
    }
    if (!Number.isInteger(input.state.revision) || input.state.revision < 0) {
      throw new Error("Active-session revision must be non-negative");
    }
  }

  async consumeRateLimit(subject: string, policy: RateLimitPolicy): Promise<RateLimitResult> {
    if (!Number.isInteger(policy.limit) || policy.limit <= 0) throw new Error("Rate-limit limit must be positive");
    if (!Number.isInteger(policy.windowSeconds) || policy.windowSeconds <= 0) throw new Error("Rate-limit window must be positive");
    const key = rateLimitKey(subject, policy.windowSeconds);
    const [count, ttl] = numberPair(await this.redis.eval(RATE_LIMIT_SCRIPT, [key], [policy.windowSeconds]));
    return {
      allowed: count <= policy.limit,
      remaining: Math.max(0, policy.limit - count),
      resetAfterSeconds: Math.max(0, ttl),
    };
  }
  async admitAnonymousLearner(input: AnonymousAdmissionRequest): Promise<AnonymousAdmissionResult> {
    if (!/^lrn_[A-Za-z0-9_-]{16,32}$/u.test(input.learnerId)) throw new Error("Invalid learner identifier");
    if (!input.networkId || input.networkId.length > 200) throw new Error("Invalid admission network identifier");
    positiveInteger(input.globalLimit, "Global anonymous admission limit");
    positiveInteger(input.networkLimit, "Network anonymous admission limit");
    positiveInteger(input.windowSeconds, "Anonymous admission window");
    const learner = createHash("sha256").update(input.learnerId).digest("base64url");
    const network = createHash("sha256").update(input.networkId).digest("base64url");
    const value = await this.redis.eval(
      ANONYMOUS_ADMISSION_SCRIPT,
      [
        `axiom:admission:anonymous:global`,
        `axiom:admission:anonymous:network:${network}`,
        `axiom:admission:learner-network:${learner}`,
      ],
      [input.globalLimit, input.networkLimit, input.windowSeconds, network, 604_800],
    );
    if (!Array.isArray(value) || value.length !== 2) throw new Error("Unexpected anonymous admission response");
    const status = Number(value[0]);
    const retryAfterSeconds = Math.max(1, Number(value[1]));
    if (status === 1) return { allowed: true };
    if (status === -1) return { allowed: false, reason: "global_limit", retryAfterSeconds };
    if (status === -2) return { allowed: false, reason: "network_limit", retryAfterSeconds };
    throw new Error("Unexpected anonymous admission status");
  }

  async releaseAnonymousLearner(input: AnonymousAdmissionReleaseRequest): Promise<void> {
    if (!/^lrn_[A-Za-z0-9_-]{16,32}$/u.test(input.learnerId)) throw new Error("Invalid learner identifier");
    if (!input.networkId || input.networkId.length > 200) throw new Error("Invalid admission network identifier");
    const learner = createHash("sha256").update(input.learnerId).digest("base64url");
    const network = createHash("sha256").update(input.networkId).digest("base64url");
    await this.redis.eval(
      ANONYMOUS_ADMISSION_RELEASE_SCRIPT,
      [
        "axiom:admission:anonymous:global",
        `axiom:admission:anonymous:network:${network}`,
        `axiom:admission:learner-network:${learner}`,
      ],
      [network],
    );
  }

  async reserveRealtimeCall(learnerId: string, sessionId: string, attemptId: string): Promise<RealtimeCallAdmission> {
    if (
      !/^lrn_[A-Za-z0-9_-]{16,32}$/u.test(learnerId)
      || !/^[0-9a-f-]{36}$/iu.test(sessionId)
      || !/^[A-Za-z0-9._:-]{8,200}$/u.test(attemptId)
    ) {
      throw new Error("Invalid realtime admission identity");
    }
    const learner = createHash("sha256").update(learnerId).digest("base64url");
    const leaseId = randomUUID();
    const leaseKey = `axiom:realtime:active:${learner}`;
    const attempt = createHash("sha256").update(attemptId).digest("base64url");
    const now = new Date();
    const day = now.toISOString().slice(0, 10).replaceAll("-", "");
    const nextDaySeconds = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1) / 1_000;
    const dayTtlSeconds = Math.max(1, Math.ceil(nextDaySeconds - now.getTime() / 1_000));
    const [status, ttl, reservedLeaseId] = realtimeAdmissionResult(await this.redis.eval(
      REALTIME_RESERVE_SCRIPT,
      [
        rateLimitKey(`realtime:daily:global:${day}`, 86_400),
        rateLimitKey(`realtime:minute:${learner}`, 60),
        rateLimitKey(`realtime:daily:${learner}:${day}`, 86_400),
        leaseKey,
        sessionKey(sessionId, "terminal"),
        `axiom:realtime:attempt:${attempt}`,
      ],
      [2_000, 5, 60, dayTtlSeconds, 60, leaseId, 3_900, sessionId, attemptId],
    ));
    if (status === 1 || status === 2) return { allowed: true, leaseId: reservedLeaseId };
    if (status === -1 || status === -3) {
      return {
        allowed: false,
        reason: "daily_limit",
        retryAfterSeconds: Math.max(1, ttl),
      };
    }
    if (status === -2) {
      return {
        allowed: false,
        reason: "rate_limit",
        retryAfterSeconds: Math.max(1, ttl),
      };
    }
    if (status === -4) {
      return {
        allowed: false,
        reason: "concurrency_limit",
        retryAfterSeconds: Math.max(1, ttl),
      };
    }
    if (status === -5) {
      return { allowed: false, reason: "terminal", retryAfterSeconds: Math.max(1, ttl) };
    }
    throw new Error("Unexpected Redis realtime admission status");
  }
  async replaceRealtimeCall(learnerId: string, sessionId: string, attemptId: string): Promise<RealtimeCallAdmission> {
    if (
      !/^lrn_[A-Za-z0-9_-]{16,32}$/u.test(learnerId)
      || !/^[0-9a-f-]{36}$/iu.test(sessionId)
      || !/^[A-Za-z0-9._:-]{8,200}$/u.test(attemptId)
    ) {
      throw new Error("Invalid realtime replacement identity");
    }
    const learner = createHash("sha256").update(learnerId).digest("base64url");
    const session = createHash("sha256").update(sessionId).digest("base64url");
    const attempt = createHash("sha256").update(attemptId).digest("base64url");
    const leaseId = randomUUID();
    const [status, ttl, reservedLeaseId] = realtimeAdmissionResult(await this.redis.eval(
      REALTIME_REPLACE_SCRIPT,
      [
        `axiom:realtime:active:${learner}`,
        sessionKey(sessionId, "terminal"),
        `axiom:realtime:attempt:${attempt}`,
        `axiom:realtime:session:${session}`,
      ],
      [leaseId, 3_900, sessionId, attemptId],
    ));
    if (status === 1 || status === 2) return { allowed: true, leaseId: reservedLeaseId };
    if (status === -5) return { allowed: false, reason: "terminal", retryAfterSeconds: Math.max(1, ttl) };
    return { allowed: false, reason: "concurrency_limit", retryAfterSeconds: Math.max(1, ttl) };
  }


  async activateRealtimeCall(learnerId: string, sessionId: string, leaseId: string, callId: string): Promise<boolean> {
    if (
      !/^lrn_[A-Za-z0-9_-]{16,32}$/u.test(learnerId)
      || !/^[0-9a-f-]{36}$/iu.test(leaseId)
      || !/^[0-9a-f-]{36}$/iu.test(sessionId)
      || !/^rtc_[A-Za-z0-9_-]{4,240}$/u.test(callId)
    ) {
      throw new Error("Invalid realtime activation");
    }
    const learner = createHash("sha256").update(learnerId).digest("base64url");
    const session = createHash("sha256").update(sessionId).digest("base64url");
    const leaseKey = `axiom:realtime:active:${learner}`;
    const mapping = JSON.stringify({ leaseKey, leaseId, callId });
    return Number(await this.redis.eval(
      REALTIME_ACTIVATE_SCRIPT,
      [leaseKey, `axiom:realtime:session:${session}`, sessionKey(sessionId, "terminal")],
      [leaseId, mapping],
    )) > 0;
  }

  async releaseRealtimeSession(sessionId: string): Promise<boolean> {
    if (!/^[0-9a-f-]{36}$/iu.test(sessionId)) throw new Error("Invalid realtime session");
    const session = createHash("sha256").update(sessionId).digest("base64url");
    return Number(await this.redis.eval(
      REALTIME_SESSION_RELEASE_SCRIPT,
      [`axiom:realtime:session:${session}`],
      [],
    )) === 1;
  }

  async releaseRealtimeCall(learnerId: string, leaseId: string): Promise<boolean> {
    if (
      !/^lrn_[A-Za-z0-9_-]{16,32}$/u.test(learnerId)
      || !/^[0-9a-f-]{36}$/iu.test(leaseId)
    ) {
      throw new Error("Invalid realtime admission lease");
    }
    const learner = createHash("sha256").update(learnerId).digest("base64url");
    return Number(await this.redis.eval(
      REALTIME_RELEASE_SCRIPT,
      [`axiom:realtime:active:${learner}`],
      [leaseId],
    )) === 1;
  }
  async isRealtimeCallActive(learnerId: string, sessionId: string, callId: string): Promise<boolean> {
    if (
      !/^lrn_[A-Za-z0-9_-]{16,32}$/u.test(learnerId)
      || !/^[0-9a-f-]{36}$/iu.test(sessionId)
      || !/^rtc_[A-Za-z0-9_-]{4,240}$/u.test(callId)
    ) {
      throw new Error("Invalid realtime call identity");
    }
    const learner = createHash("sha256").update(learnerId).digest("base64url");
    const session = createHash("sha256").update(sessionId).digest("base64url");
    return Number(await this.redis.eval(
      REALTIME_VERIFY_SCRIPT,
      [`axiom:realtime:session:${session}`, `axiom:realtime:active:${learner}`],
      [callId],
    )) === 1;
  }

  async getActiveRealtimeCall(
    learnerId: string,
    sessionId: string,
    callId: string,
  ): Promise<ActiveRealtimeCall | undefined> {
    if (
      !/^lrn_[A-Za-z0-9_-]{16,32}$/u.test(learnerId)
      || !/^[0-9a-f-]{36}$/iu.test(sessionId)
      || !/^rtc_[A-Za-z0-9_-]{4,240}$/u.test(callId)
    ) {
      throw new Error("Invalid realtime call identity");
    }
    const learner = createHash("sha256").update(learnerId).digest("base64url");
    const session = createHash("sha256").update(sessionId).digest("base64url");
    const result = await this.redis.eval(
      ACTIVE_REALTIME_CALL_SCRIPT,
      [
        `axiom:realtime:session:${session}`,
        `axiom:realtime:active:${learner}`,
        sessionKey(sessionId, "revision"),
        sessionKey(sessionId, "terminal"),
      ],
      [callId],
    );
    if (!Array.isArray(result) || result.length !== 2) throw new Error("Unexpected active realtime call response");
    if (Number(result[0]) !== 1) return undefined;
    const commandRevision = Number(result[1]);
    if (!Number.isSafeInteger(commandRevision) || commandRevision < 0) {
      throw new Error("Invalid active realtime command revision");
    }
    return { commandRevision };
  }

  async claimGatewayTicket(input: GatewayTicketClaim, nowUnixSeconds: number): Promise<boolean> {
    if (
      !/^[A-Za-z0-9_-]{16,200}$/u.test(input.nonce)
      || !/^lrn_[A-Za-z0-9_-]{16,32}$/u.test(input.learnerId)
      || !/^[0-9a-f-]{36}$/iu.test(input.sessionId)
      || !/^rtc_[A-Za-z0-9_-]{4,240}$/u.test(input.callId)
      || !Number.isSafeInteger(input.expiresAtUnixSeconds)
      || !Number.isSafeInteger(nowUnixSeconds)
      || nowUnixSeconds < 0
    ) {
      throw new Error("Invalid gateway ticket claim");
    }
    const learner = createHash("sha256").update(input.learnerId).digest("base64url");
    const session = createHash("sha256").update(input.sessionId).digest("base64url");
    const nonce = createHash("sha256").update(input.nonce).digest("base64url");
    return Number(await this.redis.eval(
      GATEWAY_TICKET_CLAIM_SCRIPT,
      [
        `axiom:realtime:session:${session}`,
        `axiom:realtime:active:${learner}`,
        `axiom:gateway:ticket-nonce:${nonce}`,
        sessionKey(input.sessionId, "terminal"),
      ],
      [input.callId, nowUnixSeconds, input.expiresAtUnixSeconds],
    )) === 1;
  }

  async reserveVisualEntitlement(input: VisualEntitlementRequest): Promise<VisualEntitlementResult> {
    positiveInteger(input.dailyLimitSeconds, "Daily visual limit");
    positiveInteger(input.maxConcurrent, "Visual concurrency limit");
    positiveInteger(input.globalDailyLimitSeconds, "Global daily visual limit");
    const leaseSeconds = input.leaseSeconds ?? 60;
    positiveInteger(leaseSeconds, "Visual lease duration");
    if (![5, 10, 15].includes(input.durationSeconds)) throw new Error("Invalid visual duration");
    const learner = opaqueVisualKey(input.learnerId);
    const session = opaqueVisualKey(input.sessionId);
    const nowSeconds = Math.floor(Date.now() / 1_000);
    const now = new Date(nowSeconds * 1_000);
    const day = now.toISOString().slice(0, 10).replaceAll("-", "");
    const nextDay = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1) / 1_000;
    const dayTtl = Math.max(1, nextDay - nowSeconds);
    const reservationId = randomUUID();
    const [status, id, ttl, remainingSeconds] = visualResult(await this.redis.eval(
      VISUAL_RESERVE_SCRIPT,
      [
        `axiom:visual:lease:${session}`,
        `axiom:visual:active:${learner}`,
        `axiom:visual:daily:${learner}:${day}`,
        `axiom:visual:daily:global:${day}`,
        sessionKey(input.sessionId, "terminal"),
      ],
      [
        learner,
        input.durationSeconds,
        nowSeconds,
        input.maxConcurrent,
        input.dailyLimitSeconds,
        dayTtl,
        reservationId,
        leaseSeconds,
        session,
        input.globalDailyLimitSeconds,
        day,
        15,
      ],
    ));
    if (status === 1) return { status: "reserved", reservationId: id, leaseExpiresInSeconds: ttl, remainingSeconds };
    if (status === 2) return { status: "active", reservationId: id, leaseExpiresInSeconds: ttl, remainingSeconds };
    if (status === 3) {
      return { status: "pending", reservationId: id, retryAfterSeconds: Math.max(1, ttl), remainingSeconds };
    }
    if (status === -1) return { status: "conflict", remainingSeconds };
    if (status === -2) return { status: "concurrency_limit", remainingSeconds };
    if (status === -3) return { status: "daily_limit", remainingSeconds };
    if (status === -4) return { status: "global_limit", remainingSeconds };
    throw new Error("Unexpected Redis visual entitlement status");
  }

  async commitVisualEntitlement(sessionId: string, reservationId: string): Promise<boolean> {
    const session = opaqueVisualKey(sessionId);
    if (!reservationId) throw new Error("Visual reservation is required");
    const result = Number(await this.redis.eval(
      VISUAL_COMMIT_SCRIPT,
      [`axiom:visual:lease:${session}`, sessionKey(sessionId, "terminal")],
      [reservationId],
    ));
    return Number.isFinite(result) && result > 0;
  }

  async verifyVisualEntitlement(input: VisualEntitlementIdentity): Promise<boolean> {
    const learner = opaqueVisualKey(input.learnerId);
    const session = opaqueVisualKey(input.sessionId);
    return Number(await this.redis.eval(
      VISUAL_VERIFY_SCRIPT,
      [`axiom:visual:lease:${session}`],
      [learner, input.reservationId, input.durationSeconds],
    )) === 1;
  }

  async claimVisualEntitlement(input: VisualEntitlementIdentity): Promise<boolean> {
    const learner = opaqueVisualKey(input.learnerId);
    const session = opaqueVisualKey(input.sessionId);
    return Number(await this.redis.eval(
      VISUAL_CLAIM_SCRIPT,
      [`axiom:visual:lease:${session}`],
      [learner, input.reservationId, input.durationSeconds],
    )) === 1;
  }

  async claimVisualIcePermit(input: VisualEntitlementIdentity, fallback: boolean): Promise<boolean> {
    const learner = opaqueVisualKey(input.learnerId);
    const session = opaqueVisualKey(input.sessionId);
    return Number(await this.redis.eval(
      VISUAL_ICE_PERMIT_SCRIPT,
      [`axiom:visual:lease:${session}`],
      [learner, input.reservationId, input.durationSeconds, fallback ? "fallback" : "primary"],
    )) === 1;
  }

  async allowVisualIceFallback(input: VisualEntitlementIdentity): Promise<boolean> {
    const learner = opaqueVisualKey(input.learnerId);
    const session = opaqueVisualKey(input.sessionId);
    return Number(await this.redis.eval(
      VISUAL_ICE_FALLBACK_SCRIPT,
      [`axiom:visual:lease:${session}`],
      [learner, input.reservationId, input.durationSeconds],
    )) === 1;
  }

  async bindVisualProviderSession(
    input: VisualEntitlementIdentity,
    providerSessionId: string,
    deadlineMs: number,
  ): Promise<boolean> {
    if (!/^[A-Za-z0-9_-]{1,200}$/u.test(providerSessionId)) throw new Error("Invalid visual provider session");
    if (!Number.isSafeInteger(deadlineMs) || deadlineMs <= Date.now()) throw new Error("Invalid visual deadline");
    const learner = opaqueVisualKey(input.learnerId);
    const session = opaqueVisualKey(input.sessionId);
    return Number(await this.redis.eval(
      VISUAL_BIND_SCRIPT,
      [`axiom:visual:lease:${session}`],
      [learner, input.reservationId, input.durationSeconds, providerSessionId, deadlineMs],
    )) === 1;
  }

  async verifyVisualProviderSession(
    input: VisualEntitlementIdentity,
    providerSessionId: string,
  ): Promise<boolean> {
    if (!/^[A-Za-z0-9_-]{1,200}$/u.test(providerSessionId)) return false;
    const learner = opaqueVisualKey(input.learnerId);
    const session = opaqueVisualKey(input.sessionId);
    return Number(await this.redis.eval(
      VISUAL_PROVIDER_VERIFY_SCRIPT,
      [`axiom:visual:lease:${session}`],
      [learner, input.reservationId, input.durationSeconds, providerSessionId],
    )) === 1;
  }

  async claimVisualHeartbeat(
    input: VisualEntitlementIdentity,
    providerSessionId: string,
    nowMs: number,
    minimumIntervalMs: number,
  ): Promise<boolean> {
    const learner = opaqueVisualKey(input.learnerId);
    const session = opaqueVisualKey(input.sessionId);
    return Number(await this.redis.eval(
      VISUAL_HEARTBEAT_CLAIM_SCRIPT,
      [`axiom:visual:lease:${session}`],
      [learner, input.reservationId, input.durationSeconds, providerSessionId, nowMs, minimumIntervalMs],
    )) === 1;
  }

  async completeVisualHeartbeat(
    input: VisualEntitlementIdentity,
    providerSessionId: string,
    nowMs: number,
  ): Promise<void> {
    const learner = opaqueVisualKey(input.learnerId);
    const session = opaqueVisualKey(input.sessionId);
    await this.redis.eval(
      VISUAL_HEARTBEAT_COMPLETE_SCRIPT,
      [`axiom:visual:lease:${session}`],
      [learner, input.reservationId, providerSessionId, nowMs],
    );
  }

  async releaseVisualEntitlement(
    learnerId: string,
    sessionId: string,
    reservationId: string,
    rollbackCharge = false,
    dailyLimitSeconds = 120,
  ): Promise<VisualEntitlementReleaseResult> {
    positiveInteger(dailyLimitSeconds, "Daily visual limit");
    const learner = opaqueVisualKey(learnerId);
    const session = opaqueVisualKey(sessionId);
    const now = new Date();
    const day = now.toISOString().slice(0, 10).replaceAll("-", "");
    const previous = new Date(now.getTime() - 86_400_000)
      .toISOString()
      .slice(0, 10)
      .replaceAll("-", "");
    const result = await this.redis.eval(
      VISUAL_RELEASE_SCRIPT,
      [
        `axiom:visual:lease:${session}`,
        `axiom:visual:active:${learner}`,
        `axiom:visual:daily:${learner}:${day}`,
        `axiom:visual:daily:global:${day}`,
        `axiom:visual:daily:${learner}:${previous}`,
        `axiom:visual:daily:global:${previous}`,
      ],
      [learner, reservationId, session, rollbackCharge ? 1 : 0, dailyLimitSeconds, day],
    );
    if (!Array.isArray(result) || result.length !== 2) throw new Error("Unexpected visual release response");
    const remainingSeconds = Number(result[1]);
    if (!Number.isSafeInteger(remainingSeconds) || remainingSeconds < 0) {
      throw new Error("Unexpected visual release allowance");
    }
    return { released: Number(result[0]) === 1, remainingSeconds };
  }

  async getVisualDailyRemaining(learnerId: string, dailyLimitSeconds: number): Promise<number> {
    positiveInteger(dailyLimitSeconds, "Daily visual limit");
    const learner = opaqueVisualKey(learnerId);
    const day = new Date().toISOString().slice(0, 10).replaceAll("-", "");
    const remainingSeconds = Number(await this.redis.eval(
      VISUAL_ALLOWANCE_SCRIPT,
      [`axiom:visual:daily:${learner}:${day}`],
      [dailyLimitSeconds],
    ));
    if (!Number.isSafeInteger(remainingSeconds) || remainingSeconds < 0) {
      throw new Error("Unexpected visual allowance response");
    }
    return remainingSeconds;
  }
  async createAuthSession(sessionId: string, learnerId: string, ttlSeconds = 604_800): Promise<void> {
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(learnerId)) throw new Error("Invalid learner identifier");
    if (!Number.isInteger(ttlSeconds) || ttlSeconds <= 0 || ttlSeconds > 604_800) {
      throw new Error("Authentication session TTL must be between 1 second and 7 days");
    }
    await this.redis.set(authSessionKey(sessionId), learnerId, { ex: ttlSeconds });
  }

  async getAuthSessionLearner(sessionId: string): Promise<string | null> {
    const value = await this.redis.get(authSessionKey(sessionId));
    return value === null || value === undefined ? null : String(value);
  }

  async revokeAuthSession(sessionId: string): Promise<void> {
    await this.redis.del(authSessionKey(sessionId));
  }

  async acquireEventStreamLease(sessionId: string, leaseId: string, ttlSeconds: number): Promise<boolean> {
    if (!/^[0-9a-f-]{36}$/iu.test(leaseId)) throw new Error("Invalid event stream lease");
    positiveInteger(ttlSeconds, "Event stream lease duration");
    return Number(await this.redis.eval(
      EVENT_STREAM_LEASE_ACQUIRE_SCRIPT,
      [sessionKey(sessionId, "event-stream-lease")],
      [leaseId, ttlSeconds],
    )) === 1;
  }

  async releaseEventStreamLease(sessionId: string, leaseId: string): Promise<boolean> {
    if (!/^[0-9a-f-]{36}$/iu.test(leaseId)) throw new Error("Invalid event stream lease");
    return Number(await this.redis.eval(
      EVENT_STREAM_LEASE_RELEASE_SCRIPT,
      [sessionKey(sessionId, "event-stream-lease")],
      [leaseId],
    )) === 1;
  }

  async publish(sessionId: string, event: SessionEvent): Promise<void> {
    const channel = sessionKey(sessionId, "events");
    const message = JSON.stringify(sessionEventSchema.parse(event));
    const aad = `fanout-event|${sessionId}|${channel}`;
    const encrypted = this.encrypt(message, aad);
    await this.redis.eval(FANOUT_SCRIPT, [channel, sessionKey(sessionId, "terminal")], [encrypted, FANOUT_TTL_SECONDS, encrypted]);
  }

  async readFanout(sessionId: string, cursor = 0, limit = 100): Promise<FanoutPage> {
    if (!Number.isInteger(cursor) || cursor < 0) throw new Error("Fan-out cursor must be a non-negative integer");
    if (!Number.isInteger(limit) || limit <= 0 || limit > 200) throw new Error("Fan-out limit must be between 1 and 200");
    const channel = sessionKey(sessionId, "events");
    const raw = await this.redis.lrange(channel, cursor, cursor + limit - 1);
    const aad = `fanout-event|${sessionId}|${channel}`;
    return {
      events: raw.map((value) => sessionEventSchema.parse(JSON.parse(this.decrypt(String(value), aad)))),
      cursor: cursor + raw.length,
    };
  }
  async publishOnce(sessionId: string, operationId: string, event: SessionEvent): Promise<void> {
    if (!/^[A-Za-z0-9._:-]{1,500}$/.test(operationId)) throw new Error("Invalid fanout operation identifier");
    const channel = sessionKey(sessionId, "events");
    const marker = createHash("sha256").update(operationId).digest("base64url");
    const message = JSON.stringify(sessionEventSchema.parse(event));
    const encrypted = this.encrypt(message, `fanout-event|${sessionId}|${channel}`);
    await this.redis.eval(
      FANOUT_ONCE_SCRIPT,
      [channel, sessionKey(sessionId, `fanout-effect:${marker}`), sessionKey(sessionId, "terminal")],
      [encrypted, FANOUT_TTL_SECONDS, encrypted, this.idempotencyTtlSeconds],
    );
  }

  async publishManyOnce(sessionId: string, entries: readonly FanoutBatchEntry[]): Promise<void> {
    if (entries.length === 0 || entries.length > 32) throw new Error("Fanout batch must contain between 1 and 32 entries");
    const channel = sessionKey(sessionId, "events");
    const aad = `fanout-event|${sessionId}|${channel}`;
    const markerKeys: string[] = [];
    const encryptedEvents: string[] = [];
    for (const item of entries) {
      if (!/^[A-Za-z0-9._:-]{1,500}$/.test(item.operationId)) {
        throw new Error("Invalid fanout operation identifier");
      }
      const marker = createHash("sha256").update(item.operationId).digest("base64url");
      markerKeys.push(sessionKey(sessionId, `fanout-effect:${marker}`));
      const message = JSON.stringify(sessionEventSchema.parse(item.event));
      encryptedEvents.push(this.encrypt(message, aad));
    }
    await this.redis.eval(
      FANOUT_MANY_ONCE_SCRIPT,
      [channel, sessionKey(sessionId, "terminal"), ...markerKeys],
      [FANOUT_TTL_SECONDS, this.idempotencyTtlSeconds, ...encryptedEvents],
    );
  }

  async deleteFanout(sessionId: string): Promise<void> {
    await this.redis.del(sessionKey(sessionId, "events"));
  }

  private encrypt(plaintext: string, aad: string): string {
    return encryptRetainedPayload(plaintext, this.encryptionKey, aad);
  }

  private decrypt(payload: string, aad: string): string {
    return decryptRetainedPayload(payload, this.encryptionKey, aad);
  }
}

export { MAX_TRANSCRIPT_TTL_SECONDS };
