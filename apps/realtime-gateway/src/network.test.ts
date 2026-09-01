import { describe, expect, it } from "vitest";
import {
  GATEWAY_PROTOCOL,
  canonicalizeConnectionIdentity,
  gatewayReadiness,
  parseGatewayProtocols,
} from "./network.js";

describe("gateway network boundaries", () => {
  it("accepts only one bounded ticket following the required protocol", () => {
    expect(parseGatewayProtocols(undefined)).toBeUndefined();
    expect(parseGatewayProtocols([GATEWAY_PROTOCOL])).toBeUndefined();
    expect(parseGatewayProtocols(GATEWAY_PROTOCOL)).toBeUndefined();
    expect(parseGatewayProtocols(`other, axiom.ticket.payload.signature`)).toBeUndefined();
    expect(parseGatewayProtocols(`${GATEWAY_PROTOCOL}, other.payload.signature`)).toBeUndefined();
    expect(parseGatewayProtocols(`${GATEWAY_PROTOCOL}, axiom.ticket.`)).toBeUndefined();
    expect(parseGatewayProtocols(`${GATEWAY_PROTOCOL}, axiom.ticket.bad!ticket`)).toBeUndefined();
    expect(parseGatewayProtocols(`${GATEWAY_PROTOCOL}, axiom.ticket.${"a".repeat(4097)}.b`)).toBeUndefined();
    expect(parseGatewayProtocols(`${GATEWAY_PROTOCOL}, axiom.ticket.payload.signature`)).toEqual({
      protocol: GATEWAY_PROTOCOL,
      ticket: "payload.signature",
    });
  });

  it("canonicalizes trusted IPv4, mapped IPv6, and IPv6 prefixes without trusting forwarded lists", () => {
    expect(canonicalizeConnectionIdentity({ environment: "production", remoteAddress: "127.0.0.1" })).toBeUndefined();
    expect(canonicalizeConnectionIdentity({ environment: "production", flyClientIp: ["203.0.113.1"] })).toBeUndefined();
    expect(canonicalizeConnectionIdentity({ environment: "production", flyClientIp: "203.0.113.1, 198.51.100.1" })).toBeUndefined();
    expect(canonicalizeConnectionIdentity({ environment: "production", flyClientIp: "fe80::1%eth0" })).toBeUndefined();
    expect(canonicalizeConnectionIdentity({ environment: "test", remoteAddress: "not-an-ip" })).toBeUndefined();
    expect(canonicalizeConnectionIdentity({ environment: "test", remoteAddress: "127.0.0.1" })).toBe("127.0.0.1");
    expect(canonicalizeConnectionIdentity({ environment: "test", remoteAddress: "::ffff:192.0.2.128" })).toBe("192.0.2.128");
    expect(canonicalizeConnectionIdentity({ environment: "development", remoteAddress: "fe80::1%eth0" })).toBe("fe80:0:0:0::/64");
    expect(canonicalizeConnectionIdentity({ environment: "development", remoteAddress: "fe80::1%bad zone" })).toBeUndefined();
    expect(canonicalizeConnectionIdentity({ environment: "test", remoteAddress: "2001:db8::1" })).toBe("2001:db8:0:0::/64");
  });

  it("reports readiness only when every dependency is ready", () => {
    expect(gatewayReadiness({ redis: true, database: true, durableOutbox: true }, true).ok).toBe(true);
    expect(gatewayReadiness({ redis: true, database: false, durableOutbox: true }, true)).toMatchObject({
      ok: false,
      dependencies: { database: false, providerControl: true },
    });
  });
});
