import "server-only";

import { cookies } from "next/headers";
import { getPersistenceServicesFromEnv } from "./session/runtime";

export const SESSION_COOKIE_NAME = "axiom_session";
export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
export const GATEWAY_TOKEN_TTL_SECONDS = 60;

const DEVELOPMENT_GATEWAY_SECRET =
  "axiom-local-development-gateway-secret-change-me";
const LEARNER_ID_BYTES = 18;

export const AGE_BANDS = ["13-15", "16-18"] as const;

export type AgeBand = (typeof AGE_BANDS)[number];

export interface SessionPayload {
  readonly v: 1;
  readonly sid: string;
  readonly learnerId: string;
  readonly displayName: string;
  readonly ageBand: AgeBand;
}

export interface PublicLearner {
  readonly learnerId: string;
  readonly displayName: string;
  readonly ageBand: AgeBand;
}

export interface GatewayTokenPayload {
  readonly v: 1;
  readonly learnerId: string;
  readonly sessionId: string;
  readonly callId: string;
  readonly exp: number;
  readonly nonce: string;
}

export class AuthError extends Error {
  constructor(
    readonly status: 401 | 403,
    readonly code: "authentication_required" | "invalid_origin",
    message: string,
  ) {
    super(message);
    this.name = "AuthError";
  }
}

export class AuthRegistryUnavailable extends Error {
  readonly status = 503;
  readonly code = "auth_registry_unavailable";

  constructor(cause?: unknown) {
    super("The learner session registry is temporarily unavailable.", { cause });
    this.name = "AuthRegistryUnavailable";
  }
}

function resolveGatewaySecret(explicitSecret?: string): string {
  const secret = explicitSecret?.trim() || process.env.GATEWAY_AUTH_SECRET?.trim();
  if (secret) {
    if (secret.length < 32) {
      throw new Error("GATEWAY_AUTH_SECRET must contain at least 32 characters");
    }
    return secret;
  }

  if (process.env.NODE_ENV === "production") {
    throw new Error("GATEWAY_AUTH_SECRET is required in production");
  }

  return DEVELOPMENT_GATEWAY_SECRET;
}


export function assertSessionConfiguration(): void {
  if (!globalThis.crypto?.randomUUID) {
    throw new Error("A cryptographically secure random source is required");
  }
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}


async function importHmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

function isAgeBand(value: unknown): value is AgeBand {
  return typeof value === "string" && AGE_BANDS.includes(value as AgeBand);
}

function isUuid(value: unknown): value is string {
  return typeof value === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}

function parseSessionPayload(value: unknown): SessionPayload | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }

  const payload = value as Record<string, unknown>;
  if (
    payload.v !== 1 ||
    !isUuid(payload.sid) ||
    typeof payload.learnerId !== "string" ||
    !/^lrn_[A-Za-z0-9_-]{16,32}$/u.test(payload.learnerId) ||
    typeof payload.displayName !== "string" ||
    payload.displayName !== payload.displayName.trim() ||
    payload.displayName.length < 2 ||
    payload.displayName.length > 40 ||
    !isAgeBand(payload.ageBand)
  ) {
    return null;
  }

  return {
    v: 1,
    sid: payload.sid,
    learnerId: payload.learnerId,
    displayName: payload.displayName,
    ageBand: payload.ageBand,
  };
}

export function createSessionToken(): string {
  return crypto.randomUUID();
}

export async function verifySessionToken(
  token: string | null | undefined,
): Promise<SessionPayload | null> {
  if (!token || !isUuid(token)) {
    return null;
  }

  try {
    const persistence = getPersistenceServicesFromEnv();
    const learnerId = await persistence.sessions.getAuthSessionLearner(token);
    if (!learnerId) {
      return null;
    }
    const profile = await persistence.repository.getProfile(learnerId);
    if (!profile) {
      return null;
    }
    return parseSessionPayload({
      v: 1,
      sid: token,
      learnerId,
      displayName: profile.displayName,
      ageBand: profile.ageBand,
    });
  } catch (error) {
    throw new AuthRegistryUnavailable(error);
  }
}

function cookieFromRequest(request: Request): string | null {
  const cookieHeader = request.headers.get("cookie");
  if (!cookieHeader) {
    return null;
  }

  for (const pair of cookieHeader.split(";")) {
    const separator = pair.indexOf("=");
    if (separator < 0) {
      continue;
    }
    const name = pair.slice(0, separator).trim();
    if (name === SESSION_COOKIE_NAME) {
      return pair.slice(separator + 1).trim() || null;
    }
  }

  return null;
}

export async function getSession(
  request?: Request,
): Promise<SessionPayload | null> {
  assertSessionConfiguration();
  const token = request
    ? cookieFromRequest(request)
    : (await cookies()).get(SESSION_COOKIE_NAME)?.value;
  if (!token) return null;
  const session = await verifySessionToken(token);
  if (!session) {
    throw new AuthError(
      401,
      "authentication_required",
      "A valid learner session is required.",
    );
  }
  return session;
}

export async function requireSession(request?: Request): Promise<SessionPayload> {
  const session = await getSession(request);
  if (!session) {
    throw new AuthError(
      401,
      "authentication_required",
      "A valid learner session is required.",
    );
  }
  return session;
}

export function assertSameOrigin(request: Request): void {
  const originHeader = request.headers.get("origin");
  const hostHeader =
    request.headers.get("x-forwarded-host")?.split(",", 1)[0]?.trim() ||
    request.headers.get("host");
  const forwardedProtocol = request.headers
    .get("x-forwarded-proto")
    ?.split(",", 1)[0]
    ?.trim();
  let origin = "";
  let expectedOrigin = "";

  try {
    origin = originHeader ? new URL(originHeader).origin : "";
    const requestUrl = new URL(request.url);
    const protocol =
      forwardedProtocol === "http" || forwardedProtocol === "https"
        ? `${forwardedProtocol}:`
        : requestUrl.protocol;
    expectedOrigin = hostHeader
      ? new URL(`${protocol}//${hostHeader}`).origin
      : requestUrl.origin;
  } catch {
    origin = "";
    expectedOrigin = "";
  }

  if (!origin || origin !== expectedOrigin) {
    throw new AuthError(
      403,
      "invalid_origin",
      "The request origin is not allowed.",
    );
  }
}

export async function requireMutationSession(
  request: Request,
): Promise<SessionPayload> {
  assertSameOrigin(request);
  return requireSession(request);
}

export function authErrorResponse(error: unknown): Response {
  if (error instanceof AuthError || error instanceof AuthRegistryUnavailable) {
    return Response.json(
      { error: { code: error.code, message: error.message } },
      { status: error.status, headers: { "Cache-Control": "no-store" } },
    );
  }

  return Response.json(
    {
      error: {
        code: "internal_error",
        message: "The request could not be completed.",
      },
    },
    { status: 500, headers: { "Cache-Control": "no-store" } },
  );
}

export function publicLearner(session: SessionPayload): PublicLearner {
  return {
    learnerId: session.learnerId,
    displayName: session.displayName,
    ageBand: session.ageBand,
  };
}

export async function createLearnerId(): Promise<string> {
  const randomBytes = new Uint8Array(LEARNER_ID_BYTES);
  crypto.getRandomValues(randomBytes);
  return `lrn_${encodeBase64Url(randomBytes)}`;
}

function parseGatewayTokenPayload(value: unknown): GatewayTokenPayload | null {
  if (typeof value !== "object" || value === null) return null;
  const payload = value as Record<string, unknown>;
  const keys = Object.keys(payload);
  if (
    keys.length !== 6 ||
    !keys.every((key) => ["v", "learnerId", "sessionId", "callId", "exp", "nonce"].includes(key)) ||
    payload.v !== 1 ||
    typeof payload.learnerId !== "string" ||
    !/^lrn_[A-Za-z0-9_-]{16,32}$/u.test(payload.learnerId) ||
    !isUuid(payload.sessionId) ||
    typeof payload.callId !== "string" ||
    !/^[A-Za-z0-9_-]{8,256}$/u.test(payload.callId) ||
    typeof payload.exp !== "number" ||
    !Number.isSafeInteger(payload.exp) ||
    !isUuid(payload.nonce)
  ) {
    return null;
  }
  return {
    v: 1,
    learnerId: payload.learnerId,
    sessionId: payload.sessionId,
    callId: payload.callId,
    exp: payload.exp,
    nonce: payload.nonce,
  };
}

export async function signGatewayToken(
  payload: GatewayTokenPayload,
  explicitSecret?: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<string> {
  const validated = parseGatewayTokenPayload(payload);
  if (
    !validated ||
    validated.exp <= nowSeconds ||
    validated.exp - nowSeconds > GATEWAY_TOKEN_TTL_SECONDS
  ) {
    throw new TypeError("Cannot sign an invalid gateway token payload");
  }
  const payloadSegment = encodeBase64Url(
    new TextEncoder().encode(JSON.stringify(validated)),
  );
  const key = await importHmacKey(resolveGatewaySecret(explicitSecret));
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(payloadSegment),
  );
  return `${payloadSegment}.${encodeBase64Url(new Uint8Array(signature))}`;
}

export function sessionCookieOptions(secure = process.env.NODE_ENV === "production") {
  return {
    httpOnly: true,
    secure,
    sameSite: "strict" as const,
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
    priority: "high" as const,
  };
}
