import { describe, expect, it } from "vitest";
import {
  BrowserLaunchMetrics,
  SameOriginBrowserMetricSink,
  type BrowserMetricEvent,
  type BrowserMetricSink,
  type InterruptionAttempt,
  type MonotonicClock
} from "./browser-metrics";

class FakeClock implements MonotonicClock {
  current = 0;

  now(): number {
    return this.current;
  }
}

class RecordingSink implements BrowserMetricSink {
  readonly events: BrowserMetricEvent[] = [];

  record(event: BrowserMetricEvent): void {
    this.events.push(event);
  }
}

function setup(): { clock: FakeClock; sink: RecordingSink; metrics: BrowserLaunchMetrics } {
  const clock = new FakeClock();
  const sink = new RecordingSink();
  return { clock, sink, metrics: new BrowserLaunchMetrics(sink, clock) };
}

describe("BrowserLaunchMetrics", () => {
  it("measures session click-to-ready and permission-to-ready at browser boundaries", () => {
    const { clock, sink, metrics } = setup();
    clock.current = 100;
    const attempt = metrics.startSessionEstablishment();
    clock.current = 340;
    metrics.markSessionPermission(attempt, "granted");
    metrics.markSessionTransport(attempt, "turn_udp");
    clock.current = 910;
    metrics.finishSessionEstablishment(attempt, { outcome: "ready" });

    expect(sink.events).toEqual([
      {
        name: "session_establishment_ms",
        unit: "milliseconds",
        value: 810,
        labels: {
          outcome: "ready",
          permission: "granted",
          failureStage: "none",
          transport: "turn_udp"
        }
      },
      {
        name: "session_permission_to_ready_ms",
        unit: "milliseconds",
        value: 570,
        labels: { permission: "granted" }
      }
    ]);
  });

  it("records bounded session failure dimensions without a permission-to-ready sample", () => {
    const { clock, sink, metrics } = setup();
    const attempt = metrics.startSessionEstablishment();
    clock.current = 25;
    metrics.markSessionPermission(attempt, "denied");
    clock.current = 30;
    metrics.finishSessionEstablishment(attempt, { outcome: "permission_denied", failureStage: "permission" });
    expect(sink.events).toEqual([
      {
        name: "session_establishment_ms",
        unit: "milliseconds",
        value: 30,
        labels: {
          outcome: "permission_denied",
          permission: "denied",
          failureStage: "permission",
          transport: "unknown"
        }
      }
    ]);
  });

  it("measures a typed turn from accepted submit to its first token terminal boundary", () => {
    const { clock, sink, metrics } = setup();
    clock.current = 20;
    const attempt = metrics.startTypedFirstToken();
    clock.current = 96;
    metrics.finishTypedFirstToken(attempt, "received");

    expect(sink.events).toEqual([
      {
        name: "typed_first_token_ms",
        unit: "milliseconds",
        value: 76,
        labels: { outcome: "received" }
      }
    ]);
  });

  it("measures learner turn completion through observably playing tutor audio", () => {
    const { clock, sink, metrics } = setup();
    clock.current = 1_000;
    const attempt = metrics.startTutorFirstAudio();
    clock.current = 1_840;
    metrics.finishTutorFirstAudio(attempt, "playing");

    expect(sink.events).toEqual([
      {
        name: "turn_end_to_first_audio_ms",
        unit: "milliseconds",
        value: 840,
        labels: { outcome: "playing" }
      }
    ]);
  });

  it("measures validated card replacement arrival through matching React commit", () => {
    const { clock, sink, metrics } = setup();
    clock.current = 2_000;
    metrics.startCardReplacement(7);
    clock.current = 2_185;
    metrics.finishCardReplacement(7);

    expect(sink.events).toEqual([
      {
        name: "card_replacement_ms",
        unit: "milliseconds",
        value: 185,
        labels: { outcome: "committed" }
      }
    ]);
  });

  it("bounds card replacement correlations, evicts oldest revisions, and never emits revision labels", () => {
    const { clock, sink, metrics } = setup();
    for (let revision = 0; revision <= 32; revision += 1) {
      clock.current = revision;
      metrics.startCardReplacement(revision);
    }
    metrics.startCardReplacement(-1);
    metrics.startCardReplacement(Number.POSITIVE_INFINITY);
    clock.current = 100;
    metrics.finishCardReplacement(0);
    metrics.finishCardReplacement(32);

    expect(sink.events).toEqual([
      {
        name: "card_replacement_ms",
        unit: "milliseconds",
        value: 68,
        labels: { outcome: "committed" }
      }
    ]);
    expect(JSON.stringify(sink.events)).not.toContain("revision");
  });

  it("measures first generated frame only for displayed video and categorizes every visual result", () => {
    const { clock, sink, metrics } = setup();
    const displayed = metrics.startVisualGeneration();
    clock.current = 8_020;
    metrics.finishVisualGeneration(displayed, "displayed");
    const reducedMotion = metrics.startVisualGeneration();
    clock.current = 8_025;
    metrics.finishVisualGeneration(reducedMotion, "reduced_motion_static");

    expect(sink.events).toEqual([
      {
        name: "first_generated_frame_ms",
        unit: "milliseconds",
        value: 8_020,
        labels: { result: "displayed" }
      },
      {
        name: "visual_result_total",
        unit: "count",
        value: 1,
        labels: { result: "displayed" }
      },
      {
        name: "visual_result_total",
        unit: "count",
        value: 1,
        labels: { result: "reduced_motion_static" }
      }
    ]);
  });

  it("records stale drops, degraded transitions, and quota outcomes with bounded labels", () => {
    const { sink, metrics } = setup();
    metrics.recordStaleRevisionDrop("visual");
    metrics.recordDegradedMode("held_frame", "reduced_motion");
    metrics.recordQuotaOutcome("denied_daily");

    expect(sink.events).toEqual([
      {
        name: "stale_revision_drop_total",
        unit: "count",
        value: 1,
        labels: { surface: "visual" }
      },
      {
        name: "degraded_mode_total",
        unit: "count",
        value: 1,
        labels: { mode: "held_frame", reason: "reduced_motion" }
      },
      {
        name: "quota_outcome_total",
        unit: "count",
        value: 1,
        labels: { outcome: "denied_daily" }
      }
    ]);
  });

  it("audits committed interruption surfaces and visual-failure continuation with bounded outcomes", () => {
    const { sink, metrics } = setup();
    metrics.recordPostInterruptionSurfaceAudit("cards", "clean");
    metrics.recordPostInterruptionSurfaceAudit("visual", "stale");
    metrics.recordVisualFailureContinuation("continued");

    expect(sink.events).toEqual([
      {
        name: "post_interruption_surface_audit_total",
        unit: "count",
        value: 1,
        labels: { surface: "cards", outcome: "clean" }
      },
      {
        name: "post_interruption_surface_audit_total",
        unit: "count",
        value: 1,
        labels: { surface: "visual", outcome: "stale" }
      },
      {
        name: "visual_failure_continuation_total",
        unit: "count",
        value: 1,
        labels: { outcome: "continued" }
      }
    ]);
  });

  it("measures interruption from speech detection through observable audio cutoff", () => {
    const { clock, sink, metrics } = setup();
    clock.current = 400;
    const attempt = metrics.startInterruption();
    clock.current = 615;
    metrics.finishInterruption(attempt, "audio_cut_off");

    expect(sink.events).toEqual([
      {
        name: "interruption_audio_cutoff_ms",
        unit: "milliseconds",
        value: 215,
        labels: { outcome: "audio_cut_off" }
      },
      {
        name: "interruption_total",
        unit: "count",
        value: 1,
        labels: { outcome: "audio_cut_off" }
      }
    ]);
  });

  it("consumes attempts once, ignores foreign handles, and clamps unsafe durations", () => {
    const { clock, sink, metrics } = setup();
    const attempt = metrics.startTypedFirstToken();
    clock.current = Number.POSITIVE_INFINITY;
    metrics.finishTypedFirstToken(attempt, "failed");
    metrics.finishTypedFirstToken(attempt, "received");
    metrics.finishInterruption({ kind: "interruption" } as InterruptionAttempt, "failed");

    expect(sink.events).toEqual([
      {
        name: "typed_first_token_ms",
        unit: "milliseconds",
        value: 0,
        labels: { outcome: "failed" }
      }
    ]);
  });

  it("emits no learner content, identifiers, errors, URLs, or credential-shaped fields", () => {
    const { sink, metrics } = setup();
    const visual = metrics.startVisualGeneration();
    metrics.finishVisualGeneration(visual, "prompt_rejected");
    metrics.recordQuotaOutcome("reserved");

    const serialized = JSON.stringify(sink.events);
    expect(serialized).toBe(
      '[{"name":"visual_result_total","unit":"count","value":1,"labels":{"result":"prompt_rejected"}},{"name":"quota_outcome_total","unit":"count","value":1,"labels":{"outcome":"reserved"}}]'
    );
    expect(serialized).not.toMatch(/content|transcript|secret|apiKey|url|errorMessage|sessionId|learner/i);
  });

  it("sends one exact bounded event with beacon when navigation-safe delivery is available", async () => {
    let beaconUrl: string | undefined;
    let beaconBody: Blob | undefined;
    let fetchCalls = 0;
    const sink = new SameOriginBrowserMetricSink(
      {
        sendBeacon(url, data) {
          beaconUrl = url;
          beaconBody = data as Blob;
          return true;
        }
      },
      async () => {
        fetchCalls += 1;
        return new Response(null, { status: 202 });
      }
    );
    const metrics = new BrowserLaunchMetrics(sink, new FakeClock());

    metrics.recordDegradedMode("text_cards", "microphone_denied");

    expect(beaconUrl).toBe("/api/telemetry/browser-metrics");
    expect(beaconBody?.type).toBe("application/json");
    const beaconText = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.addEventListener("load", () => resolve(String(reader.result)));
      reader.addEventListener("error", () => reject(reader.error));
      reader.readAsText(beaconBody as Blob);
    });
    expect(beaconText).toBe(
      '{"name":"degraded_mode_total","unit":"count","value":1,"labels":{"mode":"text_cards","reason":"microphone_denied"}}'
    );
    expect(fetchCalls).toBe(0);
  });

  it("falls back to a same-origin keepalive request and contains delivery failures", async () => {
    let request: { input: RequestInfo | URL; init?: RequestInit } | undefined;
    const sink = new SameOriginBrowserMetricSink(
      { sendBeacon: () => false },
      (input, init) => {
        request = { input, init };
        return Promise.reject(new Error("offline"));
      }
    );
    const metrics = new BrowserLaunchMetrics(sink, new FakeClock());

    expect(() => metrics.recordQuotaOutcome("exhausted")).not.toThrow();
    await Promise.resolve();

    expect(request?.input).toBe("/api/telemetry/browser-metrics");
    expect(request?.init).toEqual({
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{\"name\":\"quota_outcome_total\",\"unit\":\"count\",\"value\":1,\"labels\":{\"outcome\":\"exhausted\"}}',
      keepalive: true,
      credentials: "same-origin"
    });
  });
});
