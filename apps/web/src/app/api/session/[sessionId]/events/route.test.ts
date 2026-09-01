import { AuthError } from "@/lib/server/auth";
import type * as AuthModule from "@/lib/server/auth";
import { SessionServiceError } from "@/lib/server/session/service";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { requireSession, openEventStream, readEventPage, readPage, release } = vi.hoisted(() => ({
  requireSession: vi.fn(),
  openEventStream: vi.fn(),
  readEventPage: vi.fn(),
  readPage: vi.fn(),
  release: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/server/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof AuthModule>()),
  requireSession,
}));
vi.mock("@/lib/server/session/runtime", () => ({
  createSessionServiceFromEnv: () => ({ openEventStream, readEventPage }),
}));

import { GET } from "./route";

const SESSION_ID = "00000000-0000-4000-8000-000000000051";
const learner = { learnerId: "lrn_1234567890abcdef", ageBand: "13-15" };
const event = { protocolVersion: 1, type: "session.status", state: "text_only" };
const context = (sessionId = SESSION_ID) => ({ params: Promise.resolve({ sessionId }) });
function request(cursor?: string, lastEventId?: string): Request {
  return new Request(
    `http://localhost/api/session/${SESSION_ID}/events${cursor === undefined ? "" : `?cursor=${cursor}`}`,
    { headers: lastEventId === undefined ? undefined : { "last-event-id": lastEventId } },
  );
}
function pageRequest(cursor = "0", once = "1", signal?: AbortSignal): Request {
  const result = new Request(
    `http://localhost/api/session/${SESSION_ID}/events?cursor=${cursor}&once=${once}`,
  );
  if (signal) Object.defineProperty(result, "signal", { configurable: true, value: signal });
  return result;
}

describe("GET /api/session/[sessionId]/events", () => {
  beforeEach(() => {
    requireSession.mockReset().mockResolvedValue(learner);
    readEventPage.mockReset().mockResolvedValue({ events: [event], nextCursor: 5 });
    openEventStream.mockReset().mockResolvedValue({
      initial: { cursor: 5, events: [event] },
      read: readPage,
      release,
    });
    readPage.mockReset().mockResolvedValue({ cursor: 5, events: [] });
    release.mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("authorizes ownership before returning a non-buffered revisioned SSE stream", async () => {
    const response = await GET(request("4"), context());
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("no-cache, no-store, no-transform");
    expect(response.headers.get("x-accel-buffering")).toBe("no");
    expect(openEventStream).toHaveBeenCalledWith(learner, SESSION_ID, 4, 55_000);

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    const retry = decoder.decode((await reader.read()).value);
    const initial = decoder.decode((await reader.read()).value);
    expect(retry).toBe("retry: 2000\n\n");
    expect(initial).toContain("id: 5\nevent: session.status\n");
    await reader.cancel();
    expect(release).toHaveBeenCalledOnce();
  });

  it("uses Last-Event-ID only when the query cursor is absent", async () => {
    const response = await GET(request(undefined, "8"), context());
    expect(openEventStream).toHaveBeenCalledWith(learner, SESSION_ID, 8, 55_000);
    await response.body?.cancel();
  });

  it("returns one bounded no-store JSON page without opening SSE", async () => {
    const response = await GET(pageRequest("4"), context());

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({ events: [event], nextCursor: 5 });
    expect(readEventPage).toHaveBeenCalledWith(learner, SESSION_ID, 4);
    expect(openEventStream).not.toHaveBeenCalled();
  });

  it("rejects invalid or already-aborted one-page requests before storage reads", async () => {
    const invalid = await GET(pageRequest("0", "many"), context());
    expect(invalid.status).toBe(400);
    await expect(invalid.json()).resolves.toMatchObject({ error: { code: "invalid_event_mode" } });

    const controller = new AbortController();
    controller.abort();
    const aborted = await GET(pageRequest("0", "1", controller.signal), context());
    expect(aborted.status).toBe(499);
    await expect(aborted.json()).resolves.toMatchObject({ error: { code: "request_aborted" } });
    expect(readEventPage).not.toHaveBeenCalled();
    expect(openEventStream).not.toHaveBeenCalled();
  });

  it("requires authentication before opening a stream", async () => {
    requireSession.mockRejectedValueOnce(new AuthError(401, "authentication_required", "Sign in."));
    const response = await GET(request(), context());
    expect(response.status).toBe(401);
    expect(openEventStream).not.toHaveBeenCalled();
  });

  it.each([
    ["bad", undefined, undefined, "invalid_session_id"],
    [SESSION_ID, "-1", undefined, "invalid_cursor"],
    [SESSION_ID, undefined, "NaN", "invalid_cursor"],
  ])("rejects invalid stream boundaries before recovery", async (sessionId, cursor, lastEventId, code) => {
    const response = await GET(request(cursor, lastEventId), context(sessionId));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: { code } });
    expect(openEventStream).not.toHaveBeenCalled();
  });

  it("surfaces ownership and registry failures before committing SSE headers", async () => {
    openEventStream.mockRejectedValueOnce(new SessionServiceError(503, "session_registry_unavailable", "Try again.", 5));
    const response = await GET(request(), context());
    expect(response.status).toBe(503);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("retry-after")).toBe("5");
  });

  it("emits live pages once and advances the lease cursor", async () => {
    vi.useFakeTimers();
    readPage
      .mockResolvedValueOnce({
        cursor: 6,
        events: [{ protocolVersion: 1, type: "session.status", state: "thinking" }],
      })
      .mockResolvedValueOnce({ cursor: 6, events: [] });
    const response = await GET(request("4"), context());
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    await reader.read();
    await reader.read();

    const livePage = reader.read();
    await vi.advanceTimersByTimeAsync(1_000);
    const encoded = decoder.decode((await livePage).value);
    expect(encoded).toContain("id: 6\nevent: session.status\n");
    expect(encoded).toContain('"state":"thinking"');

    await vi.advanceTimersByTimeAsync(1_000);
    expect(readPage.mock.calls).toEqual([[5], [6]]);
    await reader.cancel();
  });

  it("closes an established stream when a real polling adapter fails", async () => {
    vi.useFakeTimers();
    readPage.mockRejectedValueOnce(new Error("redis offline"));
    const response = await GET(request("4"), context());
    const reader = response.body!.getReader();
    await reader.read();
    await reader.read();

    const pending = reader.read();
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(pending).resolves.toEqual({ done: true, value: undefined });
    expect(readPage).toHaveBeenCalledWith(5);
    expect(release).toHaveBeenCalled();
  });
});
