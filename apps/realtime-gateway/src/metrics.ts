const DEFAULT_LATENCY_BUCKETS_MS = [10, 25, 50, 100, 250, 300, 500, 1_000, 1_200, 2_500, 5_000, 8_000, 10_000] as const;

const LAUNCH_GATE_BUCKETS_MS = {
  turn_end_to_first_audio: [100, 250, 500, 750, 1_000, 1_200, 1_500, 2_500, 5_000],
  speech_detection_to_audio_cutoff: [10, 25, 50, 100, 150, 200, 250, 300, 500, 1_000],
  gateway_card_to_browser_commit: [10, 25, 50, 100, 200, 250, 300, 400, 500, 1_000],
  visual_request_to_first_frame: [100, 250, 500, 1_000, 2_500, 5_000, 8_000, 10_000, 15_000]
} as const;

export type MetricOutcome = "ok" | "error" | "degraded" | "timeout";
export type FailurePlane = "browser" | "media" | "control";
export type AdmissionReason =
  | "none"
  | "authentication"
  | "origin"
  | "socket_cap"
  | "permit_unavailable"
  | "permit_lost"
  | "internal";
export type AdmissionOutcome = "allowed" | "rejected" | "error";
export type SocketPermitOperation = "renewal" | "release";
export type BinaryMetricOutcome = "ok" | "error";
export type OwnerFenceOperation = "acquire" | "refresh" | "release";
export type OwnerFenceOutcome = "ok" | "conflict" | "error";
export type ProviderReconnectOutcome = "attempted" | MetricOutcome;
export type CommandStage = "received" | "queued" | "delivered" | "replayed" | "rejected";
export type CommandDeliveryBoundary = "queue_wait" | "control_to_browser";
export type InterruptionAckOutcome = "ok" | "timeout" | "stale" | "error";
export type SidebandLatencyOperation =
  | "connect"
  | "reconnect"
  | "command_delivery"
  | "interruption_ack"
  | "interruption_control_dispatch";
export type VisualOperation = "readiness" | "redirect";
export type VisualOutcome = "ok" | "timeout" | "stale" | "error" | "fallback";
export type RevisionSurface = "command" | "cards" | "visual";
export type RevisionAction = "dropped" | "ignored";
export type CleanupResource = "session" | "socket" | "permit" | "provider" | "transcript" | "visual";
export type LaunchGate =
  | "turn_end_to_first_audio"
  | "speech_detection_to_audio_cutoff"
  | "gateway_card_to_browser_commit"
  | "visual_request_to_first_frame";
export type LaunchGateBoundary = "browser" | "media" | "control";
export type LaunchGateOutcome = "ok" | "error" | "timeout";

export type BrowserCommandType =
  | "learner.text"
  | "learner.card.select"
  | "learner.speech.start"
  | "learner.speech.end"
  | "session.close";
const COMMAND_TYPE_BY_LABEL: Readonly<Record<string, BrowserCommandType | undefined>> = {
  'type="learner.text"': "learner.text",
  'type="learner.card.select"': "learner.card.select",
  'type="learner.speech.start"': "learner.speech.start",
  'type="learner.speech.end"': "learner.speech.end",
  'type="session.close"': "session.close"
};

const VALIDATION_REASON_BY_LABEL: Readonly<Record<string, "frame" | "json" | "schema" | undefined>> = {
  'reason="frame"': "frame",
  'reason="json"': "json",
  'reason="schema"': "schema"
};


interface HistogramState {
  count: number;
  sumMs: number;
  buckets: number[];
}

interface HistogramSeries {
  labels: Readonly<Record<string, string>>;
  state: HistogramState;
}

interface CounterSeries {
  labels: Readonly<Record<string, string>>;
  value: number;
}

const COUNTER_HELP = {
  admission: "Gateway websocket admission decisions.",
  socket_admission_rejection: "Socket admission rejections with a non-oracular bounded reason.",
  socket_permit: "Socket permit renewal and release outcomes.",
  owner_fence: "Gateway owner-fencing operations.",
  provider_reconnect: "Provider reconnect lifecycle outcomes.",
  command: "Command queue and delivery lifecycle.",
  interruption_ack: "Interruption acknowledgement outcomes.",
  visual: "Visual readiness and redirect outcomes.",
  stale_revision: "Stale revision handling.",
  cleanup: "Gateway cleanup outcomes.",
  validation_failure: "Rejected browser command frames.",
  provider_failure: "Provider failures by failure plane.",
  provider_connection: "Gateway-to-provider sideband connection outcomes."
} as const;

type CounterFamily = keyof typeof COUNTER_HELP;

function metricLabel(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"").replaceAll("\n", "\\n");
}

function labelsKey(labels: Readonly<Record<string, string>>): string {
  return Object.entries(labels)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => `${name}=${value}`)
    .join(",");
}

function renderLabels(labels: Readonly<Record<string, string>>): string {
  return Object.entries(labels)
    .map(([name, value]) => `${name}="${metricLabel(value)}"`)
    .join(",");
}

function safeMilliseconds(milliseconds: number): number | null {
  return Number.isFinite(milliseconds) && milliseconds >= 0 ? milliseconds : null;
}

export class GatewayMetrics {
  private readonly startedAt: number;
  private activeSessions = 0;
  private activeSockets = 0;
  private readonly counters = new Map<string, CounterSeries>();
  private readonly sidebandHistograms = new Map<string, HistogramSeries>();
  private readonly commandDeliveryHistograms = new Map<string, HistogramSeries>();
  private readonly commandProcessingHistograms = new Map<string, HistogramSeries>();
  private readonly launchGateHistograms = new Map<string, HistogramSeries>();

  constructor(private readonly monotonicNow: () => number = () => performance.now()) {
    this.startedAt = monotonicNow();
  }

  setActiveSessions(value: number): void {
    this.activeSessions = this.safeGauge(value);
  }

  setActiveSockets(value: number): void {
    this.activeSockets = this.safeGauge(value);
  }

  recordAdmission(outcome: AdmissionOutcome, reason: AdmissionReason): void {
    this.incrementCounter("admission", { plane: "control", outcome, reason });
  }
  recordSocketAdmissionRejection(): void {
    this.incrementCounter("socket_admission_rejection", { plane: "control", reason: "cap" });
  }

  recordSocketPermit(operation: SocketPermitOperation, outcome: BinaryMetricOutcome): void {
    this.incrementCounter("socket_permit", { plane: "control", operation, outcome });
  }


  recordOwnerFence(operation: OwnerFenceOperation, outcome: OwnerFenceOutcome): void {
    this.incrementCounter("owner_fence", { plane: "control", operation, outcome });
  }

  recordProviderReconnect(outcome: ProviderReconnectOutcome): void {
    this.incrementCounter("provider_reconnect", { plane: "media", provider: "openai", outcome });
  }

  recordCommand(stage: CommandStage, plane: FailurePlane, outcome: MetricOutcome): void {
    this.incrementCounter("command", { stage, plane, outcome });
  }

  recordInterruptionAcknowledgement(plane: FailurePlane, outcome: InterruptionAckOutcome): void {
    this.incrementCounter("interruption_ack", { plane, outcome });
  }

  recordVisual(operation: VisualOperation, outcome: VisualOutcome): void {
    this.incrementCounter("visual", { plane: "media", operation, outcome });
  }

  recordStaleRevision(surface: RevisionSurface, action: RevisionAction): void {
    this.incrementCounter("stale_revision", { plane: surface === "command" ? "control" : "browser", surface, action });
  }

  recordCleanup(resource: CleanupResource, outcome: BinaryMetricOutcome): void {
    const plane: FailurePlane = resource === "provider" || resource === "visual" ? "media" : "control";
    this.incrementCounter("cleanup", { plane, resource, outcome });
  }

  observeSidebandLatency(operation: SidebandLatencyOperation, outcome: MetricOutcome, milliseconds: number): void {
    const plane: FailurePlane =
      operation === "connect" || operation === "reconnect" ? "media" : "control";
    this.observeHistogram(
      this.sidebandHistograms,
      "sideband",
      { plane, operation, outcome },
      milliseconds,
      DEFAULT_LATENCY_BUCKETS_MS
    );
  }

  observeCommandDeliveryLatency(
    boundary: CommandDeliveryBoundary,
    plane: "browser" | "control",
    outcome: MetricOutcome,
    milliseconds: number
  ): void {
    this.observeHistogram(
      this.commandDeliveryHistograms,
      "command_delivery",
      { boundary, plane, outcome },
      milliseconds,
      DEFAULT_LATENCY_BUCKETS_MS
    );
  }

  observeLaunchGate(gate: "speech_detection_to_audio_cutoff", milliseconds: number): void;
  observeLaunchGate(
    gate: LaunchGate,
    milliseconds: number,
    outcome: LaunchGateOutcome,
    boundary: LaunchGateBoundary
  ): void;
  observeLaunchGate(
    gate: LaunchGate,
    milliseconds: number,
    outcome: LaunchGateOutcome = "ok",
    boundary?: LaunchGateBoundary
  ): void {
    // A gateway dispatch is not proof that browser audio stopped. Keep the legacy
    // session hook useful without publishing it as the end-to-end launch gate.
    if (boundary === undefined) {
      if (gate === "speech_detection_to_audio_cutoff") {
        this.observeSidebandLatency("interruption_control_dispatch", outcome, milliseconds);
      }
      return;
    }
    this.observeHistogram(
      this.launchGateHistograms,
      "launch_gate",
      { gate, outcome, boundary },
      milliseconds,
      LAUNCH_GATE_BUCKETS_MS[gate]
    );
  }

  increment(name: "commands", labels: `type="${BrowserCommandType}"`): void;
  increment(name: "provider_reconnects", labels: 'provider="openai"'): void;
  increment(name: "validation_failures", labels: 'reason="frame"' | 'reason="json"' | 'reason="schema"'): void;
  increment(name: "provider_failures", labels: 'provider="openai"'): void;
  increment(
    name: "commands" | "provider_reconnects" | "validation_failures" | "provider_failures",
    labels: string
  ): void {
    if (name === "commands") {
      const type = COMMAND_TYPE_BY_LABEL[labels];
      if (type !== undefined) {
        this.incrementCounter("command", { stage: "received", plane: "browser", outcome: "ok", type });
      }
      return;
    }
    if (name === "provider_reconnects") {
      this.recordProviderReconnect("attempted");
      return;
    }
    if (name === "validation_failures") {
      const reason = VALIDATION_REASON_BY_LABEL[labels];
      if (reason !== undefined) this.incrementCounter("validation_failure", { plane: "browser", reason });
      return;
    }
    this.incrementCounter("provider_failure", { plane: "media", provider: "openai" });
  }

  incrementRealtimeEstablishment(outcome: "ok" | "error"): void {
    this.incrementCounter("provider_connection", { plane: "media", provider: "openai", outcome });
  }

  observeLatency(
    operation: "openai_sideband_connect" | "openai_sideband_reconnect" | "browser_command" | "tutor_tool",
    outcome: MetricOutcome,
    milliseconds: number
  ): void {
    if (operation === "browser_command") {
      this.observeHistogram(
        this.commandProcessingHistograms,
        "command_processing",
        { plane: "control", outcome },
        milliseconds,
        DEFAULT_LATENCY_BUCKETS_MS
      );
      return;
    }
    this.observeSidebandLatency(operation === "openai_sideband_connect" ? "connect" : "reconnect", outcome, milliseconds);
  }

  renderPrometheus(region: string): string {
    const common = { region };
    const elapsedMilliseconds = Math.max(0, this.monotonicNow() - this.startedAt);
    const runtimeSeconds = Number.isFinite(elapsedMilliseconds) ? elapsedMilliseconds / 1_000 : 0;
    const lines = [
      "# HELP axiom_gateway_metrics_runtime_seconds Time since this metrics collector was initialized, using a monotonic clock.",
      "# TYPE axiom_gateway_metrics_runtime_seconds gauge",
      `axiom_gateway_metrics_runtime_seconds{${renderLabels(common)}} ${runtimeSeconds}`,
      "# HELP axiom_gateway_active_sessions Sessions held by this instance.",
      "# TYPE axiom_gateway_active_sessions gauge",
      `axiom_gateway_active_sessions{${renderLabels(common)}} ${this.activeSessions}`,
      "# HELP axiom_gateway_active_websockets Authenticated browser sockets.",
      "# TYPE axiom_gateway_active_websockets gauge",
      `axiom_gateway_active_websockets{${renderLabels(common)}} ${this.activeSockets}`
    ];
    for (const family of Object.keys(COUNTER_HELP) as CounterFamily[]) {
      lines.push(`# HELP axiom_gateway_${family}_total ${COUNTER_HELP[family]}`);
      lines.push(`# TYPE axiom_gateway_${family}_total counter`);
      for (const [key, series] of this.counters) {
        if (!key.startsWith(`${family}|`)) continue;
        lines.push(`axiom_gateway_${family}_total{${renderLabels({ ...common, ...series.labels })}} ${series.value}`);
      }
    }
    this.renderHistogram(
      lines,
      "axiom_gateway_sideband_latency_ms",
      "Latency of gateway-to-provider sideband operations.",
      this.sidebandHistograms,
      DEFAULT_LATENCY_BUCKETS_MS,
      common
    );
    this.renderHistogram(
      lines,
      "axiom_gateway_command_delivery_latency_ms",
      "Latency at command queue and browser-delivery boundaries.",
      this.commandDeliveryHistograms,
      DEFAULT_LATENCY_BUCKETS_MS,
      common
    );
    this.renderHistogram(
      lines,
      "axiom_gateway_command_processing_latency_ms",
      "Gateway-local command processing latency; not end-to-end delivery.",
      this.commandProcessingHistograms,
      DEFAULT_LATENCY_BUCKETS_MS,
      common
    );
    this.renderLaunchGateHistograms(lines, common);
    return `${lines.join("\n")}\n`;
  }

  private safeGauge(value: number): number {
    return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
  }

  private incrementCounter(family: CounterFamily, labels: Readonly<Record<string, string>>): void {
    const key = `${family}|${labelsKey(labels)}`;
    const existing = this.counters.get(key);
    if (existing) existing.value += 1;
    else this.counters.set(key, { labels, value: 1 });
  }

  private observeHistogram(
    target: Map<string, HistogramSeries>,
    family: string,
    labels: Readonly<Record<string, string>>,
    milliseconds: number,
    buckets: readonly number[]
  ): void {
    const value = safeMilliseconds(milliseconds);
    if (value === null) return;
    const key = `${family}|${labelsKey(labels)}`;
    const series = target.get(key) ?? {
      labels,
      state: { count: 0, sumMs: 0, buckets: buckets.map(() => 0) }
    };
    series.state.count += 1;
    series.state.sumMs += value;
    buckets.forEach((boundary, index) => {
      if (value <= boundary) series.state.buckets[index] = (series.state.buckets[index] ?? 0) + 1;
    });
    target.set(key, series);
  }

  private renderHistogram(
    lines: string[],
    metricName: string,
    help: string,
    source: ReadonlyMap<string, HistogramSeries>,
    buckets: readonly number[],
    common: Readonly<Record<string, string>>
  ): void {
    lines.push(`# HELP ${metricName} ${help}`);
    lines.push(`# TYPE ${metricName} histogram`);
    for (const series of source.values()) {
      const labels = renderLabels({ ...common, ...series.labels });
      buckets.forEach((boundary, index) => {
        lines.push(`${metricName}_bucket{${labels},le="${boundary}"} ${series.state.buckets[index] ?? 0}`);
      });
      lines.push(`${metricName}_bucket{${labels},le="+Inf"} ${series.state.count}`);
      lines.push(`${metricName}_sum{${labels}} ${series.state.sumMs}`);
      lines.push(`${metricName}_count{${labels}} ${series.state.count}`);
    }
  }

  private renderLaunchGateHistograms(lines: string[], common: Readonly<Record<string, string>>): void {
    const metricName = "axiom_gateway_launch_gate_latency_ms";
    lines.push(`# HELP ${metricName} End-to-end latency observed at an explicit launch-gate boundary.`);
    lines.push(`# TYPE ${metricName} histogram`);
    for (const series of this.launchGateHistograms.values()) {
      const gate = series.labels.gate as LaunchGate;
      const buckets = LAUNCH_GATE_BUCKETS_MS[gate];
      const labels = renderLabels({ ...common, ...series.labels });
      buckets.forEach((boundary, index) => {
        lines.push(`${metricName}_bucket{${labels},le="${boundary}"} ${series.state.buckets[index] ?? 0}`);
      });
      lines.push(`${metricName}_bucket{${labels},le="+Inf"} ${series.state.count}`);
      lines.push(`${metricName}_sum{${labels}} ${series.state.sumMs}`);
      lines.push(`${metricName}_count{${labels}} ${series.state.count}`);
    }
  }
}
