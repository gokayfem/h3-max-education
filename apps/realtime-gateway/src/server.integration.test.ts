import { createHmac } from "node:crypto";
import { createConnection, createServer as createNetServer } from "node:net";
import type * as NodeHttp from "node:http";
import type { RequestListener, Server as HttpServer } from "node:http";
import { setImmediate as nextTurn } from "node:timers/promises";
import WebSocket from "ws";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { GatewayConfig } from "./config.js";

const SESSION_ID = "33333333-3333-4333-8333-333333333333";
const CALL_ID = "rtc_12345678";
const LEARNER_ID = "lrn_abcdefghijklmnop";
const AUTH_SECRET = "gateway-test-secret-that-is-at-least-32-chars";
const ORIGIN = "https://science.example";

interface CapturedPermit {
  readonly id: string;
  readonly sessionId: string;
  readonly learnerId: string;
  readonly networkHash: string;
}

interface CapturedLease {
  readonly sessionId: string;
  readonly learnerId: string;
  readonly gatewayInstanceToken: string;
  readonly callId?: string;
}

interface CapturedGatewayTicketClaim {
  readonly nonce: string;
  readonly learnerId: string;
  readonly sessionId: string;
  readonly callId: string;
  readonly expiresAtUnixSeconds: number;
}

const harness = vi.hoisted(() => ({
  config: undefined as GatewayConfig | undefined,
  servers: [] as HttpServer[],
  buses: [] as Array<{
    ready: boolean;
    closed: boolean;
    claimed: Set<string>;
    terminalSessions: Set<string>;
    leases: Map<string, CapturedLease>;
    permits: Map<string, CapturedPermit>;
    released: CapturedPermit[];
    identities: string[];
    maxPermits: number;
  }>,
}));

vi.mock("node:http", async () => {
  const actual = await vi.importActual<typeof NodeHttp>("node:http");
  return {
    ...actual,
    createServer: (requestListener: RequestListener) => {
      const server = actual.createServer(requestListener);
      harness.servers.push(server);
      return server;
    },
  };
});

vi.mock("./config.js", () => ({ loadConfig: () => harness.config! }));

vi.mock("./event-bus.js", () => {
  class FakeDurableSink {}
  class FakeSessionEventBus {
    ready = true;
    closed = false;
    readonly claimed = new Set<string>();
    readonly terminalSessions = new Set<string>();
    readonly activeGatewayCalls = new Map([
      [SESSION_ID, { learnerId: LEARNER_ID, callId: CALL_ID }],
    ]);
    readonly leases = new Map<string, CapturedLease>();
    readonly permits = new Map<string, CapturedPermit>();
    readonly released: CapturedPermit[] = [];
    readonly identities: string[] = [];
    maxPermits = Number.POSITIVE_INFINITY;
    private permitSequence = 0;

    constructor() {
      harness.buses.push(this);
    }

    async connect(): Promise<void> {}
    async close(): Promise<void> { this.closed = true; }
    isReady(): boolean { return this.ready && !this.closed; }
    readiness(): Record<string, boolean> {
      return { redis: this.ready && !this.closed, database: true, durableOutbox: true };
    }

    async claimCommand(_sessionId: string, key: string): Promise<boolean> {
      if (this.claimed.has(key)) return false;
      this.claimed.add(key);
      return true;
    }

    async claimGatewayTicket(
      input: CapturedGatewayTicketClaim,
      nowUnixSeconds: number,
    ): Promise<boolean> {
      const activeCall = this.activeGatewayCalls.get(input.sessionId);
      if (
        input.expiresAtUnixSeconds <= nowUnixSeconds
        || this.terminalSessions.has(input.sessionId)
        || !activeCall
        || activeCall.learnerId !== input.learnerId
        || activeCall.callId !== input.callId
        || this.claimed.has(input.nonce)
      ) return false;
      this.claimed.add(input.nonce);
      return true;
    }

    async reserveSocketPermit(
      sessionId: string,
      learnerId: string,
      networkHash: string,
    ): Promise<CapturedPermit | undefined> {
      this.identities.push(networkHash);
      if (this.permits.size >= this.maxPermits) return undefined;
      const permit = {
        id: `permit-${this.permitSequence += 1}`,
        sessionId,
        learnerId,
        networkHash,
      };
      this.permits.set(permit.id, permit);
      return permit;
    }

    async releaseSocketPermit(permit: CapturedPermit): Promise<void> {
      if (!this.permits.delete(permit.id)) return;
      this.released.push(permit);
    }
    async nextEventRevision(_sessionId: string, current: number): Promise<number> { return current + 1; }
    async refreshSocketPermit(permit: CapturedPermit): Promise<boolean> { return this.permits.has(permit.id); }
    async bindSessionOwner(
      sessionId: string,
      learnerId: string,
      callId?: string,
    ): Promise<CapturedLease | undefined> {
      const current = this.leases.get(sessionId);
      if (current && current.learnerId !== learnerId) return undefined;
      const lease = {
        sessionId,
        learnerId,
        gatewayInstanceToken: "fake-gateway-instance",
        ...(callId ? { callId } : {}),
      };
      this.leases.set(sessionId, lease);
      return lease;
    }
    async refreshSessionOwner(lease: CapturedLease, callId = lease.callId): Promise<boolean> {
      const current = this.leases.get(lease.sessionId);
      if (
        current?.learnerId !== lease.learnerId
        || current.gatewayInstanceToken !== lease.gatewayInstanceToken
      ) return false;
      this.leases.set(lease.sessionId, { ...lease, ...(callId ? { callId } : {}) });
      return true;
    }
    async releaseSessionOwner(lease: CapturedLease): Promise<boolean> {
      const current = this.leases.get(lease.sessionId);
      if (current?.gatewayInstanceToken !== lease.gatewayInstanceToken) return false;
      this.leases.delete(lease.sessionId);
      return true;
    }
    subscribe(): () => void { return () => undefined; }
    async publish(): Promise<void> {}
    async hydrateSessionState(): Promise<undefined> { return undefined; }
    async hydrateTranscript(): Promise<readonly []> { return []; }
    async loadLearnerContext(): Promise<{ mastery: readonly []; misconceptions: readonly []; interests: readonly []; recentSummaries: readonly []; instructionLines: readonly []; ageBand?: "13-15" | "16-18" }> {
      return { mastery: [], misconceptions: [], interests: [], recentSummaries: [], instructionLines: [] };
    }
    async readCommandRevision(_sessionId: string, fallback = 0): Promise<number> { return fallback; }
    async persistSessionState(): Promise<void> {}
    async clearSessionState(): Promise<void> {}
    async appendTranscript(): Promise<void> {}
    async reservePaidCommand(): Promise<boolean> { return true; }
    async writeDurableEvent(): Promise<boolean> { return true; }
  }

  return {
    InMemoryGatewayDurableSink: FakeDurableSink,
    NeonGatewayDurableSink: FakeDurableSink,
    SessionEventBus: FakeSessionEventBus,
  };
});

vi.mock("./providers.js", () => {
  class FakeRealtimeSideband {
    async connect(): Promise<void> {}
    sendLearnerText(): boolean { return true; }
    cancelResponse(): void {}
    clearOutputAudio(): void {}
    truncateAssistant(): void {}
    selectCard(): boolean { return true; }
    async close(): Promise<void> {}
  }
  class FakeTextTutor {
    async respond(): Promise<string> { return "A deterministic science answer."; }
    async summarize(): Promise<string> { return "A deterministic session summary."; }
  }
  return { OpenAiRealtimeSideband: FakeRealtimeSideband, OpenAiTextTutor: FakeTextTutor };
});

function ticket(nonce: string): string {
  const body = Buffer.from(JSON.stringify({
    v: 1,
    learnerId: LEARNER_ID,
    sessionId: SESSION_ID,
    callId: CALL_ID,
    exp: Math.floor(Date.now() / 1_000) + 60,
    nonce,
  })).toString("base64url");
  const signature = createHmac("sha256", AUTH_SECRET).update(body).digest("base64url");
  return `${body}.${signature}`;
}

async function unusedPort(): Promise<number> {
  const probe = createNetServer();
  const listening = Promise.withResolvers<void>();
  probe.once("error", listening.reject);
  probe.listen(0, "127.0.0.1", listening.resolve);
  await listening.promise;
  const address = probe.address();
  if (!address || typeof address === "string") throw new Error("No test port allocated");
  const closed = Promise.withResolvers<void>();
  probe.close((error) => error ? closed.reject(error) : closed.resolve());
  await closed.promise;
  return address.port;
}

function socketUrl(port: number): string {
  return `ws://127.0.0.1:${port}/sessions/${SESSION_ID}?callId=${CALL_ID}`;
}

interface SocketOutcome {
  readonly socket: WebSocket;
  readonly opened: Promise<WebSocket>;
  readonly closed: Promise<{ code: number; reason: string }>;
}

function socketOutcome(port: number, signedTicket: string, flyClientIp = "203.0.113.9"): SocketOutcome {
  const opened = Promise.withResolvers<WebSocket>();
  const closed = Promise.withResolvers<{ code: number; reason: string }>();
  const socket = new WebSocket(
    socketUrl(port),
    ["axiom.realtime.v1", `axiom.ticket.${signedTicket}`],
    { headers: { Origin: ORIGIN, "Fly-Client-IP": flyClientIp } },
  );
  socket.once("open", () => opened.resolve(socket));
  socket.once("close", (code, reason) => closed.resolve({ code, reason: reason.toString() }));
  socket.once("error", opened.reject);
  return { socket, opened: opened.promise, closed: closed.promise };
}

async function openSocket(port: number, signedTicket: string, flyClientIp = "203.0.113.9"): Promise<WebSocket> {
  return socketOutcome(port, signedTicket, flyClientIp).opened;
}

function rejectedUpgrade(
  port: number,
  signedTicket: string,
  flyClientIp = "203.0.113.9",
  protocols: string[] = ["axiom.realtime.v1", `axiom.ticket.${signedTicket}`],
): Promise<number> {
  const result = Promise.withResolvers<number>();
  const socket = new WebSocket(
    socketUrl(port),
    protocols,
    { headers: { Origin: ORIGIN, "Fly-Client-IP": flyClientIp } },
  );
  socket.once("unexpected-response", (_request, response) => {
    const status = response.statusCode ?? 0;
    response.resume();
    result.resolve(status);
  });
  socket.once("open", () => {
    socket.close();
    result.reject(new Error("Upgrade unexpectedly succeeded"));
  });
  socket.once("error", () => undefined);
  return result.promise;
}

function rawUpgradeStatus(port: number, protocolHeader: string): Promise<number> {
  const result = Promise.withResolvers<number>();
  const socket = createConnection({ host: "127.0.0.1", port });
  socket.once("connect", () => {
    socket.write([
      `GET /sessions/${SESSION_ID}?callId=${CALL_ID} HTTP/1.1`,
      `Host: 127.0.0.1:${port}`,
      "Connection: Upgrade",
      "Upgrade: websocket",
      "Sec-WebSocket-Version: 13",
      `Sec-WebSocket-Key: ${Buffer.alloc(16, 3).toString("base64")}`,
      `Sec-WebSocket-Protocol: ${protocolHeader}`,
      `Origin: ${ORIGIN}`,
      "Fly-Client-IP: 203.0.113.9",
      "",
      "",
    ].join("\r\n"));
  });
  socket.once("data", (data) => {
    const match = /^HTTP\/1\.1 (\d{3})/u.exec(data.toString("ascii"));
    socket.destroy();
    if (match?.[1]) result.resolve(Number(match[1]));
    else result.reject(new Error("Upgrade response omitted an HTTP status"));
  });
  socket.once("error", result.reject);
  return result.promise;
}

async function closeSocket(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) return;
  const closed = Promise.withResolvers<void>();
  socket.once("close", closed.resolve);
  socket.close(1000);
  await closed.promise;
  await nextTurn();
}

async function waitUntil(check: () => boolean): Promise<void> {
  await vi.waitFor(() => {
    if (!check()) throw new Error(`Condition not met: ${check.toString()}`);
  });
}

let port: number;
let signalHandlers: Array<() => void> = [];
let restoreProcessOnce: (() => void) | undefined;

async function startGateway(): Promise<void> {
  // The executable entrypoint starts at module evaluation, so lifecycle tests
  // intentionally reload this known module after the first instance drains.
  await import("./server.js");
  const server = harness.servers.at(-1);
  if (!server) throw new Error("Gateway server was not created");
  if (!server.listening) {
    const listening = Promise.withResolvers<void>();
    server.once("listening", listening.resolve);
    await listening.promise;
  }
}

beforeAll(async () => {
  port = await unusedPort();
  harness.config = {
    environment: "production",
    port,
    authSecret: AUTH_SECRET,
    webOrigin: ORIGIN,
    openAiApiKey: "deterministic-provider-key",
    openAiRealtimeModel: "gpt-realtime",
    openAiTextModel: "gpt-4.1-mini",
    redisUrl: "rediss://persistence.invalid",
    databaseUrl: "postgresql://persistence.invalid/axiom",
    transcriptEncryptionKey: Buffer.alloc(32, 7).toString("base64"),
    maxActiveSessionsPerLearner: 2,
    maxPaidCommandsPerLearner: 24,
    region: "test",
  };
  const originalOnce = process.once.bind(process);
  const spy = vi.spyOn(process, "once").mockImplementation(((event: string | symbol, listener: (...args: never[]) => void) => {
    if (event === "SIGINT" || event === "SIGTERM") {
      signalHandlers.push(listener);
      return process;
    }
    return Reflect.apply(originalOnce, process, [event, listener]) as NodeJS.Process;
  }) as typeof process.once);
  restoreProcessOnce = () => spy.mockRestore();
  await startGateway();
});

afterAll(async () => {
  const server = harness.servers.at(-1);
  if (server?.listening) {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
  restoreProcessOnce?.();
});

describe("realtime gateway executable HTTP and upgrade boundary", () => {
  it("dispatches liveness, readiness, and unknown HTTP routes", async () => {
    const bus = harness.buses.at(-1)!;
    const live = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(live.status).toBe(200);
    await expect(live.json()).resolves.toMatchObject({ ok: true, region: "test" });

    const healthy = await fetch(`http://127.0.0.1:${port}/readyz`);
    expect(healthy.status).toBe(200);
    await expect(healthy.json()).resolves.toMatchObject({
      ok: true,
      dependencies: { redis: true, database: true, durableOutbox: true, providerControl: true },
      region: "test",
    });

    bus.ready = false;
    const unavailable = await fetch(`http://127.0.0.1:${port}/readyz`);
    expect(unavailable.status).toBe(503);
    await expect(unavailable.json()).resolves.toMatchObject({ ok: false, dependencies: { redis: false } });
    bus.ready = true;

    Object.defineProperty(harness.config!, "openAiApiKey", {
      value: undefined,
      configurable: true,
      writable: true,
    });
    const providerUnavailable = await fetch(`http://127.0.0.1:${port}/readyz`);
    expect(providerUnavailable.status).toBe(503);
    await expect(providerUnavailable.json()).resolves.toMatchObject({
      ok: false,
      dependencies: { providerControl: false },
    });
    Object.defineProperty(harness.config!, "openAiApiKey", {
      value: "deterministic-provider-key",
      configurable: true,
      writable: true,
    });

    const missing = await fetch(`http://127.0.0.1:${port}/not-a-route`);
    expect(missing.status).toBe(404);
  });

  it("accepts a ticket only through the required subprotocols and echoes no credential", async () => {
    const nonce = "44444444-4444-4444-8444-444444444444";
    const socket = await openSocket(port, ticket(nonce));
    expect(socket.protocol).toBe("axiom.realtime.v1");
    expect(socket.protocol).not.toContain("axiom.ticket.");
    await closeSocket(socket);

    const queryCredential = ticket("55555555-5555-4555-8555-555555555555");
    const queryUrl = `${socketUrl(port)}&token=${encodeURIComponent(queryCredential)}`;
    const response = Promise.withResolvers<number>();
    const querySocket = new WebSocket(queryUrl, { headers: { Origin: ORIGIN, "Fly-Client-IP": "203.0.113.9" } });
    querySocket.once("unexpected-response", (_request, upgradeResponse) => {
      upgradeResponse.resume();
      response.resolve(upgradeResponse.statusCode ?? 0);
    });
    querySocket.once("error", () => undefined);
    const status = await response.promise;
    expect(status).toBe(400);
  });

  it("rejects malformed, duplicate, and reordered ticket protocols before upgrade", async () => {
    const signed = ticket("eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee");
    await expect(rawUpgradeStatus(
      port,
      `axiom.ticket.${signed}, axiom.realtime.v1`,
    )).resolves.toBe(401);
    await expect(rawUpgradeStatus(
      port,
      `axiom.realtime.v1, axiom.ticket.${signed}, axiom.ticket.${signed}`,
    )).resolves.toBe(401);
    await expect(rawUpgradeStatus(
      port,
      "axiom.realtime.v1, axiom.ticket.not-a-signed-envelope",
    )).resolves.toBe(401);
  });

  it("rejects replay of a previously claimed ticket at the real upgrade dispatcher", async () => {
    const signed = ticket("66666666-6666-4666-8666-666666666666");
    const first = await openSocket(port, signed);
    await closeSocket(first);
    expect(await rejectedUpgrade(port, signed)).toBe(401);
  });

  it("rejects a ticket minted before terminal close without consuming its nonce", async () => {
    const bus = harness.buses.at(-1)!;
    const nonce = "34343434-3434-4434-8434-343434343434";
    const mintedBeforeClose = ticket(nonce);
    bus.terminalSessions.add(SESSION_ID);
    try {
      await expect(rejectedUpgrade(port, mintedBeforeClose)).resolves.toBe(401);
      expect(bus.claimed.has(nonce)).toBe(false);
    } finally {
      bus.terminalSessions.delete(SESSION_ID);
    }
  });

  it("canonicalizes only the trusted Fly client identity and rejects ambiguous proxy values", async () => {
    const bus = harness.buses.at(-1)!;
    const initialCount = bus.identities.length;
    const first = await openSocket(
      port,
      ticket("77777777-7777-4777-8777-777777777777"),
      "2001:0DB8:ABCD:0012:0000:0000:0000:0001",
    );
    await waitUntil(() => bus.identities.length > initialCount);
    const firstIdentity = bus.identities.at(-1);
    expect(firstIdentity).toBe("2001:db8:abcd:12::/64");
    await closeSocket(first);

    const second = await openSocket(
      port,
      ticket("88888888-8888-4888-8888-888888888888"),
      "2001:db8:abcd:12::1",
    );
    await waitUntil(() => bus.identities.length > initialCount + 1);
    expect(bus.identities.at(-1)).toBe(firstIdentity);
    await closeSocket(second);

    const mapped = await openSocket(
      port,
      ticket("ffffffff-ffff-4fff-8fff-ffffffffffff"),
      "::ffff:192.0.2.7",
    );
    await waitUntil(() => bus.identities.length > initialCount + 2);
    expect(bus.identities.at(-1)).toBe("192.0.2.7");
    await closeSocket(mapped);

    expect(await rejectedUpgrade(
      port,
      ticket("99999999-9999-4999-8999-999999999999"),
      "203.0.113.9, 198.51.100.4",
    )).toBe(400);
  });

  it("enforces simultaneous connection caps and releases admission on close", async () => {
    const bus = harness.buses.at(-1)!;
    bus.maxPermits = 1;
    const first = await openSocket(port, ticket("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"));
    await waitUntil(() => bus.permits.size === 1);

    const second = socketOutcome(port, ticket("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"));
    await second.opened;
    await expect(second.closed).resolves.toEqual({ code: 1008, reason: "session rejected" });
    expect(bus.permits.size).toBe(1);

    await closeSocket(first);
    await waitUntil(() => bus.permits.size === 0);
    const replacement = await openSocket(port, ticket("cccccccc-cccc-4ccc-8ccc-cccccccccccc"));
    await waitUntil(() => bus.permits.size === 1);
    await closeSocket(replacement);
    await waitUntil(() => bus.permits.size === 0);
    expect(bus.released.length).toBeGreaterThanOrEqual(2);
    bus.maxPermits = Number.POSITIVE_INFINITY;
  });

  it("drains sockets, persistence, and admission state on shutdown and can restart cleanly", async () => {
    const bus = harness.buses.at(-1)!;
    const socket = await openSocket(port, ticket("dddddddd-dddd-4ddd-8ddd-dddddddddddd"));
    await waitUntil(() => bus.permits.size === 1);

    const closed = Promise.withResolvers<number>();
    socket.once("close", closed.resolve);
    signalHandlers.at(-1)!();
    await expect(closed.promise).resolves.toBe(1000);
    await waitUntil(() => (
      bus.closed
      && bus.permits.size === 0
      && bus.leases.size === 0
      && harness.servers.at(-1)?.listening === false
    ));

    Object.defineProperty(harness.config!, "environment", {
      value: "development",
      configurable: true,
      writable: true,
    });
    vi.resetModules();
    signalHandlers = [];
    await startGateway();
    const restartedBus = harness.buses.at(-1)!;
    expect(restartedBus).not.toBe(bus);
    const health = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(health.status).toBe(200);

    const identityCount = restartedBus.identities.length;
    const developmentSocket = await openSocket(
      port,
      ticket("12121212-1212-4212-8212-121212121212"),
      "198.51.100.250",
    );
    await waitUntil(() => restartedBus.identities.length > identityCount);
    expect(restartedBus.identities.at(-1)).toBe("127.0.0.1");
    await closeSocket(developmentSocket);

    signalHandlers.at(-1)!();
    await waitUntil(() => (
      restartedBus.closed
      && restartedBus.leases.size === 0
      && harness.servers.at(-1)?.listening === false
    ));
  });
});
