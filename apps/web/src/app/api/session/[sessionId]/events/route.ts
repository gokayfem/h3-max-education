import { requireSession } from "@/lib/server/auth";
import { sessionApiErrorResponse } from "@/lib/server/session/http";
import { createSessionServiceFromEnv } from "@/lib/server/session/runtime";
import { sessionIdSchema } from "@/lib/server/session/schemas";
import { SessionServiceError } from "@/lib/server/session/service";
import type { SessionEvent } from "@axiom/protocol";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const encoder = new TextEncoder();
const POLL_INTERVAL_MS = 1_000;
const HEARTBEAT_INTERVAL_MS = 12_000;
const STREAM_LIFETIME_MS = 55_000;

type Context = { params: Promise<{ sessionId: string }> };

function encodeEvent(event: SessionEvent, eventId: number): Uint8Array {
  return encoder.encode(`id: ${eventId}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
}

export async function GET(request: Request, context: Context): Promise<Response> {
  try {
    const learner = await requireSession(request);
    const parsedSessionId = sessionIdSchema.safeParse((await context.params).sessionId);
    if (!parsedSessionId.success) throw new SessionServiceError(400, "invalid_session_id", "The session identifier is invalid.");

    const url = new URL(request.url);
    const suppliedCursor = url.searchParams.get("cursor") ?? request.headers.get("last-event-id") ?? "0";
    const cursor = Number(suppliedCursor);
    if (!Number.isInteger(cursor) || cursor < 0) throw new SessionServiceError(400, "invalid_cursor", "The event cursor is invalid.");

    const once = url.searchParams.get("once");
    if (once !== null && once !== "1") {
      throw new SessionServiceError(400, "invalid_event_mode", "The event delivery mode is invalid.");
    }
    if (request.signal.aborted) {
      throw new SessionServiceError(499, "request_aborted", "The event request was cancelled.");
    }

    const service = createSessionServiceFromEnv();
    if (once === "1") {
      const page = await service.readEventPage(learner, parsedSessionId.data, cursor);
      return Response.json(page, {
        headers: { "Cache-Control": "no-store" },
      });
    }
    const lease = await service.openEventStream(learner, parsedSessionId.data, cursor, STREAM_LIFETIME_MS);
    const initial = lease.initial;
    let nextCursor = initial.cursor;
    let stopped = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const startedAt = Date.now();
        let lastHeartbeatAt = startedAt;
        controller.enqueue(encoder.encode("retry: 2000\n\n"));
        initial.events.forEach((event, index) => {
          controller.enqueue(encodeEvent(event, cursor + index + 1));
        });

        void (async () => {
          try {
            while (!stopped && !request.signal.aborted && Date.now() - startedAt < STREAM_LIFETIME_MS) {
              const { promise, resolve } = Promise.withResolvers<void>();
              setTimeout(resolve, POLL_INTERVAL_MS);
              await promise;
              if (stopped || request.signal.aborted) break;
              const page = await lease.read(nextCursor);
              const pageStart = nextCursor;
              nextCursor = page.cursor;
              page.events.forEach((event, index) => {
                controller.enqueue(encodeEvent(event, pageStart + index + 1));
              });
              if (Date.now() - lastHeartbeatAt >= HEARTBEAT_INTERVAL_MS) {
                controller.enqueue(encoder.encode(`: keepalive ${Date.now()}\n\n`));
                lastHeartbeatAt = Date.now();
              }
            }
          } finally {
            await lease.release();
            if (!stopped) {
              stopped = true;
              controller.close();
            }
          }
        })().catch(async () => {
          await lease.release();
          if (!stopped) controller.close();
        });
      },
      cancel() {
        stopped = true;
        return lease.release();
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-store, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  } catch (error) {
    return sessionApiErrorResponse(error);
  }
}
