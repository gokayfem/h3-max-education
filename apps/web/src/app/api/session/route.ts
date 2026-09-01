import { requireMutationSession } from "@/lib/server/auth";
import { parseJsonBody, sessionApiErrorResponse } from "@/lib/server/session/http";
import { createSessionServiceFromEnv } from "@/lib/server/session/runtime";
import { createSessionInputSchema } from "@/lib/server/session/schemas";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  try {
    const learner = await requireMutationSession(request);
    const input = await parseJsonBody(request, createSessionInputSchema);
    const result = await createSessionServiceFromEnv().create(learner, input);
    return Response.json(result, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return sessionApiErrorResponse(error);
  }
}
