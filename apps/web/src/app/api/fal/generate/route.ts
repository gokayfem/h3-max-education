import "server-only";

import { createFalClient } from "@fal-ai/client";
import { PERMANENT_VIDEO_STYLE } from "@axiom/domain";
import { z } from "zod";
import { authErrorResponse, requireMutationSession } from "@/lib/server/auth";
import { isFalFeatureEnabled } from "@/lib/server/fal-config";
import { parseJsonBody, sessionApiErrorResponse } from "@/lib/server/session/http";
import { getPersistenceServicesFromEnv } from "@/lib/server/session/runtime";

export const runtime = "nodejs";
export const maxDuration = 180;

const MODEL = "minimax/h3-max/text-to-video";
const PRIVATE_NO_STORE_HEADERS = { "Cache-Control": "no-store, private" };
const inputSchema = z.strictObject({
  sessionId: z.uuid(),
  reservationId: z.uuid(),
  durationSeconds: z.literal(5),
  prompt: z.string().trim().min(20).max(2_000).refine(
    (value) => value.startsWith(PERMANENT_VIDEO_STYLE),
    "The permanent video style is required.",
  ),
});
const activeStateSchema = z.object({
  learnerId: z.string().min(1),
  status: z.string().min(1),
}).passthrough();
const providerOutputSchema = z.object({
  video: z.object({
    url: z.url().refine((value) => value.startsWith("https://")),
  }).passthrough(),
}).passthrough();

function configuredDailyLimit(): number {
  const raw = process.env.DAILY_VIDEO_SECONDS?.trim();
  if (!raw) return 120;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error("DAILY_VIDEO_SECONDS must be a positive integer");
  return value;
}

function unavailable(status = 502): Response {
  return Response.json(
    { error: { code: "visual_unavailable", message: "Visual generation is unavailable." } },
    { status, headers: PRIVATE_NO_STORE_HEADERS },
  );
}

export async function POST(request: Request): Promise<Response> {
  let release: (() => Promise<void>) | null = null;
  try {
    const learner = await requireMutationSession(request);
    const input = await parseJsonBody(request, inputSchema, 24_576);
    const falKey = process.env.FAL_KEY?.trim();
    if (!falKey || !isFalFeatureEnabled(process.env, "FAL_QUEUE_ENABLED")) {
      return unavailable(503);
    }

    const dailyLimitSeconds = configuredDailyLimit();
    const sessions = getPersistenceServicesFromEnv().sessions;
    const activeState = activeStateSchema.safeParse(await sessions.getActiveState(input.sessionId));
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

    const identity = {
      learnerId: learner.learnerId,
      sessionId: input.sessionId,
      reservationId: input.reservationId,
      durationSeconds: input.durationSeconds,
    };
    const queuePermit = await sessions.claimVisualIcePermit(identity, false);
    if (!queuePermit || !await sessions.claimVisualEntitlement(identity)) return unavailable(403);

    let rollback = true;
    release = async () => {
      await sessions.releaseVisualEntitlement(
        identity.learnerId,
        identity.sessionId,
        identity.reservationId,
        rollback,
        dailyLimitSeconds,
      );
    };

    try {
      const client = createFalClient({ credentials: falKey });
      const productionPrompt = input.prompt;
      const result = await client.subscribe(MODEL, {
        input: {
          prompt: productionPrompt,
          sync_mode: false,
          resolution: "480P",
          duration: 5,
          aspect_ratio: "16:9",
          prompt_expansion_mode: "balanced",
          enable_safety_checker: true,
        },
        abortSignal: request.signal,
        startTimeout: 120,
      });
      const output = providerOutputSchema.parse(result.data);
      rollback = false;
      await release();
      release = null;
      const remainingSeconds = await sessions.getVisualDailyRemaining(learner.learnerId, dailyLimitSeconds);
      return Response.json({
        videoUrl: output.video.url,
        remainingSeconds,
        dailyLimitSeconds,
      }, {
        headers: {
          ...PRIVATE_NO_STORE_HEADERS,
          "X-Axiom-Video-Url": output.video.url,
          "X-Axiom-Visual-Remaining": String(remainingSeconds),
          "X-Axiom-Visual-Limit": String(dailyLimitSeconds),
        },
      });
    } catch {
      if (release) await release();
      release = null;
      return unavailable();
    }
  } catch (error) {
    if (release) await release().catch(() => undefined);
    const authResponse = authErrorResponse(error);
    if (authResponse.status !== 500) return authResponse;
    const sessionResponse = sessionApiErrorResponse(error);
    if (sessionResponse.status !== 500) return sessionResponse;
    return unavailable();
  }
}
