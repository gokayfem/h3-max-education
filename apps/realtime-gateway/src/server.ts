import { createServer, type ServerResponse } from "node:http";
import { WebSocketServer, type RawData } from "ws";
import type WebSocket from "ws";
import {
  verifyGatewayToken,
  isAllowedWebSocketOrigin
} from "./auth.js";
import { loadConfig } from "./config.js";
import {
  InMemoryGatewayDurableSink,
  NeonGatewayDurableSink,
  SessionEventBus
} from "./event-bus.js";
import { SafeLogger } from "./logger.js";
import { GatewayMetrics } from "./metrics.js";
import {
  canonicalizeConnectionIdentity,
  GATEWAY_PROTOCOL,
  gatewayReadiness,
  parseGatewayProtocols
} from "./network.js";
import { GatewaySessionManager, type SessionAttachment } from "./session.js";

const config = loadConfig();
const logger = new SafeLogger(config.region);
const metrics = new GatewayMetrics();
const durableSink = config.databaseUrl
  ? new NeonGatewayDurableSink(config.databaseUrl)
  : new InMemoryGatewayDurableSink();
const bus = new SessionEventBus(config.redisUrl, logger, durableSink, {
  requireRedis: config.environment === "production",
  maxActiveSessionsPerLearner: config.maxActiveSessionsPerLearner,
  maxPaidCommandsPerLearner: config.maxPaidCommandsPerLearner,
  transcriptEncryptionKey: config.transcriptEncryptionKey,
  activeTranscriptTtlSeconds: config.activeTranscriptTtlSeconds
});
const sessions = new GatewaySessionManager(config, bus, metrics, logger);
const webSockets = new WebSocketServer({
  noServer: true,
  maxPayload: 16_384,
  perMessageDeflate: false,
  handleProtocols: (protocols) => protocols.has(GATEWAY_PROTOCOL) ? GATEWAY_PROTOCOL : false
});

function applySecurityHeaders(response: ServerResponse): void {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
  response.setHeader("Cross-Origin-Resource-Policy", "same-site");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
}

const server = createServer((request, response) => {
  applySecurityHeaders(response);
  if (request.method === "GET" && request.url === "/healthz") {
    response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({
      ok: true,
      region: config.region,
      uptimeSeconds: Math.floor(process.uptime())
    }));
    return;
  }
  if (request.method === "GET" && request.url === "/readyz") {
    const readiness = gatewayReadiness(bus.readiness(), Boolean(config.openAiApiKey));
    response.writeHead(readiness.ok ? 200 : 503, { "Content-Type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({
      ...readiness,
      region: config.region,
      uptimeSeconds: Math.floor(process.uptime())
    }));
    return;
  }
  if (request.method === "GET" && request.url === "/metrics") {
    response.writeHead(200, { "Content-Type": "text/plain; version=0.0.4; charset=utf-8" });
    response.end(metrics.renderPrometheus(config.region));
    return;
  }
  response.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify({ error: "not_found" }));
});

server.on("upgrade", async (request, socket, head) => {
  const reject = (status: number, reason: string) => {
    if (socket.destroyed) return;
    socket.end(
      `HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
      () => socket.destroy()
    );
  };
  if (request.method !== "GET" || !request.url) {
    reject(400, "Bad Request");
    return;
  }
  if (!request.headers.host) {
    reject(400, "Bad Request");
    return;
  }
  if (!isAllowedWebSocketOrigin(request.headers.origin, config.webOrigin)) {
    reject(403, "Forbidden");
    return;
  }
  let url: URL;
  try {
    url = new URL(request.url, "http://gateway.invalid");
  } catch {
    reject(400, "Bad Request");
    return;
  }
  const match = /^\/sessions\/([A-Za-z0-9_-]{8,128})$/.exec(url.pathname);
  const sessionId = match?.[1];
  if (!sessionId) {
    reject(404, "Not Found");
    return;
  }
  for (const key of url.searchParams.keys()) {
    if (key !== "callId") {
      reject(400, "Bad Request");
      return;
    }
  }
  const callId = url.searchParams.get("callId") ?? undefined;
  if (!callId || !/^[A-Za-z0-9_-]{8,256}$/.test(callId)) {
    reject(400, "Bad Request");
    return;
  }
  const connectionIdentity = canonicalizeConnectionIdentity({
    environment: config.environment,
    remoteAddress: request.socket.remoteAddress,
    flyClientIp: request.headers["fly-client-ip"]
  });
  if (!connectionIdentity) {
    reject(400, "Bad Request");
    return;
  }

  const gatewayProtocols = parseGatewayProtocols(request.headers["sec-websocket-protocol"]);
  if (!gatewayProtocols) {
    reject(401, "Unauthorized");
    return;
  }
  const nowUnixSeconds = Math.floor(Date.now() / 1_000);
  const learner = verifyGatewayToken(
    gatewayProtocols.ticket,
    config.authSecret,
    sessionId,
    callId,
    nowUnixSeconds
  );
  if (!learner) {
    reject(401, "Unauthorized");
    return;
  }
  try {
    const claimed = await bus.claimGatewayTicket({
      nonce: learner.nonce,
      learnerId: learner.learnerId,
      sessionId: learner.sessionId,
      callId: learner.callId,
      expiresAtUnixSeconds: learner.exp
    }, nowUnixSeconds);
    if (!claimed) {
      reject(401, "Unauthorized");
      return;
    }
  } catch {
    reject(503, "Service Unavailable");
    return;
  }
  const authenticatedLearner = learner;
  const completeUpgrade = (webSocket: WebSocket) => {
    const pending: Array<{ data: RawData; binary: boolean }> = [];
    let attached: SessionAttachment | undefined;
    let disconnected = false;
    const detach = () => {
      disconnected = true;
      if (attached) void attached.detach();
    };
    webSocket.once("close", detach);
    webSocket.once("error", () => {
      detach();
      webSocket.terminate();
    });
    webSocket.on("message", (data, binary) => {
      if (attached) {
        void sessions.handleRawMessage(attached.session, data, binary).catch(() => {
          webSocket.close(1011, "message handling failed");
        });
      } else if (pending.length < 32) {
        pending.push({ data, binary });
      } else {
        webSocket.close(1009, "too many pending messages");
      }
    });
    void sessions.attach(
      sessionId,
      authenticatedLearner,
      webSocket,
      callId,
      connectionIdentity
    ).then(async (attachment) => {
      attached = attachment;
      if (disconnected || webSocket.readyState !== webSocket.OPEN) {
        await attachment.detach();
        return;
      }
      for (const message of pending.splice(0)) {
        await sessions.handleRawMessage(attachment.session, message.data, message.binary);
      }
    }).catch(() => {
      webSocket.close(1008, "session rejected");
    });
  };
  try {
    webSockets.handleUpgrade(request, socket, head, completeUpgrade);
  } catch {
    reject(400, "Bad Request");
  }
});

async function shutdown(signal: "SIGINT" | "SIGTERM"): Promise<void> {
  logger.write("info", "Gateway draining", { event: signal, provider: "gateway" });
  server.close();
  webSockets.close();
  await sessions.close();
  await bus.close();
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

await bus.connect();
server.listen(config.port, "0.0.0.0", () => {
  logger.write("info", "Gateway listening", { event: "listening", provider: "gateway" });
});
