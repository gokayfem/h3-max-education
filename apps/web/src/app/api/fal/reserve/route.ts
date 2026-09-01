import "server-only";

import { z } from "zod";
import { authErrorResponse, requireMutationSession, requireSession } from "@/lib/server/auth";
import { isFalFeatureEnabled } from "@/lib/server/fal-config";
import { getPersistenceServicesFromEnv } from "@/lib/server/session/runtime";
import { activeLessonStateSchema } from "@/lib/server/session/schemas";
import { parseJsonBody, sessionApiErrorResponse } from "@/lib/server/session/http";
const requestSchema = z.strictObject({
  sessionId: z.uuid(),
  durationSeconds: z.literal(5),
});

const VISUAL_LEASE_SECONDS = 180;
const PRIVATE_NO_STORE_HEADERS = { "Cache-Control": "no-store, private" };

function configuredPositiveInteger(name: string, defaultValue: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return defaultValue;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

function allowanceResponse(remainingSeconds: number, dailyLimitSeconds: number): {
  remainingSeconds: number;
  dailyLimitSeconds: number;
} {
  return { remainingSeconds, dailyLimitSeconds };
}

export async function GET(request: Request): Promise<Response> {
  try {
    const learner = await requireSession(request);
    const parsedSessionId = z.uuid().safeParse(new URL(request.url).searchParams.get("sessionId"));
    if (!parsedSessionId.success) {
      return Response.json(
        { error: { code: "invalid_request", message: "A valid sessionId is required." } },
        { status: 400, headers: PRIVATE_NO_STORE_HEADERS },
      );
    }
    const sessionId = parsedSessionId.data;
    const persistence = getPersistenceServicesFromEnv();
    const activeState = activeLessonStateSchema.safeParse(
      await persistence.sessions.getActiveState(sessionId),
    );
    if (
      !activeState.success
      || activeState.data.learnerId !== learner.learnerId
      || activeState.data.status === "ended"
    ) {
      return Response.json(
        { error: { code: "session_not_found", message: "Session not found or expired." } },
        { status: 404, headers: PRIVATE_NO_STORE_HEADERS },
      );
    }
    const dailyLimitSeconds = configuredPositiveInteger("DAILY_VIDEO_SECONDS", 120);
    const remainingSeconds = await persistence.sessions.getVisualDailyRemaining(
      learner.learnerId,
      dailyLimitSeconds,
    );
    return Response.json(
      allowanceResponse(remainingSeconds, dailyLimitSeconds),
      { headers: PRIVATE_NO_STORE_HEADERS },
    );
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse.status !== 500) return authResponse;
    const bodyResponse = sessionApiErrorResponse(error);
    if (bodyResponse.status !== 500) return bodyResponse;
    return Response.json(
      { error: { code: "visual_unavailable", message: "Visual generation is unavailable." } },
      { status: 502, headers: PRIVATE_NO_STORE_HEADERS },
    );
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const learner = await requireMutationSession(request);
    const input = await parseJsonBody(request, requestSchema);

    if (!isFalFeatureEnabled(process.env, "FAL_QUEUE_ENABLED")) {
      return Response.json(
        { error: { code: "visual_disabled", message: "Visual generation is disabled." } },
        { status: 503, headers: PRIVATE_NO_STORE_HEADERS },
      );
    }
    if (!process.env.FAL_KEY?.trim()) {
      return Response.json(
        { error: { code: "visual_unavailable", message: "Visual generation is unavailable." } },
        { status: 503, headers: PRIVATE_NO_STORE_HEADERS },
      );
    }

    const persistence = getPersistenceServicesFromEnv();
    const activeState = activeLessonStateSchema.safeParse(
      await persistence.sessions.getActiveState(input.sessionId),
    );
    if (
      !activeState.success
      || activeState.data.learnerId !== learner.learnerId
      || activeState.data.status === "ended"
    ) {
      return Response.json(
        { error: { code: "session_not_found", message: "Session not found or expired." } },
        { status: 404, headers: PRIVATE_NO_STORE_HEADERS },
      );
    }

    const dailyLimitSeconds = configuredPositiveInteger("DAILY_VIDEO_SECONDS", 120);
    const entitlement = await persistence.sessions.reserveVisualEntitlement({
      learnerId: learner.learnerId,
      sessionId: input.sessionId,
      durationSeconds: input.durationSeconds,
      dailyLimitSeconds,
      maxConcurrent: configuredPositiveInteger("MAX_CONCURRENT_VISUALS", 1),
      globalDailyLimitSeconds: configuredPositiveInteger("GLOBAL_DAILY_VIDEO_SECONDS", 10_000),
      leaseSeconds: VISUAL_LEASE_SECONDS,
    });
    const allowance = allowanceResponse(entitlement.remainingSeconds, dailyLimitSeconds);

    if (entitlement.status === "active") {
      return Response.json(
        {
          reservationId: entitlement.reservationId,
          expiresInSeconds: entitlement.leaseExpiresInSeconds,
          ...allowance,
        },
        { headers: PRIVATE_NO_STORE_HEADERS },
      );
    }
    if (entitlement.status === "pending") {
      return Response.json(
        {
          error: { code: "visual_pending", message: "Visual authorization is already in progress." },
          ...allowance,
        },
        {
          status: 409,
          headers: { ...PRIVATE_NO_STORE_HEADERS, "Retry-After": String(entitlement.retryAfterSeconds) },
        },
      );
    }
    if (
      entitlement.status === "daily_limit"
      || entitlement.status === "global_limit"
      || entitlement.status === "concurrency_limit"
    ) {
      const message = entitlement.status === "daily_limit"
        ? "The daily visual allowance is exhausted."
        : entitlement.status === "global_limit"
          ? "Visual generation capacity is currently exhausted."
          : "Another visual is already active.";
      return Response.json(
        { error: { code: entitlement.status, message }, ...allowance },
        { status: 429, headers: PRIVATE_NO_STORE_HEADERS },
      );
    }
    if (entitlement.status === "conflict") {
      return Response.json(
        {
          error: { code: "visual_conflict", message: "The active visual uses a different duration." },
          ...allowance,
        },
        { status: 409, headers: PRIVATE_NO_STORE_HEADERS },
      );
    }
    if (entitlement.status !== "reserved") {
      throw new Error("Unexpected visual entitlement state");
    }

    const committed = await persistence.sessions.commitVisualEntitlement(
      input.sessionId,
      entitlement.reservationId,
    );
    if (!committed) {
      await persistence.sessions.releaseVisualEntitlement(
        learner.learnerId,
        input.sessionId,
        entitlement.reservationId,
        true,
        dailyLimitSeconds,
      );
      throw new Error("Visual entitlement expired before activation");
    }
    return Response.json(
      {
        reservationId: entitlement.reservationId,
        expiresInSeconds: entitlement.leaseExpiresInSeconds,
        ...allowance,
      },
      { headers: PRIVATE_NO_STORE_HEADERS },
    );
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse.status !== 500) return authResponse;
    const bodyResponse = sessionApiErrorResponse(error);
    if (bodyResponse.status !== 500) return bodyResponse;
    return Response.json(
      { error: { code: "visual_unavailable", message: "Visual generation is unavailable." } },
      { status: 502, headers: PRIVATE_NO_STORE_HEADERS },
    );
  }
}
