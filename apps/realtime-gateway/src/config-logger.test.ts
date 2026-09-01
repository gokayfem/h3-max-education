import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "./config.js";
import { SafeLogger } from "./logger.js";

afterEach(() => vi.restoreAllMocks());

describe("loadConfig", () => {
  it("loads explicit production settings and Fly region", () => {
    expect(loadConfig({
      NODE_ENV: "production",
      PORT: "9000",
      GATEWAY_AUTH_SECRET: "x".repeat(32),
      WEB_ORIGIN: "https://science.example",
      OPENAI_API_KEY: "key",
      REDIS_URL: "rediss://localhost:6379",
      TRANSCRIPT_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
      DATABASE_URL: "postgresql://user:pass@localhost:5432/axiom",
      FLY_REGION: "iad"
    })).toEqual(expect.objectContaining({
      environment: "production",
      port: 9000,
      region: "iad",
      authSecret: "x".repeat(32),
    }));
  });

  it("ignores the web-only session secret and uses deterministic local gateway auth", () => {
    const config = loadConfig({ SESSION_SECRET: "short" });
    expect(config).toEqual(expect.objectContaining({
      port: 8_787,
      region: "local",
      openAiRealtimeModel: "gpt-realtime-2.1",
      openAiTextModel: "gpt-4.1-mini"
    }));
  });

  it("fails closed for missing production auth, origin, Redis, database, or malformed input", () => {
    const base = {
      NODE_ENV: "production",
      GATEWAY_AUTH_SECRET: "x".repeat(32),
      WEB_ORIGIN: "https://science.example",
      OPENAI_API_KEY: "key",
      REDIS_URL: "rediss://localhost:6379",
      TRANSCRIPT_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
      DATABASE_URL: "postgresql://user:pass@localhost:5432/axiom"
    };
    expect(() => loadConfig({
      ...base,
      GATEWAY_AUTH_SECRET: undefined,
    })).toThrow("GATEWAY_AUTH_SECRET");
    expect(() => loadConfig({ ...base, WEB_ORIGIN: undefined })).toThrow("WEB_ORIGIN");
    expect(() => loadConfig({ ...base, REDIS_URL: undefined })).toThrow("REDIS_URL");
    expect(() => loadConfig({ ...base, DATABASE_URL: undefined })).toThrow("DATABASE_URL");
    expect(() => loadConfig({ ...base, OPENAI_API_KEY: undefined })).toThrow("OPENAI_API_KEY");
    expect(() => loadConfig({ ...base, REDIS_URL: "redis://localhost:6379" })).toThrow("rediss://");
    expect(() => loadConfig({ ...base, TRANSCRIPT_ENCRYPTION_KEY: undefined })).toThrow("TRANSCRIPT_ENCRYPTION_KEY");
    expect(() => loadConfig({ ...base, WEB_ORIGIN: "http://science.example" })).toThrow("HTTPS origin");
    expect(() => loadConfig({ ...base, WEB_ORIGIN: "https://user:pass@science.example" })).toThrow("exact origin");
    expect(() => loadConfig({ ...base, WEB_ORIGIN: "https://science.example/path" })).toThrow("exact origin");
    expect(() => loadConfig({ ...base, WEB_ORIGIN: "ftp://science.example" })).toThrow("HTTP(S) origin");
    expect(() => loadConfig({ ...base, METRICS_AUTH_TOKEN: "short" })).toThrow("METRICS_AUTH_TOKEN");
  });
});

describe("SafeLogger", () => {
  it("writes bounded structured operational metadata to the expected stream", () => {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const logger = new SafeLogger("iad");
    logger.write("info", "Gateway listening", { event: "ready", provider: "gateway" });
    logger.write("error", "Provider unavailable", { code: "provider_error", recoverable: true });

    const info = JSON.parse(String(stdout.mock.calls[0]?.[0]));
    const error = JSON.parse(String(stderr.mock.calls[0]?.[0]));
    expect(info).toEqual(expect.objectContaining({ level: "info", region: "iad", event: "ready" }));
    expect(error).toEqual(expect.objectContaining({ level: "error", code: "provider_error", recoverable: true }));
    expect(JSON.stringify([info, error])).not.toContain("OPENAI_API_KEY");
  });
});
