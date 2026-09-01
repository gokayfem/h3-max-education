import { assertSameOrigin, requireSession } from "@/lib/server/auth";
import {
  BROWSER_METRIC_RATE_LIMIT,
  browserMetricEventSchema,
  MAX_BROWSER_METRIC_BYTES,
  recordBrowserMetric,
} from "@/lib/server/telemetry/browser-metrics";
import { parseJsonBody, sessionApiErrorResponse } from "@/lib/server/session/http";
import { getPersistenceServicesFromEnv } from "@/lib/server/session/runtime";
import { SessionServiceError } from "@/lib/server/session/service";

export const runtime = "nodejs";

const NO_STORE = "no-store";

function noStore(response: Response): Response {
  response.headers.set("Cache-Control", NO_STORE);
  return response;
}

export async function POST(request: Request): Promise<Response> {
  try {
    assertSameOrigin(request);
    const learner = await requireSession(request);
    const persistence = getPersistenceServicesFromEnv();
    const rate = await persistence.sessions.consumeRateLimit(
      `browser-metrics:${learner.learnerId}`,
      BROWSER_METRIC_RATE_LIMIT,
    );
    if (!rate.allowed) {
      throw new SessionServiceError(
        429,
        "rate_limited",
        "Too many metric events.",
        rate.resetAfterSeconds,
      );
    }

    const event = await parseJsonBody(request, browserMetricEventSchema, MAX_BROWSER_METRIC_BYTES);
    await recordBrowserMetric(persistence.repository, event, {
      userAgent: request.headers.get("user-agent"),
      deploymentRegion:
        process.env.FLY_REGION
        ?? process.env.VERCEL_REGION
        ?? process.env.REGION,
    });
    return new Response(null, { status: 204, headers: { "Cache-Control": NO_STORE } });
  } catch (error) {
    return noStore(sessionApiErrorResponse(error));
  }
}
