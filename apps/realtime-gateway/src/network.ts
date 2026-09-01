import { isIP } from "node:net";

export const GATEWAY_PROTOCOL = "axiom.realtime.v1";
const GATEWAY_TICKET_PREFIX = "axiom.ticket.";
const GATEWAY_TICKET_PATTERN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const MAX_GATEWAY_TICKET_LENGTH = 4_096;

export interface GatewayProtocols {
  readonly protocol: typeof GATEWAY_PROTOCOL;
  readonly ticket: string;
}

export function parseGatewayProtocols(header: string | string[] | undefined): GatewayProtocols | undefined {
  if (typeof header !== "string") return undefined;
  const values = header.split(",").map((value) => value.trim());
  if (values.length !== 2 || values[0] !== GATEWAY_PROTOCOL) return undefined;
  const credentialProtocol = values[1];
  if (!credentialProtocol?.startsWith(GATEWAY_TICKET_PREFIX)) return undefined;
  const ticket = credentialProtocol.slice(GATEWAY_TICKET_PREFIX.length);
  if (
    ticket.length === 0
    || ticket.length > MAX_GATEWAY_TICKET_LENGTH
    || !GATEWAY_TICKET_PATTERN.test(ticket)
  ) return undefined;
  return { protocol: GATEWAY_PROTOCOL, ticket };
}

export interface ConnectionIdentityInput {
  readonly environment: "development" | "test" | "production";
  readonly remoteAddress?: string;
  readonly flyClientIp?: string | readonly string[];
}

export function canonicalizeConnectionIdentity(input: ConnectionIdentityInput): string | undefined {
  const candidate = input.environment === "production"
    ? (typeof input.flyClientIp === "string" ? input.flyClientIp : undefined)
    : input.remoteAddress;
  if (!candidate || candidate.includes(",")) return undefined;
  const trimmed = candidate.trim();
  const zoneSeparator = trimmed.indexOf("%");
  if (zoneSeparator !== -1 && input.environment === "production") return undefined;
  const withoutZone = zoneSeparator === -1 ? trimmed : trimmed.slice(0, zoneSeparator);
  const zone = zoneSeparator === -1 ? undefined : trimmed.slice(zoneSeparator + 1);
  if (
    !withoutZone
    || isIP(withoutZone) === 0
    || (zone !== undefined && (isIP(withoutZone) !== 6 || !/^[A-Za-z0-9_.-]+$/.test(zone)))
  ) return undefined;
  if (isIP(withoutZone) === 4) return withoutZone;

  const normalized = new URL(`http://[${withoutZone}]/`).hostname.slice(1, -1);
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(normalized);
  if (mapped) {
    const high = Number.parseInt(mapped[1]!, 16);
    const low = Number.parseInt(mapped[2]!, 16);
    return `${high >>> 8}.${high & 0xff}.${low >>> 8}.${low & 0xff}`;
  }

  const [left = "", right = ""] = normalized.split("::", 2);
  const leftGroups = left ? left.split(":") : [];
  const rightGroups = right ? right.split(":") : [];
  const groups = [...leftGroups, ...Array(8 - leftGroups.length - rightGroups.length).fill("0"), ...rightGroups];
  return `${groups.slice(0, 4).map((group) => Number.parseInt(group, 16).toString(16)).join(":")}::/64`;
}

export interface GatewayDependencyReadiness {
  readonly redis: boolean;
  readonly database: boolean;
  readonly durableOutbox: boolean;
  readonly providerControl: boolean;
}

export interface GatewayReadiness {
  readonly ok: boolean;
  readonly dependencies: GatewayDependencyReadiness;
}

export function gatewayReadiness(
  busDependencies: Omit<GatewayDependencyReadiness, "providerControl">,
  providerControlConfigured: boolean,
): GatewayReadiness {
  const dependencies = { ...busDependencies, providerControl: providerControlConfigured };
  return {
    ok: Object.values(dependencies).every(Boolean),
    dependencies
  };
}
