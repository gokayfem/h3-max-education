import { requireSession } from "@/lib/server/auth";
import { sessionApiErrorResponse } from "@/lib/server/session/http";
import { createSessionServiceFromEnv } from "@/lib/server/session/runtime";
import { recoverQuerySchema, sessionIdSchema } from "@/lib/server/session/schemas";
import { SessionServiceError } from "@/lib/server/session/service";

export const runtime = "nodejs";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ sessionId: string }> };

export async function GET(request: Request, context: Context): Promise<Response> {
  try {
    const learner = await requireSession(request);
    const parsedSessionId = sessionIdSchema.safeParse((await context.params).sessionId);
    if (!parsedSessionId.success) throw new SessionServiceError(400, "invalid_session_id", "The session identifier is invalid.");
    const url = new URL(request.url);
    const query = recoverQuerySchema.safeParse({ cursor: url.searchParams.get("cursor") ?? undefined });
    if (!query.success) throw new SessionServiceError(400, "invalid_cursor", "The recovery cursor is invalid.");
    const result = await createSessionServiceFromEnv().recover(learner, parsedSessionId.data, query.data.cursor);
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return sessionApiErrorResponse(error);
  }
}
