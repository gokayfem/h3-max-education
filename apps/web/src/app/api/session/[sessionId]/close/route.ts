import { requireMutationSession } from "@/lib/server/auth";
import { parseJsonBody, sessionApiErrorResponse } from "@/lib/server/session/http";
import { createSessionServiceFromEnv } from "@/lib/server/session/runtime";
import { closeInputSchema, sessionIdSchema } from "@/lib/server/session/schemas";
import { SessionServiceError } from "@/lib/server/session/service";

export const runtime = "nodejs";

type Context = { params: Promise<{ sessionId: string }> };

export async function POST(request: Request, context: Context): Promise<Response> {
  try {
    const learner = await requireMutationSession(request);
    const parsedSessionId = sessionIdSchema.safeParse((await context.params).sessionId);
    if (!parsedSessionId.success) throw new SessionServiceError(400, "invalid_session_id", "The session identifier is invalid.");
    const input = await parseJsonBody(request, closeInputSchema);
    const result = await createSessionServiceFromEnv().close(learner, parsedSessionId.data, input);
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return sessionApiErrorResponse(error);
  }
}
