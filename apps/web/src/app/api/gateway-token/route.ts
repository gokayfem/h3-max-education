import { requireMutationSession } from "@/lib/server/auth";
import { mintGatewayTicket } from "@/lib/server/realtime/gateway-ticket";
import { parseJsonBody, sessionApiErrorResponse } from "@/lib/server/session/http";
import { sessionIdSchema } from "@/lib/server/session/schemas";
import { SessionServiceError } from "@/lib/server/session/service";
import { z } from "zod";

export const runtime = "nodejs";

const gatewayTokenRequestSchema = z.strictObject({
  sessionId: sessionIdSchema,
  callId: z.string().regex(/^rtc_[A-Za-z0-9_-]{4,240}$/u),
});

export async function POST(request: Request): Promise<Response> {
  try {
    const learner = await requireMutationSession(request);
    const { sessionId, callId } = await parseJsonBody(request, gatewayTokenRequestSchema);
    const grant = await mintGatewayTicket(learner.learnerId, sessionId, callId);
    if (!grant) {
      throw new SessionServiceError(
        409,
        "realtime_call_not_active",
        "The realtime call is not active for this session.",
      );
    }
    return Response.json(
      grant,
      { headers: { "Cache-Control": "no-store, private" } },
    );
  } catch (error) {
    return sessionApiErrorResponse(error);
  }
}
