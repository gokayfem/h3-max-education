import "server-only";

import { requireMutationSession } from "@/lib/server/auth";
import { mintGatewayTicket } from "@/lib/server/realtime/gateway-ticket";
import {
  readBoundedRequestBody,
  sessionApiErrorResponse,
} from "@/lib/server/session/http";
import {
  createSessionServiceFromEnv,
  getPersistenceServicesFromEnv,
} from "@/lib/server/session/runtime";
import { sessionIdSchema } from "@/lib/server/session/schemas";
import { z } from "zod";
import { buildTutorInstructions, TUTOR_TOOL_DEFINITIONS } from "@axiom/protocol";

export const runtime = "nodejs";

const OPENAI_REALTIME_CALLS_URL = "https://api.openai.com/v1/realtime/calls";
const MAX_SDP_BYTES = 100_000;

const sdpSchema = z.string().min(4).max(MAX_SDP_BYTES).refine((sdp) => sdp.startsWith("v=0"), {
  message: "Invalid SDP offer"
});

const realtimeAttemptIdSchema = z.string().uuid();

interface ProxyRealtimeCallInput {
  sdp: string;
  learnerId: string;
  ageBand?: "13-15" | "16-18" | undefined;
  apiKey: string | undefined;
  model?: string | undefined;
  fetchImplementation?: typeof fetch;
}


async function createSafetyIdentifier(learnerId: string, apiKey: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(apiKey),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const digest = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`openai-safety:${learnerId}`))
  );
  return Buffer.from(digest).toString("base64url");
}

export async function proxyRealtimeCall(input: ProxyRealtimeCallInput): Promise<Response> {
  const apiKey = input.apiKey?.trim();
  if (!apiKey) {
    return Response.json(
      { mode: "text", recoverable: true, code: "OPENAI_NOT_CONFIGURED" },
      { status: 503 }
    );
  }

  const session = {
    type: "realtime",
    model: input.model?.trim() || "gpt-realtime-2.1",
    instructions: buildTutorInstructions(
      input.ageBand ? `Authenticated learner age band: ${input.ageBand}.` : "",
    ),
    output_modalities: ["audio"],
    audio: {
      input: {
        transcription: { model: "gpt-4o-mini-transcribe" },
        turn_detection: {
          type: "semantic_vad",
          create_response: true,
          interrupt_response: true
        }
      },
      output: { voice: "marin" }
    },
    tools: TUTOR_TOOL_DEFINITIONS,
    tool_choice: "auto"
  };
  const form = new FormData();
  form.set("sdp", input.sdp);
  form.set("session", JSON.stringify(session));

  const fetchImplementation = input.fetchImplementation ?? fetch;
  let upstream: Response;
  try {
    upstream = await fetchImplementation(OPENAI_REALTIME_CALLS_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "openai-safety-identifier": await createSafetyIdentifier(input.learnerId, apiKey)
      },
      body: form,
      signal: AbortSignal.timeout(15_000)
    });
  } catch {
    return Response.json(
      { mode: "text", recoverable: true, code: "OPENAI_UNAVAILABLE" },
      { status: 503 }
    );
  }

  if (!upstream.ok) {
    return Response.json(
      { mode: "text", recoverable: true, code: "OPENAI_NEGOTIATION_FAILED" },
      { status: 503 }
    );
  }

  const location = upstream.headers.get("location") ?? "";
  const callId = location.split("/").at(-1);
  if (!callId || !/^rtc_[A-Za-z0-9_-]{4,240}$/u.test(callId)) {
    return Response.json(
      { mode: "text", recoverable: true, code: "OPENAI_CALL_ID_MISSING" },
      { status: 503 }
    );
  }

  return new Response(await upstream.text(), {
    status: 201,
    headers: {
      "content-type": "application/sdp",
      "cache-control": "no-store",
      "x-axiom-openai-call-id": callId
    }
  });
}

export async function POST(request: Request): Promise<Response> {
  try {
    const learner = await requireMutationSession(request);
    const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    if (contentType !== "application/sdp") {
      return Response.json({ error: { code: "invalid_content_type", message: "Expected an SDP offer." } }, { status: 415 });
    }

    const sessionId = sessionIdSchema.safeParse(request.headers.get("x-axiom-session-id"));
    if (!sessionId.success) {
      return Response.json({ error: { code: "invalid_session_id", message: "A valid session id is required." } }, { status: 400 });
    }

    const attemptId = realtimeAttemptIdSchema.safeParse(
      request.headers.get("x-axiom-realtime-attempt"),
    );
    if (!attemptId.success) {
      return Response.json(
        { error: { code: "invalid_realtime_attempt", message: "A valid realtime attempt id is required." } },
        { status: 400 },
      );
    }

    const reconnectHeader = request.headers.get("x-axiom-realtime-reconnect");
    if (reconnectHeader !== null && reconnectHeader !== "1") {
      return Response.json(
        { error: { code: "invalid_realtime_reconnect", message: "The realtime reconnect marker is invalid." } },
        { status: 400 },
      );
    }

    const declaredLength = Number(request.headers.get("content-length") ?? 0);
    if (Number.isFinite(declaredLength) && declaredLength > MAX_SDP_BYTES) {
      return Response.json({ error: { code: "sdp_too_large", message: "The SDP offer is too large." } }, { status: 413 });
    }

    const sdp = sdpSchema.safeParse(
      new TextDecoder().decode(await readBoundedRequestBody(request, MAX_SDP_BYTES)),
    );
    if (!sdp.success) {
      return Response.json({ error: { code: "invalid_sdp", message: "The SDP offer is invalid." } }, { status: 400 });
    }

    await createSessionServiceFromEnv().authorizeActiveSession(learner, sessionId.data);
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey?.trim()) {
      return proxyRealtimeCall({
        sdp: sdp.data,
        learnerId: learner.learnerId,
        ageBand: learner.ageBand,
        apiKey,
        model: process.env.OPENAI_REALTIME_MODEL
      });
    }

    const sessions = getPersistenceServicesFromEnv().sessions;
    const admission = reconnectHeader === "1"
      ? await sessions.replaceRealtimeCall(
        learner.learnerId,
        sessionId.data,
        attemptId.data,
      )
      : await sessions.reserveRealtimeCall(
        learner.learnerId,
        sessionId.data,
        attemptId.data,
      );
    if (!admission.allowed) {
      if (admission.reason === "terminal") {
        return Response.json(
          { error: { code: "session_ended", message: "This lesson has already ended." } },
          { status: 409 },
        );
      }
      return Response.json(
        { mode: "text", recoverable: true, code: "REALTIME_RATE_LIMITED" },
        {
          status: 429,
          headers: { "Retry-After": String(admission.retryAfterSeconds) }
        }
      );
    }
    const response = await proxyRealtimeCall({
      sdp: sdp.data,
      learnerId: learner.learnerId,
      ageBand: learner.ageBand,
      apiKey,
      model: process.env.OPENAI_REALTIME_MODEL
    });
    if (response.status !== 201) {
      await sessions.releaseRealtimeCall(learner.learnerId, admission.leaseId)
        .catch(() => console.error("Realtime admission lease release failed"));
      return response;
    }
    const callId = response.headers.get("x-axiom-openai-call-id");
    let activated = false;
    let gatewayTicket;
    if (callId) {
      try {
        activated = await sessions.activateRealtimeCall(
          learner.learnerId,
          sessionId.data,
          admission.leaseId,
          callId,
        );
        if (activated) {
          gatewayTicket = await mintGatewayTicket(learner.learnerId, sessionId.data, callId);
        }
      } catch {
        activated = false;
      }
    }
    if (!activated || !gatewayTicket) {
      // This integration has no provider call-delete operation; OpenAI owns expiry of the unattached call.
      await sessions.releaseRealtimeSession(sessionId.data)
        .catch(() => console.error("Realtime session release failed"));
      await sessions.releaseRealtimeCall(learner.learnerId, admission.leaseId)
        .catch(() => console.error("Realtime admission lease release failed"));
      return Response.json(
        { mode: "text", recoverable: true, code: "REALTIME_ACTIVATION_FAILED" },
        { status: 503 },
      );
    }
    const responseHeaders = new Headers(response.headers);
    responseHeaders.set("x-axiom-gateway-ticket", gatewayTicket.token);
    responseHeaders.set("cache-control", "no-store, private");
    responseHeaders.set("x-axiom-command-revision", String(gatewayTicket.commandRevision));
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
    });
  } catch (error) {
    return sessionApiErrorResponse(error);
  }
}
