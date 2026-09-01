import { isIP } from "node:net";
import { NextResponse } from "next/server";
import { z } from "zod";

import {
  assertSameOrigin,
  AuthRegistryUnavailable,
  authErrorResponse,
  createLearnerId,
  createSessionToken,
  getSession,
  publicLearner,
  SESSION_COOKIE_NAME,
  SESSION_TTL_SECONDS,
  sessionCookieOptions,
} from "@/lib/server/auth";
import { getPersistenceServicesFromEnv } from "@/lib/server/session/runtime";
import { readBoundedJsonBody, sessionApiErrorResponse } from "@/lib/server/session/http";

const guestSessionSchema = z.object({}).strict();
const PRIVATE_NO_STORE_HEADERS = { "Cache-Control": "no-store" } as const;
const GUEST_DISPLAY_NAME = "Guest";
const GUEST_AGE_BAND = "13-15" as const;
function configuredPositiveInteger(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}
function parseIpv6Words(address: string): number[] | null {
  let normalized = address.toLowerCase();
  const dottedTail = normalized.lastIndexOf(":");
  if (normalized.includes(".")) {
    if (dottedTail < 0) return null;
    const octets = normalized.slice(dottedTail + 1).split(".").map(Number);
    if (
      octets.length !== 4
      || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)
    ) {
      return null;
    }
    normalized = `${normalized.slice(0, dottedTail)}:${((octets[0]! << 8) | octets[1]!).toString(16)}:${((octets[2]! << 8) | octets[3]!).toString(16)}`;
  }

  const halves = normalized.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  const omitted = 8 - left.length - right.length;
  if ((halves.length === 1 && omitted !== 0) || (halves.length === 2 && omitted < 1)) {
    return null;
  }
  const words = [
    ...left,
    ...Array.from({ length: omitted }, () => "0"),
    ...right,
  ].map((word) => Number.parseInt(word, 16));
  return words.length === 8 && words.every((word) => Number.isInteger(word) && word >= 0 && word <= 0xffff)
    ? words
    : null;
}

export function canonicalAdmissionNetwork(address: string): string | null {
  // Scoped/zone-qualified addresses are interface-local and must never become
  // identities derived from an external proxy header.
  if (address.includes("%")) return null;
  const family = isIP(address);
  if (family === 4) {
    // IPv4 remains an exact /32. Broadening it would merge unrelated customers
    // on adjacent public addresses; the proxy-observed address already groups NAT users.
    return `ipv4:${address.split(".").map(Number).join(".")}/32`;
  }
  if (family !== 6) return null;

  const words = parseIpv6Words(address);
  if (!words) return null;
  const ipv4Mapped = words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff;
  if (ipv4Mapped) {
    const octets = [
      words[6]! >> 8,
      words[6]! & 0xff,
      words[7]! >> 8,
      words[7]! & 0xff,
    ];
    return `ipv4:${octets.join(".")}/32`;
  }

  const prefix = words.slice(0, 4).map((word) => word.toString(16).padStart(4, "0")).join(":");
  return `ipv6:${prefix}::/64`;
}
export function trustedDeploymentNetwork(request: Request): string | null {
  let candidate: string | null = null;
  const configuredHeader = process.env.TRUSTED_CLIENT_IP_HEADER?.trim().toLowerCase();
  if (configuredHeader) {
    if (!["cf-connecting-ip", "fly-client-ip", "x-real-ip", "x-vercel-forwarded-for"].includes(configuredHeader)) {
      return null;
    }
    candidate = request.headers.get(configuredHeader)?.split(",", 1)[0]?.trim() ?? null;
  } else if (process.env.VERCEL === "1") {
    candidate = request.headers.get("x-vercel-forwarded-for")?.split(",", 1)[0]?.trim() ?? null;
  } else if (process.env.CF_PAGES === "1" || process.env.CLOUDFLARE_WORKER === "1") {
    candidate = request.headers.get("cf-connecting-ip")?.trim() ?? null;
  } else if (process.env.FLY_APP_NAME) {
    candidate = request.headers.get("fly-client-ip")?.trim() ?? null;
  } else if (process.env.NODE_ENV !== "production") {
    candidate = request.headers.get("x-forwarded-for")?.split(",", 1)[0]?.trim() || "127.0.0.1";
  }
  return candidate ? canonicalAdmissionNetwork(candidate) : null;
}

export async function GET(request: Request): Promise<Response> {
  try {
    const session = await getSession(request);
    if (!session) {
      return Response.json({ authenticated: false }, { headers: PRIVATE_NO_STORE_HEADERS });
    }

    return Response.json(
      {
        authenticated: true,
        learner: publicLearner(session),
      },
      { headers: PRIVATE_NO_STORE_HEADERS },
    );
  } catch (error) {
    return authErrorResponse(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    assertSameOrigin(request);

    const body = await readBoundedJsonBody(request);

    const parsed = guestSessionSchema.safeParse(body);
    if (!parsed.success) {
      return Response.json(
        {
          error: {
            code: "invalid_guest_session",
            message: "Guest sessions do not accept profile fields.",
          },
        },
        { status: 400 },
      );
    }

    const displayName = GUEST_DISPLAY_NAME;
    const ageBand = GUEST_AGE_BAND;
    const deploymentNetwork = trustedDeploymentNetwork(request);
    if (!deploymentNetwork) {
      return Response.json(
        { error: { code: "admission_unavailable", message: "Anonymous admission is unavailable." } },
        { status: 503 },
      );
    }
    const admissionLimits = {
      globalLimit: configuredPositiveInteger("ANONYMOUS_ADMISSION_GLOBAL_LIMIT", 500),
      networkLimit: configuredPositiveInteger(
        "ANONYMOUS_ADMISSION_IP_LIMIT",
        process.env.NODE_ENV === "production" ? 5 : 100,
      ),
      windowSeconds: configuredPositiveInteger("ANONYMOUS_ADMISSION_WINDOW_SECONDS", 86_400),
    };
    const learnerId = await createLearnerId();
    const sid = createSessionToken();
    const persistence = getPersistenceServicesFromEnv();
    const admission = await persistence.sessions.admitAnonymousLearner({
      learnerId,
      networkId: deploymentNetwork,
      ...admissionLimits,
    });
    if (!admission.allowed) {
      return Response.json(
        {
          error: {
            code: "anonymous_admission_limited",
            message: "Anonymous learner capacity is currently full. Try again later.",
          },
        },
        { status: 429, headers: { "Retry-After": String(admission.retryAfterSeconds) } },
      );
    }
    const rollbackAdmission = async (): Promise<void> => {
      await Promise.all([
        persistence.sessions.revokeAuthSession(sid).catch(() => undefined),
        persistence.sessions.releaseAnonymousLearner({
          learnerId,
          networkId: deploymentNetwork,
        }).catch(() => undefined),
      ]);
    };
    const confirmedAt = new Date();
    try {
      await persistence.repository.upsertProfile({
        learnerId,
        displayName,
        ageBand,
        ageBandConfirmedAt: confirmedAt,
      });
    } catch {
      await rollbackAdmission();
      return Response.json(
        {
          error: {
            code: "profile_persistence_failed",
            message: "H3 Max Realtime Education could not create the learner profile.",
          },
        },
        { status: 500 },
      );
    }
    try {
      await persistence.sessions.createAuthSession(sid, learnerId, SESSION_TTL_SECONDS);
    } catch (error) {
      await rollbackAdmission();
      return authErrorResponse(new AuthRegistryUnavailable(error));
    }
    const payload = {
      v: 1 as const,
      sid,
      learnerId,
      displayName,
      ageBand,
    };
    const response = NextResponse.json(
      { learner: publicLearner(payload) },
      { status: 201, headers: PRIVATE_NO_STORE_HEADERS },
    );
    response.cookies.set(SESSION_COOKIE_NAME, sid, sessionCookieOptions());
    return response;
  } catch (error) {
    return sessionApiErrorResponse(error);
  }
}
