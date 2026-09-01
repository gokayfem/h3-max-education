import "server-only";

import { AuthError, AuthRegistryUnavailable, authErrorResponse } from "@/lib/server/auth";
import { ZodError, type ZodType } from "zod";
import { SessionServiceError } from "./service";

export const MAX_JSON_BYTES = 16_384;

function requestTooLarge(): SessionServiceError {
  return new SessionServiceError(413, "request_too_large", "The request body is too large.");
}

function cancelWithoutWaiting(stream: ReadableStream<Uint8Array>): void {
  void stream.cancel().catch(() => undefined);
}

export async function readBoundedRequestBody(request: Request, maxBytes: number): Promise<Uint8Array> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new TypeError("maxBytes must be a non-negative safe integer");
  }

  const contentLength = request.headers.get("content-length")?.trim();
  if (contentLength && /^\d+$/u.test(contentLength)) {
    const declaredLength = Number(contentLength);
    if (!Number.isSafeInteger(declaredLength) || declaredLength > maxBytes) {
      if (request.body) cancelWithoutWaiting(request.body);
      throw requestTooLarge();
    }
  }

  if (!request.body) return new Uint8Array();

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value.byteLength > maxBytes - totalBytes) {
      void reader.cancel().catch(() => undefined);
      throw requestTooLarge();
    }
    chunks.push(value);
    totalBytes += value.byteLength;
  }

  if (chunks.length === 0) return new Uint8Array();
  if (chunks.length === 1) return chunks[0]!;
  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

export async function readBoundedJsonBody(
  request: Request,
  maxBytes = MAX_JSON_BYTES,
): Promise<unknown> {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    if (request.body) cancelWithoutWaiting(request.body);
    throw new SessionServiceError(415, "unsupported_media_type", "Use application/json for this request.");
  }

  const raw = new TextDecoder().decode(await readBoundedRequestBody(request, maxBytes));
  try {
    return JSON.parse(raw);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new SessionServiceError(400, "invalid_request", "The request body must be valid JSON.");
    }
    throw error;
  }
}

export async function parseJsonBody<T>(
  request: Request,
  schema: ZodType<T>,
  maxBytes = MAX_JSON_BYTES,
): Promise<T> {
  const body = await readBoundedJsonBody(request, maxBytes);
  try {
    return schema.parse(body);
  } catch (error) {
    if (error instanceof ZodError) {
      throw new SessionServiceError(400, "invalid_request", "The request body did not match the expected shape.");
    }
    throw error;
  }
}

export function sessionApiErrorResponse(error: unknown): Response {
  if (error instanceof AuthError || error instanceof AuthRegistryUnavailable) return authErrorResponse(error);
  if (error instanceof SessionServiceError) {
    const headers = error.retryAfterSeconds === undefined ? undefined : { "Retry-After": String(error.retryAfterSeconds) };
    return Response.json(
      { error: { code: error.code, message: error.message } },
      { status: error.status, headers },
    );
  }
  console.error("Session API request failed", error);
  return Response.json(
    { error: { code: "internal_error", message: "The request could not be completed." } },
    { status: 500 },
  );
}
