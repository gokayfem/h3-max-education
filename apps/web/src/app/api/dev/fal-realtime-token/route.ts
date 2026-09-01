import "server-only";

import { z } from "zod";
import { assertSameOrigin, authErrorResponse } from "@/lib/server/auth";
import { isFalFeatureEnabled } from "@/lib/server/fal-config";

export const runtime = "nodejs";

const MODEL = "xai/grok-voice/realtime";
const TOKEN_DURATION_SECONDS = 120;
const PRIVATE_NO_STORE_HEADERS = { "Cache-Control": "no-store, private" };
const tokenResponseSchema = z.string().min(16).max(8_192);

function unavailable(status = 503): Response {
  return Response.json(
    { error: "Grok Voice is unavailable." },
    { status, headers: PRIVATE_NO_STORE_HEADERS },
  );
}

export async function POST(request: Request): Promise<Response> {
  if (process.env.NODE_ENV === "production") {
    return new Response(null, { status: 404, headers: PRIVATE_NO_STORE_HEADERS });
  }

  try {
    assertSameOrigin(request);
    const falKey = process.env.FAL_KEY?.trim();
    if (!falKey || !isFalFeatureEnabled(process.env, "FAL_GROK_VOICE_ENABLED")) {
      return unavailable();
    }

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
      return unavailable(upstream.status >= 500 ? 503 : 502);
    }

    return Response.json(
      { token: parsed.data, expiresInSeconds: TOKEN_DURATION_SECONDS },
      { headers: PRIVATE_NO_STORE_HEADERS },
    );
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse.status !== 500) return authResponse;
    return unavailable();
  }
}
