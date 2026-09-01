import { AuthError } from "@/lib/server/auth";
import type * as AuthModule from "@/lib/server/auth";
import { SessionServiceError } from "@/lib/server/session/service";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { requireMutationSession, selectCard } = vi.hoisted(() => ({ requireMutationSession: vi.fn(), selectCard: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/server/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof AuthModule>()),
  requireMutationSession,
}));
vi.mock("@/lib/server/session/runtime", () => ({ createSessionServiceFromEnv: () => ({ selectCard }) }));

import { POST } from "./route";

const SESSION_ID = "00000000-0000-4000-8000-000000000031";
const learner = { learnerId: "lrn_1234567890abcdef", ageBand: "13-15" };
const input = {
  protocolVersion: 1,
  commandId: "10000000-0000-4000-8000-000000000031",
  revision: 9,
  cardId: "orbit",
};
const context = (sessionId = SESSION_ID) => ({ params: Promise.resolve({ sessionId }) });
function request(body: unknown): Request {
  return new Request(`http://localhost/api/session/${SESSION_ID}/card`, {
    method: "POST",
    headers: { origin: "http://localhost", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/session/[sessionId]/card", () => {
  beforeEach(() => {
    requireMutationSession.mockReset().mockResolvedValue(learner);
    selectCard.mockReset().mockResolvedValue({ sessionId: SESSION_ID, reply: "Good prediction.", events: [] });
  });
  afterEach(() => vi.restoreAllMocks());

  it("selects a card through the same revisioned command authority", async () => {
    const response = await POST(request(input), context());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(selectCard).toHaveBeenCalledWith(learner, SESSION_ID, input);
  });

  it("requires mutation authorization before selecting", async () => {
    requireMutationSession.mockRejectedValueOnce(new AuthError(401, "authentication_required", "Sign in."));
    const response = await POST(request(input), context());
    expect(response.status).toBe(401);
    expect(selectCard).not.toHaveBeenCalled();
  });

  it.each([
    ["bad", input, "invalid_session_id"],
    [SESSION_ID, { ...input, cardId: "" }, "invalid_request"],
    [SESSION_ID, { ...input, revision: 8, extra: true }, "invalid_request"],
  ])("rejects invalid card boundaries", async (sessionId, body, code) => {
    const response = await POST(request(body), context(sessionId));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: { code } });
    expect(selectCard).not.toHaveBeenCalled();
  });

  it("preserves duplicate and stale-command conflict semantics", async () => {
    selectCard.mockRejectedValueOnce(new SessionServiceError(409, "revision_conflict", "Recover first."));
    const response = await POST(request(input), context());
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "revision_conflict" } });
    expect(selectCard).toHaveBeenCalledOnce();
  });

  it("returns an opaque error when the card registry is unavailable", async () => {
    selectCard.mockRejectedValueOnce(new Error("registry credentials"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = await POST(request(input), context());
    expect(response.status).toBe(500);
    await expect(response.text()).resolves.not.toContain("registry credentials");
  });
});
