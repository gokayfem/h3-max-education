import { AuthError } from "@/lib/server/auth";
import type * as AuthModule from "@/lib/server/auth";
import { SessionServiceError } from "@/lib/server/session/service";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { requireMutationSession, turn } = vi.hoisted(() => ({ requireMutationSession: vi.fn(), turn: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/server/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof AuthModule>()),
  requireMutationSession,
}));
vi.mock("@/lib/server/session/runtime", () => ({ createSessionServiceFromEnv: () => ({ turn }) }));

import { POST } from "./route";

const SESSION_ID = "00000000-0000-4000-8000-000000000021";
const learner = { learnerId: "lrn_1234567890abcdef", ageBand: "13-15" };
const input = {
  protocolVersion: 1,
  commandId: "10000000-0000-4000-8000-000000000021",
  revision: 7,
  text: "Why?",
};
const context = (sessionId = SESSION_ID) => ({ params: Promise.resolve({ sessionId }) });
function request(body: BodyInit, headers: Record<string, string> = {}): Request {
  return new Request(`http://localhost/api/session/${SESSION_ID}/turn`, {
    method: "POST",
    headers: { origin: "http://localhost", "content-type": "application/json", ...headers },
    body,
  });
}

describe("POST /api/session/[sessionId]/turn", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    requireMutationSession.mockReset().mockResolvedValue(learner);
    turn.mockReset().mockResolvedValue({ sessionId: SESSION_ID, reply: "Gravity bends the path.", events: [] });
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("hands the browser revision and command identity to the durable turn authority", async () => {
    const response = await POST(request(JSON.stringify(input)), context());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(turn).toHaveBeenCalledWith(learner, SESSION_ID, input);
  });

  it("requires an authorized same-origin learner mutation", async () => {
    requireMutationSession.mockRejectedValueOnce(new AuthError(403, "invalid_origin", "Forbidden."));
    const response = await POST(request(JSON.stringify(input)), context());
    expect(response.status).toBe(403);
    expect(turn).not.toHaveBeenCalled();
  });

  it.each([
    ["bad session", JSON.stringify(input), "text/plain", "invalid_session_id"],
    [SESSION_ID, JSON.stringify({ ...input, revision: -1 }), "application/json", "invalid_request"],
    [SESSION_ID, "{", "application/json", "invalid_request"],
    [SESSION_ID, JSON.stringify(input), "text/plain", "unsupported_media_type"],
  ])("rejects invalid session and request boundaries", async (sessionId, body, contentType, code) => {
    const response = await POST(request(body, { "content-type": contentType }), context(sessionId));
    expect(response.status).toBe(code === "unsupported_media_type" ? 415 : 400);
    await expect(response.json()).resolves.toMatchObject({ error: { code } });
    expect(turn).not.toHaveBeenCalled();
  });

  it("bounds a chunked body without trusting content-length", async () => {
    const stream = new ReadableStream<string>({
      start(controller) {
        controller.enqueue(`{"protocolVersion":1,"commandId":"cmd_12345678","revision":7,"text":"${"x".repeat(17_000)}`);
        controller.enqueue('"}');
        controller.close();
      },
    }).pipeThrough(new TextEncoderStream());
    const chunked = new Request(`http://localhost/api/session/${SESSION_ID}/turn`, {
      method: "POST",
      headers: { origin: "http://localhost", "content-type": "application/json" },
      body: stream,
      duplex: "half",
    } as RequestInit & { duplex: "half" });

    const response = await POST(chunked, context());
    expect(response.status).toBe(413);
    expect(turn).not.toHaveBeenCalled();
  });

  it("surfaces stale typed/voice revision fencing without retrying the mutation", async () => {
    turn.mockRejectedValueOnce(new SessionServiceError(409, "revision_conflict", "Recover before sending another turn."));
    const response = await POST(request(JSON.stringify(input)), context());
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "revision_conflict" } });
    expect(turn).toHaveBeenCalledOnce();
  });

  it("maps an unexpected tutor failure to an opaque real error", async () => {
    turn.mockRejectedValueOnce(new Error("provider secret"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = await POST(request(JSON.stringify(input)), context());
    expect(response.status).toBe(500);
    await expect(response.text()).resolves.not.toContain("provider secret");
  });
});
