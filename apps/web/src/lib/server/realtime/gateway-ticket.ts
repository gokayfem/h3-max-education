import "server-only";

import {
  GATEWAY_TOKEN_TTL_SECONDS,
  signGatewayToken,
} from "@/lib/server/auth";
import { getPersistenceServicesFromEnv } from "@/lib/server/session/runtime";

export interface GatewayTicketGrant {
  readonly token: string;
  readonly commandRevision: number;
}

export async function mintGatewayTicket(
  learnerId: string,
  sessionId: string,
  callId: string,
): Promise<GatewayTicketGrant | undefined> {
  const activeCall = await getPersistenceServicesFromEnv().sessions.getActiveRealtimeCall(
    learnerId,
    sessionId,
    callId,
  );
  if (!activeCall) return undefined;

  const nowSeconds = Math.floor(Date.now() / 1_000);
  const token = await signGatewayToken({
    v: 1,
    learnerId,
    sessionId,
    callId,
    exp: nowSeconds + GATEWAY_TOKEN_TTL_SECONDS,
    nonce: crypto.randomUUID(),
  });
  return { token, commandRevision: activeCall.commandRevision };
}
