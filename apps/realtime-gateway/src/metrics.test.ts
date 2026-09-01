import { describe, expect, it } from "vitest";
import { GatewayMetrics } from "./metrics.js";

describe("GatewayMetrics", () => {
  it("renders bounded operational counters without learner or content labels", () => {
    let now = 1_000;
    const metrics = new GatewayMetrics(() => now);
    metrics.setActiveSessions(2.9);
    metrics.setActiveSockets(3);
    metrics.recordAdmission("rejected", "authentication");
    metrics.recordSocketAdmissionRejection();
    metrics.recordSocketPermit("renewal", "error");
    metrics.recordOwnerFence("refresh", "conflict");
    metrics.recordProviderReconnect("degraded");
    metrics.recordCommand("queued", "control", "ok");
    metrics.recordCommand("delivered", "browser", "error");
    metrics.observeCommandDeliveryLatency("queue_wait", "control", "degraded", 300);
    metrics.recordInterruptionAcknowledgement("media", "timeout");
    metrics.recordVisual("readiness", "timeout");
    metrics.recordVisual("redirect", "fallback");
    metrics.recordStaleRevision("visual", "dropped");
    metrics.recordCleanup("transcript", "error");
    now = 6_000;

    const output = metrics.renderPrometheus("iad");
    expect(output).toContain("axiom_gateway_metrics_runtime_seconds{region=\"iad\"} 5");
    expect(output).toContain("axiom_gateway_active_sessions{region=\"iad\"} 2");
    expect(output).toContain(
      "axiom_gateway_admission_total{region=\"iad\",plane=\"control\",outcome=\"rejected\",reason=\"authentication\"} 1"
    );
    expect(output).toContain(
      "axiom_gateway_socket_admission_rejection_total{region=\"iad\",plane=\"control\",reason=\"cap\"} 1"
    );
    expect(output).toContain(
      "axiom_gateway_socket_permit_total{region=\"iad\",plane=\"control\",operation=\"renewal\",outcome=\"error\"} 1"
    );
    expect(output).toContain(
      "axiom_gateway_owner_fence_total{region=\"iad\",plane=\"control\",operation=\"refresh\",outcome=\"conflict\"} 1"
    );
    expect(output).toContain(
      "axiom_gateway_provider_reconnect_total{region=\"iad\",plane=\"media\",provider=\"openai\",outcome=\"degraded\"} 1"
    );
    expect(output).toContain(
      "axiom_gateway_command_total{region=\"iad\",stage=\"queued\",plane=\"control\",outcome=\"ok\"} 1"
    );
    expect(output).toContain(
      "axiom_gateway_interruption_ack_total{region=\"iad\",plane=\"media\",outcome=\"timeout\"} 1"
    );
    expect(output).toContain(
      "axiom_gateway_visual_total{region=\"iad\",plane=\"media\",operation=\"readiness\",outcome=\"timeout\"} 1"
    );
    expect(output).toContain(
      "axiom_gateway_stale_revision_total{region=\"iad\",plane=\"browser\",surface=\"visual\",action=\"dropped\"} 1"
    );
    expect(output).toContain(
      "axiom_gateway_cleanup_total{region=\"iad\",plane=\"control\",resource=\"transcript\",outcome=\"error\"} 1"
    );
    expect(output).toContain(
      'axiom_gateway_command_delivery_latency_ms_sum{region="iad",boundary="queue_wait",plane="control",outcome="degraded"} 300'
    );
    expect(output).not.toMatch(/learner|session_id|prompt|transcript_text/);
  });

  it("uses exact launch thresholds and explicit browser, media, or control boundaries", () => {
    const metrics = new GatewayMetrics(() => 0);
    metrics.observeLaunchGate("turn_end_to_first_audio", 1_200, "ok", "media");
    metrics.observeLaunchGate("gateway_card_to_browser_commit", 300, "ok", "browser");
    metrics.observeLaunchGate("visual_request_to_first_frame", 8_000, "timeout", "media");

    const output = metrics.renderPrometheus("iad");

    expect(output).toContain(
      'gate="turn_end_to_first_audio",outcome="ok",boundary="media",le="1200"} 1'
    );
    expect(output).toContain(
      'gate="gateway_card_to_browser_commit",outcome="ok",boundary="browser",le="300"} 1'
    );
    expect(output).toContain(
      'gate="visual_request_to_first_frame",outcome="timeout",boundary="media",le="8000"} 1'
    );
  });

  it("does not report provider control dispatch as audible interruption acknowledgement", () => {
    const metrics = new GatewayMetrics(() => 0);
    metrics.observeLaunchGate("speech_detection_to_audio_cutoff", 18);

    const output = metrics.renderPrometheus("iad");

    expect(output).not.toContain('gate="speech_detection_to_audio_cutoff"');
    expect(output).toContain(
      'plane="control",operation="interruption_control_dispatch",outcome="ok",le="25"} 1'
    );
  });

  it("maps existing gateway hooks to bounded series and ignores invalid durations", () => {
    const metrics = new GatewayMetrics(() => 0);
    metrics.increment("commands", 'type="learner.text"');
    metrics.increment("validation_failures", 'reason="schema"');
    metrics.increment("provider_failures", 'provider="openai"');
    metrics.increment("provider_reconnects", 'provider="openai"');
    metrics.incrementRealtimeEstablishment("error");
    metrics.observeLatency("openai_sideband_connect", "ok", 42);
    metrics.observeLatency("browser_command", "error", Number.NaN);

    const output = metrics.renderPrometheus("iad");

    expect(output).toContain(
      'axiom_gateway_command_total{region="iad",stage="received",plane="browser",outcome="ok",type="learner.text"} 1'
    );
    expect(output).toContain(
      'axiom_gateway_validation_failure_total{region="iad",plane="browser",reason="schema"} 1'
    );
    expect(output).toContain(
      'axiom_gateway_provider_connection_total{region="iad",plane="media",provider="openai",outcome="error"} 1'
    );
    expect(output).toContain(
      'axiom_gateway_sideband_latency_ms_sum{region="iad",plane="media",operation="connect",outcome="ok"} 42'
    );
    expect(output).not.toContain('operation="command_delivery"');
  });
  it("normalizes invalid gauges, repeated counters, and alternate metric planes", () => {
    const metrics = new GatewayMetrics(() => Number.POSITIVE_INFINITY);
    metrics.setActiveSessions(Number.NaN);
    metrics.setActiveSockets(-3);
    metrics.recordAdmission("allowed", "none");
    metrics.recordAdmission("allowed", "none");
    metrics.recordStaleRevision("command", "ignored");
    metrics.recordCleanup("provider", "ok");
    metrics.observeSidebandLatency("command_delivery", "ok", 75);
    metrics.observeSidebandLatency("reconnect", "error", 125);

    const output = metrics.renderPrometheus("ord");
    expect(output).toContain("axiom_gateway_metrics_runtime_seconds{region=\"ord\"} 0");
    expect(output).toContain("axiom_gateway_active_sessions{region=\"ord\"} 0");
    expect(output).toContain("axiom_gateway_active_websockets{region=\"ord\"} 0");
    expect(output).toContain(
      "axiom_gateway_admission_total{region=\"ord\",plane=\"control\",outcome=\"allowed\",reason=\"none\"} 2",
    );
    expect(output).toContain(
      "axiom_gateway_stale_revision_total{region=\"ord\",plane=\"control\",surface=\"command\",action=\"ignored\"} 1",
    );
    expect(output).toContain(
      "axiom_gateway_cleanup_total{region=\"ord\",plane=\"media\",resource=\"provider\",outcome=\"ok\"} 1",
    );
    expect(output).toContain('plane="control",operation="command_delivery",outcome="ok"');
    expect(output).toContain('plane="media",operation="reconnect",outcome="error"');
  });

});
