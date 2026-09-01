import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

import { POST } from "@/app/api/telemetry/browser-metrics/route";
import {
  BrowserLaunchMetrics,
  SameOriginBrowserMetricSink,
} from "./browser-metrics";
import type { BrowserMetricEvent, BrowserMetricFetch } from "./browser-metrics";

const endpoint = "https://axiom.test/api/telemetry/browser-metrics";

function routeFetch(deliveries: Promise<Response>[]): BrowserMetricFetch {
  return vi.fn((_input, init) => {
    const headers = new Headers(init?.headers);
    headers.set("origin", "https://axiom.test");
    headers.set("host", "axiom.test");
    const delivery = POST(new Request(endpoint, { ...init, headers }));
    deliveries.push(delivery);
    return delivery;
  });
}

const quotaEvent: BrowserMetricEvent = {
  name: "quota_outcome_total",
  unit: "count",
  value: 1,
  labels: { outcome: "denied_daily" },
};

describe("browser metrics production integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireSession.mockResolvedValue({ learnerId: "lrn_private" });
    mocks.consumeRateLimit.mockResolvedValue({ allowed: true, remaining: 119, resetAfterSeconds: 60 });
    mocks.recordOperationalMetric.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses one browser singleton wired through the real sink and bounded API", async () => {
    const deliveries: Promise<Response>[] = [];
    const fetchMetric = routeFetch(deliveries);
    vi.stubGlobal("navigator", { sendBeacon: vi.fn(() => false) });
    vi.stubGlobal("fetch", fetchMetric);
    vi.resetModules();
    // Dynamic import intentionally creates the singleton after installing browser globals.
    const { getBrowserLaunchMetrics } = await import("./browser-metrics");
    const metrics = getBrowserLaunchMetrics();

    expect(getBrowserLaunchMetrics()).toBe(metrics);
    metrics.recordQuotaOutcome("denied_daily");

    expect(deliveries).toHaveLength(1);
    const response = await deliveries[0];
    expect(response.status).toBe(204);
    expect(fetchMetric).toHaveBeenCalledWith(
      "/api/telemetry/browser-metrics",
      expect.objectContaining({
        method: "POST",
        keepalive: true,
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(quotaEvent),
      }),
    );
    expect(mocks.recordOperationalMetric).toHaveBeenCalledWith({
      name: "browser.quota_outcome_total",
      value: 1,
      unit: "count",
      dimensions: { outcome: "denied_daily" },
      recordedAt: expect.any(Date),
    });
  });

  it("rejects learner content and identifiers even when an unsafe caller bypasses browser types", async () => {
    const deliveries: Promise<Response>[] = [];
    const sink = new SameOriginBrowserMetricSink({ sendBeacon: () => false }, routeFetch(deliveries));

    sink.record({
      ...quotaEvent,
      learnerId: "lrn_leak",
      labels: { outcome: "denied_daily", content: "private learner transcript" },
    } as never);

    expect(deliveries).toHaveLength(1);
    const response = await deliveries[0];
    expect(response.status).toBe(400);
    expect(mocks.recordOperationalMetric).not.toHaveBeenCalled();
  });

  it("rejects an oversized unsafe browser payload before operational storage", async () => {
    const deliveries: Promise<Response>[] = [];
    const sink = new SameOriginBrowserMetricSink({ sendBeacon: () => false }, routeFetch(deliveries));

    sink.record({
      ...quotaEvent,
      labels: { outcome: "denied_daily", detail: "x".repeat(600) },
    } as never);

    expect(deliveries).toHaveLength(1);
    const response = await deliveries[0];
    expect(response.status).toBe(413);
    expect(mocks.recordOperationalMetric).not.toHaveBeenCalled();
  });

  it("enforces the persistent rate boundary on a real browser sink delivery", async () => {
    mocks.consumeRateLimit.mockResolvedValue({ allowed: false, remaining: 0, resetAfterSeconds: 17 });
    const deliveries: Promise<Response>[] = [];
    const sink = new SameOriginBrowserMetricSink({ sendBeacon: () => false }, routeFetch(deliveries));

    sink.record(quotaEvent);

    expect(deliveries).toHaveLength(1);
    const response = await deliveries[0];
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("17");
    expect(mocks.recordOperationalMetric).not.toHaveBeenCalled();
  });

  it("falls back to an exact keepalive request when beacon throws", () => {
    const fetchMetric = vi.fn<BrowserMetricFetch>(() => Promise.resolve(new Response(null, { status: 204 })));
    const sink = new SameOriginBrowserMetricSink(
      { sendBeacon: () => { throw new Error("beacon unavailable"); } },
      fetchMetric,
    );
    const metrics = new BrowserLaunchMetrics(sink, { now: () => 0 });

    expect(() => metrics.recordQuotaOutcome("denied_daily")).not.toThrow();
    expect(fetchMetric).toHaveBeenCalledOnce();
    expect(fetchMetric).toHaveBeenCalledWith("/api/telemetry/browser-metrics", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(quotaEvent),
      keepalive: true,
      credentials: "same-origin",
    });
  });

  it("isolates synchronous fallback transport failures from lesson behavior", () => {
    const sink = new SameOriginBrowserMetricSink(
      { sendBeacon: () => false },
      () => { throw new Error("fetch unavailable"); },
    );
    const metrics = new BrowserLaunchMetrics(sink, { now: () => 0 });

    expect(() => metrics.recordQuotaOutcome("denied_daily")).not.toThrow();
  });
});
