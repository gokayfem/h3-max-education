import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  requireSession: vi.fn(),
  consumeRateLimit: vi.fn(),
  recordOperationalMetric: vi.fn(),
}));
vi.mock("@/lib/server/auth", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...(actual as object), requireSession: mocks.requireSession };
});

vi.mock("@/lib/server/session/runtime", () => ({
  getPersistenceServicesFromEnv: () => ({
    sessions: { consumeRateLimit: mocks.consumeRateLimit },
    repository: { recordOperationalMetric: mocks.recordOperationalMetric },
  }),
}));

import { POST } from "./route";

const validMetric = {
  name: "degraded_mode_total",
  unit: "count",
  value: 1,
  labels: { mode: "text_cards", reason: "network" },
} as const;

function request(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("https://axiom.test/api/telemetry/browser-metrics", {
    method: "POST",
    headers: {
      origin: "https://axiom.test",
      host: "axiom.test",
      "content-type": "application/json",
      ...headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("POST /api/telemetry/browser-metrics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    mocks.requireSession.mockResolvedValue({ learnerId: "lrn_private" });
    mocks.consumeRateLimit.mockResolvedValue({ allowed: true, remaining: 119, resetAfterSeconds: 60 });
    mocks.recordOperationalMetric.mockResolvedValue(undefined);
  });

  it("records a strict content-free browser metric and never persists identity", async () => {
    const response = await POST(request(validMetric));

    expect(response.status).toBe(204);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mocks.consumeRateLimit).toHaveBeenCalledWith(
      "browser-metrics:lrn_private",
      { limit: 120, windowSeconds: 60 },
    );
    expect(mocks.recordOperationalMetric).toHaveBeenCalledWith({
      name: "browser.degraded_mode_total",
      value: 1,
      unit: "count",
      dimensions: { mode: "text_cards", reason: "network" },
      recordedAt: expect.any(Date),
    });
    const stored = mocks.recordOperationalMetric.mock.calls[0]?.[0];
    expect(JSON.stringify(stored)).not.toMatch(/learner|session|content|transcript|url|token/i);
  });

  it.each([
    ["turn_end_to_first_audio_ms", "playing"],
    ["card_replacement_ms", "committed"],
  ] as const)("accepts the bounded %s launch metric", async (name, outcome) => {
    const response = await POST(request({
      name,
      unit: "milliseconds",
      value: 275,
      labels: { outcome },
    }));

    expect(response.status).toBe(204);
    expect(mocks.recordOperationalMetric).toHaveBeenCalledWith({
      name: `browser.${name}`,
      value: 275,
      unit: "milliseconds",
      dimensions: { outcome },
      recordedAt: expect.any(Date),
    });
  });

  it("enriches establishment metrics with bounded server-owned browser and region cohorts", async () => {
    vi.stubEnv("FLY_REGION", "iad");
    const response = await POST(request({
      name: "session_establishment_ms",
      unit: "milliseconds",
      value: 820,
      labels: {
        outcome: "ready",
        permission: "granted",
        failureStage: "none",
        transport: "turn_udp",
      },
    }, {
      "user-agent": "Mozilla/5.0 Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0",
    }));

    expect(response.status).toBe(204);
    expect(mocks.recordOperationalMetric).toHaveBeenCalledWith({
      name: "browser.session_establishment_ms",
      value: 820,
      unit: "milliseconds",
      dimensions: {
        outcome: "ready",
        permission: "granted",
        failureStage: "none",
        transport: "turn_udp",
        browser: "edge",
        region: "iad",
      },
      recordedAt: expect.any(Date),
    });
    expect(JSON.stringify(mocks.recordOperationalMetric.mock.calls[0]?.[0])).not.toContain("Mozilla");
  });

  it("rejects cross-origin requests before authentication or storage", async () => {
    const response = await POST(request(validMetric, { origin: "https://attacker.test" }));

    expect(response.status).toBe(403);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mocks.requireSession).not.toHaveBeenCalled();
    expect(mocks.recordOperationalMetric).not.toHaveBeenCalled();
  });

  it.each([
    ["extra envelope key", { ...validMetric, learnerId: "lrn_leak" }],
    ["extra label", { ...validMetric, labels: { ...validMetric.labels, detail: "learner content" } }],
    ["unknown event", { name: "anything", unit: "count", value: 1, labels: {} }],
    ["unbounded value", { name: "typed_first_token_ms", unit: "milliseconds", value: 600_001, labels: { outcome: "received" } }],
    [
      "raw transport details",
      {
        name: "session_establishment_ms",
        unit: "milliseconds",
        value: 20,
        labels: {
          outcome: "ready",
          permission: "granted",
          failureStage: "none",
          transport: "relay 203.0.113.4:3478",
        },
      },
    ],
  ])("rejects %s", async (_name, body) => {
    const response = await POST(request(body));

    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mocks.recordOperationalMetric).not.toHaveBeenCalled();
  });

  it("bounds declared request bodies before reading or recording them", async () => {
    const response = await POST(request(validMetric, { "content-length": "513" }));

    expect(response.status).toBe(413);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mocks.recordOperationalMetric).not.toHaveBeenCalled();
  });

  it("bounds a chunked stream even when no content length is declared", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(300));
        controller.enqueue(new Uint8Array(300));
        controller.close();
      },
    });
    const streamedRequest = new Request("https://axiom.test/api/telemetry/browser-metrics", {
      method: "POST",
      headers: {
        origin: "https://axiom.test",
        host: "axiom.test",
        "content-type": "application/json",
      },
      body: stream,
      duplex: "half",
    } as RequestInit & { duplex: "half" });

    const response = await POST(streamedRequest);

    expect(response.status).toBe(413);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mocks.recordOperationalMetric).not.toHaveBeenCalled();
  });

  it("enforces the persistent per-learner event rate limit", async () => {
    mocks.consumeRateLimit.mockResolvedValue({ allowed: false, remaining: 0, resetAfterSeconds: 37 });

    const response = await POST(request(validMetric));

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("37");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mocks.recordOperationalMetric).not.toHaveBeenCalled();
  });

  it("returns a contained no-store error when operational storage is unavailable", async () => {
    mocks.recordOperationalMetric.mockRejectedValue(new Error("storage unavailable"));
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = await POST(request(validMetric));

    expect(response.status).toBe(500);
    expect(response.headers.get("cache-control")).toBe("no-store");
    error.mockRestore();
  });
});
