import "server-only";

import { z } from "zod";
import { authErrorResponse, requireMutationSession } from "@/lib/server/auth";
import { parseJsonBody, sessionApiErrorResponse } from "@/lib/server/session/http";
import { activeLessonStateSchema } from "@/lib/server/session/schemas";
import { getPersistenceServicesFromEnv } from "@/lib/server/session/runtime";
const requestSchema = z.strictObject({
  sessionId: z.uuid(),
  reservationId: z.uuid()
});

const PRIVATE_NO_STORE_HEADERS = { "Cache-Control": "no-store, private" };

function configuredPositiveInteger(name: string, defaultValue: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return defaultValue;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

export async function POST(request: Request): Promise<Response> {
  try {
    const learner = await requireMutationSession(request);
    const input = await parseJsonBody(request, requestSchema);
    const persistence = getPersistenceServicesFromEnv();
    const state = activeLessonStateSchema.safeParse(
      await persistence.sessions.getActiveState(input.sessionId)
    );
    if (!state.success || state.data.learnerId !== learner.learnerId) {
      return Response.json(
        { error: { code: "session_not_found", message: "Session not found or expired." } },
        { status: 404 }
      );
    }

    const dailyLimitSeconds = configuredPositiveInteger("DAILY_VIDEO_SECONDS", 120);
    const release = await persistence.sessions.releaseVisualEntitlement(
      learner.learnerId,
      input.sessionId,
      input.reservationId,
      false,
      dailyLimitSeconds,
    );
    return Response.json(
      { remainingSeconds: release.remainingSeconds, dailyLimitSeconds },
      { headers: PRIVATE_NO_STORE_HEADERS },
    );
  } catch (error) {
    const bodyResponse = sessionApiErrorResponse(error);
    if (bodyResponse.status !== 500) return bodyResponse;
    const authResponse = authErrorResponse(error);
    if (authResponse.status !== 500) return authResponse;
    return Response.json(
      { error: { code: "visual_unavailable", message: "Visual generation is unavailable." } },
      { status: 502 }
    );
  }
}
