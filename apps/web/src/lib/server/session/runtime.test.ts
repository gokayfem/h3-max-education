import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const runtimeKey = Symbol.for("axiom.persistence.runtime");

describe("session persistence runtime", () => {
  afterEach(() => {
    Reflect.deleteProperty(globalThis, runtimeKey);
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("shares one development persistence instance across module re-evaluation", async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("DATABASE_URL", "");
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "");
    // Dynamic imports intentionally simulate two independently evaluated Next server bundles.

    const firstModule = await import("./runtime");
    const first = firstModule.getPersistenceServicesFromEnv();
    vi.resetModules();
    const secondModule = await import("./runtime");
    const second = secondModule.getPersistenceServicesFromEnv();

    expect(second).toBe(first);
    expect(second.sessions).toBe(first.sessions);
    expect(second.repository).toBe(first.repository);
  });
});
