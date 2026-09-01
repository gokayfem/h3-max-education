import { AuthError } from "@/lib/server/auth";
import type * as AuthModule from "@/lib/server/auth";
import { SessionServiceError } from "@/lib/server/session/service";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { requireSession, recover } = vi.hoisted(() => ({
  requireSession: vi.fn(),
  recover: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/server/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof AuthModule>()),
  requireSession,
}));
vi.mock("@/lib/server/session/runtime", () => ({
  createSessionServiceFromEnv: () => ({ recover }),
}));

import { GET } from "./route";

const SESSION_ID = "00000000-0000-4000-8000-000000000011";
const learner = { learnerId: "lrn_1234567890abcdef", ageBand: "13-15" };
const context = (sessionId = SESSION_ID) => ({ params: Promise.resolve({ sessionId }) });
const request = (cursor?: string) => new Request(
  `http://localhost/api/session/${SESSION_ID}/recover${cursor === undefined ? "" : `?cursor=${cursor}`}`,
);

describe("GET /api/session/[sessionId]/recover", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    requireSession.mockReset().mockResolvedValue(learner);
    recover.mockReset().mockResolvedValue({ sessionId: SESSION_ID, cursor: 4, events: [], state: { revision: 4 } });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("recovers the owned session from an explicit cursor without caching", async () => {
    const response = await GET(request("3"), context());

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(recover).toHaveBeenCalledWith(learner, SESSION_ID, 3);
    await expect(response.json()).resolves.toMatchObject({ cursor: 4, state: { revision: 4 } });
  });

  it("requires authentication before ownership recovery", async () => {
    requireSession.mockRejectedValueOnce(new AuthError(401, "authentication_required", "Sign in."));

    const response = await GET(request(), context());

    expect(response.status).toBe(401);
    expect(recover).not.toHaveBeenCalled();
  });

  it.each([["not-a-uuid", undefined, "invalid_session_id"], [SESSION_ID, "-1", "invalid_cursor"], [SESSION_ID, "1.2", "invalid_cursor"]])(
    "rejects invalid recovery boundaries",
    async (sessionId, cursor, code) => {
      const response = await GET(request(cursor), context(sessionId));
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({ error: { code } });
      expect(recover).not.toHaveBeenCalled();
    },
  );

  it("preserves service authorization and registry-outage errors", async () => {
    recover.mockRejectedValueOnce(new SessionServiceError(503, "session_registry_unavailable", "Try again.", 7));

    const response = await GET(request("0"), context());

    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("7");
    await expect(response.json()).resolves.toMatchObject({ error: { code: "session_registry_unavailable" } });
  });

  it("does not expose unexpected persistence failures", async () => {
    recover.mockRejectedValueOnce(new Error("redis password leaked"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = await GET(request(), context());

    expect(response.status).toBe(500);
    await expect(response.text()).resolves.not.toContain("redis password leaked");
  });
});
