import { AuthError } from "@/lib/server/auth";
import type * as AuthModule from "@/lib/server/auth";
import { SessionServiceError } from "@/lib/server/session/service";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { requireMutationSession, close } = vi.hoisted(() => ({ requireMutationSession: vi.fn(), close: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/server/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof AuthModule>()),
  requireMutationSession,
}));
vi.mock("@/lib/server/session/runtime", () => ({ createSessionServiceFromEnv: () => ({ close }) }));

import { POST } from "./route";

const SESSION_ID = "00000000-0000-4000-8000-000000000041";
const learner = { learnerId: "lrn_1234567890abcdef", ageBand: "13-15" };
const input = {
  protocolVersion: 1,
  commandId: "10000000-0000-4000-8000-000000000041",
  revision: 12,
  reason: "complete",
};
const context = (sessionId = SESSION_ID) => ({ params: Promise.resolve({ sessionId }) });
function request(body: unknown): Request {
  return new Request(`http://localhost/api/session/${SESSION_ID}/close`, {
    method: "POST",
    headers: { origin: "http://localhost", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/session/[sessionId]/close", () => {
  beforeEach(() => {
    requireMutationSession.mockReset().mockResolvedValue(learner);
    close.mockReset().mockResolvedValue({ sessionId: SESSION_ID, summary: "Completed orbit lesson.", deleted: true });
  });
  afterEach(() => vi.restoreAllMocks());

  it("closes with the caller command and terminal revision fence", async () => {
    const response = await POST(request(input), context());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(close).toHaveBeenCalledWith(learner, SESSION_ID, input);
    await expect(response.json()).resolves.toMatchObject({ deleted: true });
  });

  it("requires mutation authorization before terminal close", async () => {
    requireMutationSession.mockRejectedValueOnce(new AuthError(403, "invalid_origin", "Forbidden."));
    const response = await POST(request(input), context());
    expect(response.status).toBe(403);
    expect(close).not.toHaveBeenCalled();
  });

  it.each([
    ["bad", input, "invalid_session_id"],
    [SESSION_ID, { ...input, reason: "timeout" }, "invalid_request"],
    [SESSION_ID, { ...input, revision: -1 }, "invalid_request"],
  ])("rejects invalid terminal boundaries", async (sessionId, body, code) => {
    const response = await POST(request(body), context(sessionId));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: { code } });
    expect(close).not.toHaveBeenCalled();
  });

  it.each([
    ["revision_conflict", "A newer command already won."],
    ["session_terminal", "The session is already closed."],
  ])("does not let a stale close resurrect terminal state: %s", async (code, message) => {
    close.mockRejectedValueOnce(new SessionServiceError(409, code, message));
    const response = await POST(request(input), context());
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: { code } });
    expect(close).toHaveBeenCalledOnce();
  });

  it("returns an opaque error when durable close fails", async () => {
    close.mockRejectedValueOnce(new Error("redis endpoint"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = await POST(request(input), context());
    expect(response.status).toBe(500);
    await expect(response.text()).resolves.not.toContain("redis endpoint");
  });
});
