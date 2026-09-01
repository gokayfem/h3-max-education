import { z } from "zod";
const DEVELOPMENT_GATEWAY_AUTH_SECRET =
  "axiom-local-development-gateway-secret-change-me";

const environmentSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65_535).default(8_787),
  GATEWAY_AUTH_SECRET: z.string().min(32).optional(),
  WEB_ORIGIN: z.string().url().superRefine((value, context) => {
    const origin = new URL(value);
    if (origin.protocol !== "http:" && origin.protocol !== "https:") {
      context.addIssue({ code: "custom", message: "WEB_ORIGIN must be an HTTP(S) origin" });
    }
    if (
      value !== origin.origin
      || origin.username
      || origin.password
      || origin.pathname !== "/"
      || origin.search
      || origin.hash
    ) {
      context.addIssue({ code: "custom", message: "WEB_ORIGIN must be an exact origin without credentials, path, query, or fragment" });
    }
  }).optional(),
  OPENAI_API_KEY: z.string().min(1).optional(),
  OPENAI_REALTIME_MODEL: z.string().min(1).default("gpt-realtime-2.1"),
  OPENAI_TEXT_MODEL: z.string().min(1).default("gpt-4.1-mini"),
  REDIS_URL: z.string().url().optional(),
  TRANSCRIPT_ENCRYPTION_KEY: z.string().refine((value) => {
    const decoded = Buffer.from(value, "base64");
    return decoded.length === 32 && decoded.toString("base64") === value;
  }, "TRANSCRIPT_ENCRYPTION_KEY must be a canonical base64-encoded 32-byte key").optional(),
  DATABASE_URL: z.string().url().refine(
    (value) => value.startsWith("postgres://") || value.startsWith("postgresql://"),
    "DATABASE_URL must use postgres:// or postgresql://"
  ).optional(),
  MAX_ACTIVE_SESSIONS_PER_LEARNER: z.coerce.number().int().min(1).max(10).default(2),
  MAX_PAID_COMMANDS_PER_LEARNER: z.coerce.number().int().min(1).max(1_000).default(24),
  SESSION_IDLE_TIMEOUT_MS: z.coerce.number().int().min(10_000).max(86_400_000).default(300_000),
  ACTIVE_TRANSCRIPT_TTL_SECONDS: z.coerce.number().int().min(60).max(86_400).default(86_400),
  FLY_REGION: z.string().min(1).optional(),
  REGION: z.string().min(1).optional()
});

export interface GatewayConfig {
  readonly environment: "development" | "test" | "production";
  readonly port: number;
  readonly authSecret: string;
  readonly webOrigin?: string;
  readonly openAiApiKey?: string;
  readonly openAiRealtimeModel: string;
  readonly openAiTextModel: string;
  readonly redisUrl?: string;
  readonly transcriptEncryptionKey?: string;
  readonly databaseUrl?: string;
  readonly maxActiveSessionsPerLearner: number;
  readonly maxPaidCommandsPerLearner: number;
  readonly sessionIdleTimeoutMs?: number;
  readonly activeTranscriptTtlSeconds?: number;
  readonly region: string;
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const parsed = environmentSchema.parse(environment);
  const authSecret = parsed.GATEWAY_AUTH_SECRET
    ?? (parsed.NODE_ENV === "production" ? undefined : DEVELOPMENT_GATEWAY_AUTH_SECRET);
  if (!authSecret) {
    throw new Error("GATEWAY_AUTH_SECRET is required");
  }
  if (parsed.NODE_ENV === "production" && !parsed.WEB_ORIGIN) {
    throw new Error("WEB_ORIGIN is required in production");
  }
  if (parsed.NODE_ENV === "production" && parsed.WEB_ORIGIN && !parsed.WEB_ORIGIN.startsWith("https://")) {
    throw new Error("Production WEB_ORIGIN must be an HTTPS origin");
  }
  if (parsed.NODE_ENV === "production" && !parsed.REDIS_URL) {
    throw new Error("REDIS_URL is required in production");
  }
  if (parsed.NODE_ENV === "production" && !parsed.REDIS_URL?.startsWith("rediss://")) {
    throw new Error("Production REDIS_URL must use rediss://");
  }
  if (parsed.NODE_ENV === "production" && !parsed.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is required in production");
  }
  if (parsed.NODE_ENV === "production" && !parsed.TRANSCRIPT_ENCRYPTION_KEY) {
    throw new Error("TRANSCRIPT_ENCRYPTION_KEY is required in production");
  }
  if (parsed.NODE_ENV === "production" && !parsed.DATABASE_URL) {
    throw new Error("DATABASE_URL is required in production");
  }
  return {
    environment: parsed.NODE_ENV,
    port: parsed.PORT,
    authSecret,
    webOrigin: parsed.WEB_ORIGIN,
    openAiApiKey: parsed.OPENAI_API_KEY,
    openAiRealtimeModel: parsed.OPENAI_REALTIME_MODEL,
    openAiTextModel: parsed.OPENAI_TEXT_MODEL,
    redisUrl: parsed.REDIS_URL,
    transcriptEncryptionKey: parsed.TRANSCRIPT_ENCRYPTION_KEY,
    databaseUrl: parsed.DATABASE_URL,
    maxActiveSessionsPerLearner: parsed.MAX_ACTIVE_SESSIONS_PER_LEARNER,
    maxPaidCommandsPerLearner: parsed.MAX_PAID_COMMANDS_PER_LEARNER,
    sessionIdleTimeoutMs: parsed.SESSION_IDLE_TIMEOUT_MS,
    activeTranscriptTtlSeconds: parsed.ACTIVE_TRANSCRIPT_TTL_SECONDS,
    region: parsed.FLY_REGION ?? parsed.REGION ?? "local"
  };
}
