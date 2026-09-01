import { neon } from "@neondatabase/serverless";
import { Redis } from "@upstash/redis";
import { z } from "zod";
import { PostgresLearningRepository, type SqlExecutor } from "./postgres";
import { RedisSessionStore, type RedisCommands } from "./redis";

const environmentSchema = z.object({
  DATABASE_URL: z.string().url().refine((value) => value.startsWith("postgres://") || value.startsWith("postgresql://"), "DATABASE_URL must use postgres:// or postgresql://"),
  UPSTASH_REDIS_REST_URL: z.string().url().refine((value) => value.startsWith("https://"), "UPSTASH_REDIS_REST_URL must use HTTPS"),
  UPSTASH_REDIS_REST_TOKEN: z.string().min(1),
  TRANSCRIPT_ENCRYPTION_KEY: z.string().refine((value) => {
    const decoded = Buffer.from(value, "base64");
    return decoded.length === 32 && decoded.toString("base64") === value;
  }, "TRANSCRIPT_ENCRYPTION_KEY must be a canonical base64-encoded 32-byte key"),
  ACTIVE_TRANSCRIPT_TTL_SECONDS: z.coerce.number().int().positive().optional(),
});

export type PersistenceEnvironment = z.infer<typeof environmentSchema>;

export function parsePersistenceEnvironment(environment: NodeJS.ProcessEnv = process.env): PersistenceEnvironment {
  return environmentSchema.parse(environment);
}

type ParameterizedQuery = (
  text: string,
  parameters: readonly unknown[],
) => Promise<readonly Record<string, unknown>[]>;

export class NeonSqlExecutor implements SqlExecutor {
  private readonly execute: ParameterizedQuery;

  constructor(databaseUrl: string) {
    const sql = neon(databaseUrl);
    this.execute = async (text, parameters) =>
      sql.query(text, [...parameters]) as Promise<Record<string, unknown>[]>;
  }

  async query<Row extends Record<string, unknown>>(text: string, parameters: readonly unknown[]): Promise<readonly Row[]> {
    return this.execute(text, parameters) as Promise<readonly Row[]>;
  }
}

export class UpstashRedisCommands implements RedisCommands {
  private readonly client: Redis;

  constructor(url: string, token: string) {
    this.client = new Redis({ url, token, automaticDeserialization: false });
  }

  async get(key: string): Promise<unknown> { return this.client.get(key); }
  async set(key: string, value: string, options?: { ex?: number; nx?: boolean }): Promise<unknown> {
    if (options?.nx) {
      return this.client.set(key, value, options.ex ? { ex: options.ex, nx: true } : { nx: true });
    }
    return options?.ex ? this.client.set(key, value, { ex: options.ex }) : this.client.set(key, value);
  }
  async del(...keys: string[]): Promise<number> { return this.client.del(...keys); }
  async expire(key: string, seconds: number): Promise<number> { return this.client.expire(key, seconds); }
  async ttl(key: string): Promise<number> { return this.client.ttl(key); }
  async rpush(key: string, ...values: string[]): Promise<number> { return this.client.rpush(key, ...values); }
  async lrange(key: string, start: number, stop: number): Promise<unknown[]> { return this.client.lrange(key, start, stop); }
  async publish(channel: string, message: string): Promise<number> { return this.client.publish(channel, message); }
  async eval(script: string, keys: string[], args: Array<string | number>): Promise<unknown> {
    return this.client.eval(script, keys, args.map(String));
  }
}

export function createPostgresLearningRepository(databaseUrl: string): PostgresLearningRepository {
  const parsed = environmentSchema.shape.DATABASE_URL.parse(databaseUrl);
  return new PostgresLearningRepository(new NeonSqlExecutor(parsed));
}

export function createRedisSessionStore(environment: Pick<PersistenceEnvironment, "UPSTASH_REDIS_REST_URL" | "UPSTASH_REDIS_REST_TOKEN" | "TRANSCRIPT_ENCRYPTION_KEY" | "ACTIVE_TRANSCRIPT_TTL_SECONDS">): RedisSessionStore {
  const parsed = environmentSchema.pick({
    UPSTASH_REDIS_REST_URL: true,
    UPSTASH_REDIS_REST_TOKEN: true,
    TRANSCRIPT_ENCRYPTION_KEY: true,
    ACTIVE_TRANSCRIPT_TTL_SECONDS: true,
  }).parse(environment);
  return new RedisSessionStore(
    new UpstashRedisCommands(parsed.UPSTASH_REDIS_REST_URL, parsed.UPSTASH_REDIS_REST_TOKEN),
    {
      transcriptEncryptionKey: parsed.TRANSCRIPT_ENCRYPTION_KEY,
      ...(parsed.ACTIVE_TRANSCRIPT_TTL_SECONDS === undefined
        ? {}
        : { transcriptTtlSeconds: parsed.ACTIVE_TRANSCRIPT_TTL_SECONDS }),
    },
  );
}
