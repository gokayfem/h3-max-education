import "server-only";

import type { LearningRepository } from "@axiom/persistence";
import type { BrowserMetricEvent } from "@/lib/telemetry/browser-metrics";
import { z } from "zod";

export const MAX_BROWSER_METRIC_BYTES = 512;
export const BROWSER_METRIC_RATE_LIMIT = Object.freeze({ limit: 120, windowSeconds: 60 });

const duration = z.number().int().min(0).max(10 * 60 * 1_000);
const count = z.literal(1);
const milliseconds = z.literal("milliseconds");
const countUnit = z.literal("count");

export const browserMetricEventSchema = z.discriminatedUnion("name", [
  z.strictObject({
    name: z.literal("session_establishment_ms"),
    unit: milliseconds,
    value: duration,
    labels: z.strictObject({
      outcome: z.enum(["ready", "permission_denied", "failed"]),
      permission: z.enum(["granted", "denied", "unavailable", "not_requested"]),
      failureStage: z.enum(["permission", "session_token", "peer_connection", "data_channel", "none"]),
      transport: z.enum(["direct_udp", "direct_tcp", "turn_udp", "turn_tcp", "unknown"]),
    }),
  }),
  z.strictObject({
    name: z.literal("session_permission_to_ready_ms"),
    unit: milliseconds,
    value: duration,
    labels: z.strictObject({ permission: z.enum(["granted", "denied", "unavailable"]) }),
  }),
  z.strictObject({
    name: z.literal("typed_first_token_ms"),
    unit: milliseconds,
    value: duration,
    labels: z.strictObject({ outcome: z.enum(["received", "cancelled", "failed"]) }),
  }),
  z.strictObject({
    name: z.literal("turn_end_to_first_audio_ms"),
    unit: milliseconds,
    value: duration,
    labels: z.strictObject({ outcome: z.enum(["playing", "cancelled", "failed"]) }),
  }),
  z.strictObject({
    name: z.literal("card_replacement_ms"),
    unit: milliseconds,
    value: duration,
    labels: z.strictObject({ outcome: z.literal("committed") }),
  }),
  z.strictObject({
    name: z.literal("first_generated_frame_ms"),
    unit: milliseconds,
    value: duration,
    labels: z.strictObject({ result: z.literal("displayed") }),
  }),
  z.strictObject({
    name: z.literal("visual_result_total"),
    unit: countUnit,
    value: count,
    labels: z.strictObject({
      result: z.enum([
        "displayed",
        "reduced_motion_static",
        "prompt_rejected",
        "deadline_missed",
        "stream_exhausted",
        "transport_failed",
        "cancelled",
        "stale_revision",
        "quota_denied",
      ]),
    }),
  }),
  z.strictObject({
    name: z.literal("stale_revision_drop_total"),
    unit: countUnit,
    value: count,
    labels: z.strictObject({ surface: z.enum(["cards", "visual", "transcript", "tool_command"]) }),
  }),
  z.strictObject({
    name: z.literal("interruption_audio_cutoff_ms"),
    unit: milliseconds,
    value: duration,
    labels: z.strictObject({ outcome: z.enum(["audio_cut_off", "cancelled_before_audio", "failed"]) }),
  }),
  z.strictObject({
    name: z.literal("interruption_total"),
    unit: countUnit,
    value: count,
    labels: z.strictObject({ outcome: z.enum(["audio_cut_off", "cancelled_before_audio", "failed"]) }),
  }),
  z.strictObject({
    name: z.literal("post_interruption_surface_audit_total"),
    unit: countUnit,
    value: count,
    labels: z.strictObject({
      surface: z.enum(["cards", "visual"]),
      outcome: z.enum(["clean", "stale"]),
    }),
  }),
  z.strictObject({
    name: z.literal("visual_failure_continuation_total"),
    unit: countUnit,
    value: count,
    labels: z.strictObject({ outcome: z.enum(["continued", "lesson_terminated"]) }),
  }),
  z.strictObject({
    name: z.literal("degraded_mode_total"),
    unit: countUnit,
    value: count,
    labels: z.strictObject({
      mode: z.enum(["voice_text_cards", "text_cards", "held_frame"]),
      reason: z.enum([
        "microphone_denied",
        "realtime_unavailable",
        "visual_unavailable",
        "network",
        "reduced_motion",
        "quota_exhausted",
      ]),
    }),
  }),
  z.strictObject({
    name: z.literal("quota_outcome_total"),
    unit: countUnit,
    value: count,
    labels: z.strictObject({
      outcome: z.enum([
        "reserved",
        "denied_daily",
        "denied_concurrency",
        "denied_entitlement",
        "released",
        "exhausted",
      ]),
    }),
  }),
]);

export type ServerBrowserMetricEvent = z.infer<typeof browserMetricEventSchema>;

type Assert<T extends true> = T;
export type BrowserMetricSchemaCompatibility = Assert<
  (BrowserMetricEvent extends ServerBrowserMetricEvent ? true : false)
  & (ServerBrowserMetricEvent extends BrowserMetricEvent ? true : false)
>;

export interface BrowserMetricRecorder {
  recordOperationalMetric: LearningRepository["recordOperationalMetric"];
}

export type BrowserCohort = "chrome" | "edge" | "other";
export type DeploymentRegion = "iad" | "ord" | "lax" | "sjc" | "ams" | "lhr" | "fra" | "syd" | "local" | "other";

const DEPLOYMENT_REGIONS: Readonly<Record<Exclude<DeploymentRegion, "other">, true>> = {
  iad: true,
  ord: true,
  lax: true,
  sjc: true,
  ams: true,
  lhr: true,
  fra: true,
  syd: true,
  local: true,
};

export interface BrowserMetricServerContext {
  userAgent?: string | null;
  deploymentRegion?: string | null;
}

export function classifyBrowserCohort(userAgent: string | null | undefined): BrowserCohort {
  if (userAgent && /(?:Edg|EdgiOS|EdgA)\//u.test(userAgent)) return "edge";
  if (userAgent && /(?:Chrome|CriOS)\//u.test(userAgent)) return "chrome";
  return "other";
}

export function classifyDeploymentRegion(region: string | null | undefined): DeploymentRegion {
  const normalized = region?.trim().toLowerCase();
  return normalized && Object.hasOwn(DEPLOYMENT_REGIONS, normalized)
    ? normalized as DeploymentRegion
    : "other";
}

/** Records only schema-approved dimensions, adding bounded server-owned establishment cohorts. */
export function recordBrowserMetric(
  repository: BrowserMetricRecorder,
  event: ServerBrowserMetricEvent,
  context: BrowserMetricServerContext = {},
  recordedAt = new Date(),
): Promise<void> {
  const dimensions = event.name === "session_establishment_ms"
    ? {
        ...event.labels,
        browser: classifyBrowserCohort(context.userAgent),
        region: classifyDeploymentRegion(context.deploymentRegion),
      }
    : event.labels;
  return repository.recordOperationalMetric({
    name: `browser.${event.name}`,
    value: event.value,
    unit: event.unit,
    dimensions,
    recordedAt,
  });
}
