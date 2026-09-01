import { AuthError } from "@/lib/server/auth";
import type * as AuthModule from "@/lib/server/auth";
import { SessionServiceError } from "@/lib/server/session/service";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";

const { requireMutationSession, create } = vi.hoisted(() => ({
  requireMutationSession: vi.fn(),
  create: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/server/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof AuthModule>();
  return { ...actual, requireMutationSession };
});
vi.mock("@/lib/server/session/runtime", () => ({ createSessionServiceFromEnv: () => ({ create }) }));


function request(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/api/session", {
    method: "POST",
    headers: { origin: "http://localhost", "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("POST /api/session", () => {
  beforeEach(() => {
    requireMutationSession.mockReset();
    create.mockReset();
  });

  it("requires a signed learner session", async () => {
    requireMutationSession.mockRejectedValue(
      new AuthError(401, "authentication_required", "A valid learner session is required."),
    );

    const response = await POST(request({ idempotencyKey: "create-key-1" }));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "authentication_required" } });
    expect(create).not.toHaveBeenCalled();
  });

  it("validates input before invoking the service", async () => {
    requireMutationSession.mockResolvedValue({ learnerId: "lrn_1234567890abcdef", ageBand: "13-15" });

    const response = await POST(request({ question: "" }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "invalid_request" } });
    expect(create).not.toHaveBeenCalled();
  });

  it("creates a typed text-only lesson", async () => {
    const learner = { learnerId: "lrn_1234567890abcdef", ageBand: "13-15" };
    requireMutationSession.mockResolvedValue(learner);
    create.mockResolvedValue({
      sessionId: "00000000-0000-4000-8000-000000000001",
      state: "text_only",
      events: [{ protocolVersion: 1, type: "session.status", state: "text_only" }],
    });

    const response = await POST(request({ question: "Why do planets orbit?", idempotencyKey: "create-key-2" }));

    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(create).toHaveBeenCalledWith(learner, {
      question: "Why do planets orbit?",
      idempotencyKey: "create-key-2",
    });
  });

  it("rejects oversized bodies before service work", async () => {
    requireMutationSession.mockResolvedValue({ learnerId: "lrn_1234567890abcdef", ageBand: "13-15" });

    const response = await POST(request({ idempotencyKey: "create-key-3" }, { "content-length": "20000" }));

    expect(response.status).toBe(413);
    expect(create).not.toHaveBeenCalled();
  });

  it("bounds a chunked body when content-length is absent", async () => {
    requireMutationSession.mockResolvedValue({ learnerId: "lrn_1234567890abcdef", ageBand: "13-15" });
    const stream = new ReadableStream<string>({
      start(controller) {
        controller.enqueue(`{\"idempotencyKey\":\"create-key-chunked\",\"question\":\"${"x".repeat(17_000)}`);
        controller.enqueue('\"}');
        controller.close();
      },
    }).pipeThrough(new TextEncoderStream());
    const chunked = new Request("http://localhost/api/session", {
      method: "POST",
      headers: { origin: "http://localhost", "content-type": "application/json" },
      body: stream,
      duplex: "half",
    } as RequestInit & { duplex: "half" });

    const response = await POST(chunked);
    expect(response.status).toBe(413);
    expect(create).not.toHaveBeenCalled();
  });

  it("preserves recoverable registry errors from the service", async () => {
    requireMutationSession.mockResolvedValue({ learnerId: "lrn_1234567890abcdef", ageBand: "13-15" });
    create.mockRejectedValueOnce(new SessionServiceError(503, "session_registry_unavailable", "Try again.", 9));

    const response = await POST(request({ idempotencyKey: "create-key-registry" }));
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("9");
    await expect(response.json()).resolves.toMatchObject({ error: { code: "session_registry_unavailable" } });
  });
});
