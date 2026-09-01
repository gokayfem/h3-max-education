import "server-only";

import { z } from "zod";
import { authErrorResponse, requireMutationSession } from "@/lib/server/auth";
import { isFalFeatureEnabled } from "@/lib/server/fal-config";
import { parseJsonBody, sessionApiErrorResponse } from "@/lib/server/session/http";
import { getPersistenceServicesFromEnv } from "@/lib/server/session/runtime";
import { activeLessonStateSchema } from "@/lib/server/session/schemas";

export const runtime = "nodejs";

const MODEL = "xai/grok-voice/realtime";
const TOKEN_DURATION_SECONDS = 120;
const PRIVATE_NO_STORE_HEADERS = { "Cache-Control": "no-store, private" };
const inputSchema = z.strictObject({
  sessionId: z.uuid(),
  attemptId: z.uuid(),
  reconnect: z.boolean().optional().default(false),
});
const tokenResponseSchema = z.string().min(16).max(8_192);

function unavailable(status = 503): Response {
  return Response.json(
    { error: { code: "voice_unavailable", message: "Voice is temporarily unavailable." } },
    { status, headers: PRIVATE_NO_STORE_HEADERS },
  );
}

export async function POST(request: Request): Promise<Response> {
  let admission: { learnerId: string; leaseId: string } | null = null;
  try {
    const learner = await requireMutationSession(request);
    const input = await parseJsonBody(request, inputSchema, 2_048);
    const falKey = process.env.FAL_KEY?.trim();
    if (!falKey || !isFalFeatureEnabled(process.env, "FAL_GROK_VOICE_ENABLED")) {
      return unavailable();
    }

    const sessions = getPersistenceServicesFromEnv().sessions;
    const activeState = activeLessonStateSchema.safeParse(await sessions.getActiveState(input.sessionId));
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

    const reservation = input.reconnect
      ? await sessions.replaceRealtimeCall(learner.learnerId, input.sessionId, input.attemptId)
      : await sessions.reserveRealtimeCall(learner.learnerId, input.sessionId, input.attemptId);
    if (!reservation.allowed) {
      return Response.json(
        { error: { code: reservation.reason, message: "Voice capacity is temporarily unavailable." } },
        {
          status: 429,
          headers: {
            ...PRIVATE_NO_STORE_HEADERS,
            "Retry-After": String(reservation.retryAfterSeconds),
          },
        },
      );
    }
    admission = { learnerId: learner.learnerId, leaseId: reservation.leaseId };

    const upstream = await fetch("https://rest.fal.ai/tokens/realtime", {
      method: "POST",
      headers: {
        Authorization: `Key ${falKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ app: MODEL, duration: TOKEN_DURATION_SECONDS }),
      signal: AbortSignal.timeout(10_000),
    });
    const parsed = tokenResponseSchema.safeParse(await upstream.json().catch(() => undefined));
    if (!upstream.ok || !parsed.success) {
      await sessions.releaseRealtimeCall(admission.learnerId, admission.leaseId);
      admission = null;
      return unavailable(upstream.status >= 500 ? 503 : 502);
    }

    const callId = `rtc_fal_${reservation.leaseId.replaceAll("-", "")}`;
    if (!await sessions.activateRealtimeCall(
      learner.learnerId,
      input.sessionId,
      reservation.leaseId,
      callId,
    )) {
      await sessions.releaseRealtimeCall(admission.learnerId, admission.leaseId);
      admission = null;
      return unavailable();
    }
    admission = null;

    return Response.json(
      { token: parsed.data, expiresInSeconds: TOKEN_DURATION_SECONDS },
      { headers: PRIVATE_NO_STORE_HEADERS },
    );
  } catch (error) {
    if (admission) {
      await getPersistenceServicesFromEnv().sessions
        .releaseRealtimeCall(admission.learnerId, admission.leaseId)
        .catch(() => undefined);
    }
    const authResponse = authErrorResponse(error);
    if (authResponse.status !== 500) return authResponse;
    const sessionResponse = sessionApiErrorResponse(error);
    if (sessionResponse.status !== 500) return sessionResponse;
    return unavailable();
  }
}
