import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  authenticateGatewayToken,
  isAllowedWebSocketOrigin,
  verifyGatewayToken,
} from "./auth.js";

const GATEWAY_SECRET = "gateway-test-secret-that-is-at-least-32-chars";
const DIFFERENT_SECRET = "different-gateway-secret-at-least-32-characters";
const SESSION_ID = "33333333-3333-4333-8333-333333333333";
const CALL_ID = "call_12345678";
const NOW = 1_800_000_000;

function sign(payload: object, secret = GATEWAY_SECRET): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${signature}`;
}

function payload(overrides: Record<string, unknown> = {}) {
  return {
    v: 1,
    learnerId: "lrn_abcdefghijklmnop",
    sessionId: SESSION_ID,
    callId: CALL_ID,
    exp: NOW + 60,
    nonce: "44444444-4444-4444-8444-444444444444",
    ...overrides,
  };
}

describe("gateway credential authentication", () => {
  it("binds the credential to both session and provider call", () => {
    const token = sign(payload());
    expect(verifyGatewayToken(token, GATEWAY_SECRET, SESSION_ID, CALL_ID, NOW)).toEqual(payload());
    expect(verifyGatewayToken(token, DIFFERENT_SECRET, SESSION_ID, CALL_ID, NOW)).toBeUndefined();
    expect(verifyGatewayToken(
      token,
      GATEWAY_SECRET,
      "55555555-5555-4555-8555-555555555555",
      CALL_ID,
      NOW,
    )).toBeUndefined();
    expect(verifyGatewayToken(token, GATEWAY_SECRET, SESSION_ID, "call_substitute", NOW)).toBeUndefined();
  });

  it("rejects expired, overlong, malformed, and tampered credentials", () => {
    const token = sign(payload());
    expect(verifyGatewayToken(token, GATEWAY_SECRET, SESSION_ID, CALL_ID, NOW + 60)).toBeUndefined();
    expect(verifyGatewayToken(sign(payload({ exp: NOW + 61 })), GATEWAY_SECRET, SESSION_ID, CALL_ID, NOW)).toBeUndefined();
    expect(verifyGatewayToken(`${token}x`, GATEWAY_SECRET, SESSION_ID, CALL_ID, NOW)).toBeUndefined();
    expect(verifyGatewayToken("one-segment", GATEWAY_SECRET, SESSION_ID, CALL_ID, NOW)).toBeUndefined();
    expect(verifyGatewayToken("a.b.c", GATEWAY_SECRET, SESSION_ID, CALL_ID, NOW)).toBeUndefined();
    expect(verifyGatewayToken(sign({ ...payload(), extra: true }), GATEWAY_SECRET, SESSION_ID, CALL_ID, NOW)).toBeUndefined();
    expect(verifyGatewayToken(sign(payload({ nonce: "not-a-uuid" })), GATEWAY_SECRET, SESSION_ID, CALL_ID, NOW)).toBeUndefined();
  });

  it("claims the nonce exactly once so a captured credential cannot be replayed", async () => {
    const claimed = new Set<string>();
    const claimNonce = vi.fn(async (nonce: string) => {
      if (claimed.has(nonce)) return false;
      claimed.add(nonce);
      return true;
    });
    const token = sign(payload());
    await expect(authenticateGatewayToken(token, GATEWAY_SECRET, SESSION_ID, CALL_ID, claimNonce, NOW))
      .resolves.toMatchObject({ learnerId: "lrn_abcdefghijklmnop" });
    await expect(authenticateGatewayToken(token, GATEWAY_SECRET, SESSION_ID, CALL_ID, claimNonce, NOW))
      .resolves.toBeUndefined();
    expect(claimNonce).toHaveBeenCalledTimes(2);
  });

  it("rejects malformed envelopes without throwing", () => {
    const invalidJsonBody = Buffer.from("not-json").toString("base64url");
    const invalidJsonSignature = createHmac("sha256", GATEWAY_SECRET).update(invalidJsonBody).digest("base64url");
    expect(verifyGatewayToken(undefined, GATEWAY_SECRET, SESSION_ID, CALL_ID)).toBeUndefined();
    expect(verifyGatewayToken("!.also-bad", GATEWAY_SECRET, SESSION_ID, CALL_ID)).toBeUndefined();
    expect(verifyGatewayToken(`${invalidJsonBody}.${invalidJsonSignature}`, GATEWAY_SECRET, SESSION_ID, CALL_ID, NOW)).toBeUndefined();
    expect(verifyGatewayToken(".signature", GATEWAY_SECRET, SESSION_ID, CALL_ID, NOW)).toBeUndefined();
    expect(verifyGatewayToken("payload.!", GATEWAY_SECRET, SESSION_ID, CALL_ID, NOW)).toBeUndefined();
    const oversizedBody = Buffer.alloc(2_049, 1).toString("base64url");
    const oversizedSignature = createHmac("sha256", GATEWAY_SECRET)
      .update(oversizedBody)
      .digest("base64url");
    expect(
      verifyGatewayToken(
        `${oversizedBody}.${oversizedSignature}`,
        GATEWAY_SECRET,
        SESSION_ID,
        CALL_ID,
        NOW,
      ),
    ).toBeUndefined();
  });
});

describe("upgrade request helpers", () => {
  it("rejects cross-origin WebSocket upgrades when an origin is configured", () => {
    expect(isAllowedWebSocketOrigin("https://science.example", "https://science.example")).toBe(true);
    expect(isAllowedWebSocketOrigin("https://attacker.example", "https://science.example")).toBe(false);
    expect(isAllowedWebSocketOrigin(undefined, "https://science.example")).toBe(false);
    expect(isAllowedWebSocketOrigin("anything", undefined)).toBe(true);
  });
});
