import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

const learnerIdSchema = z.string().regex(/^lrn_[A-Za-z0-9_-]{16,32}$/);
const gatewayTokenPayloadSchema = z.strictObject({
  v: z.literal(1),
  learnerId: learnerIdSchema,
  sessionId: z.string().uuid(),
  callId: z.string().regex(/^[A-Za-z0-9_-]{8,256}$/),
  exp: z.number().int().positive(),
  nonce: z.string().uuid(),
});

export interface AuthenticatedLearner {
  readonly learnerId: string;
}
export type GatewayTokenPayload = z.infer<typeof gatewayTokenPayloadSchema>;

type ClaimNonce = (nonce: string) => Promise<boolean>;

function decodeBase64Url(value: string): Buffer | undefined {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return undefined;
  try {
    return Buffer.from(value, "base64url");
  } catch {
    return undefined;
  }
}

function verifyEnvelope(token: string | undefined, secret: string): unknown | undefined {
  if (!token || token.length > 4_096) return undefined;
  const segments = token.split(".");
  if (segments.length !== 2) return undefined;
  const [payloadSegment, signatureSegment] = segments;
  if (!payloadSegment || !signatureSegment) return undefined;
  const suppliedSignature = decodeBase64Url(signatureSegment);
  if (!suppliedSignature) return undefined;
  const expectedSignature = createHmac("sha256", secret).update(payloadSegment).digest();
  if (
    suppliedSignature.length !== expectedSignature.length
    || !timingSafeEqual(suppliedSignature, expectedSignature)
  ) return undefined;
  const payloadBytes = decodeBase64Url(payloadSegment);
  if (!payloadBytes || payloadBytes.length > 2_048) return undefined;
  try {
    return JSON.parse(payloadBytes.toString("utf8")) as unknown;
  } catch {
    return undefined;
  }
}

export function isAllowedWebSocketOrigin(origin: string | undefined, allowedOrigin: string | undefined): boolean {
  return !allowedOrigin || origin === allowedOrigin;
}

export function isAuthorizedMetricsRequest(
  authorization: string | undefined,
  configuredToken: string | undefined,
): boolean {
  if (!authorization || !configuredToken || !authorization.startsWith("Bearer ")) {
    return false;
  }
  const suppliedToken = authorization.slice("Bearer ".length);
  if (!suppliedToken || suppliedToken !== suppliedToken.trim()) {
    return false;
  }
  const suppliedDigest = createHash("sha256").update(suppliedToken).digest();
  const configuredDigest = createHash("sha256").update(configuredToken).digest();
  return timingSafeEqual(suppliedDigest, configuredDigest);
}

export function verifyGatewayToken(
  token: string | undefined,
  secret: string,
  expectedSessionId: string,
  expectedCallId: string,
  nowSeconds = Math.floor(Date.now() / 1_000),
): GatewayTokenPayload | undefined {
  const parsed = gatewayTokenPayloadSchema.safeParse(verifyEnvelope(token, secret));
  if (
    !parsed.success
    || parsed.data.sessionId !== expectedSessionId
    || parsed.data.exp <= nowSeconds
    || parsed.data.callId !== expectedCallId
    || parsed.data.exp > nowSeconds + 60
  ) return undefined;
  return parsed.data;
}

export async function authenticateGatewayToken(
  token: string | undefined,
  secret: string,
  expectedSessionId: string,
  expectedCallId: string,
  claimNonce: ClaimNonce,
  nowSeconds = Math.floor(Date.now() / 1_000),
): Promise<GatewayTokenPayload | undefined> {
  const learner = verifyGatewayToken(token, secret, expectedSessionId, expectedCallId, nowSeconds);
  if (!learner || !(await claimNonce(learner.nonce))) return undefined;
  return learner;
}
