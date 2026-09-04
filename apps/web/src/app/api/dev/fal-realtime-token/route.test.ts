import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { POST } from "./route";

const URL = "http://localhost/api/dev/fal-realtime-token";

function request(origin = "http://localhost"): Request {
  return new Request(URL, {
    method: "POST",
    headers: { origin, host: "localhost" },
  });
}

describe("POST /api/dev/fal-realtime-token", () => {
  beforeEach(() => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("FAL_KEY", "test-fal-key");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("mints a short-lived Grok Voice token with only FAL_KEY configured", async () => {
    const upstream = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json("voice-token-with-enough-characters"),
    );

    const response = await POST(request());

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store, private");
    expect(await response.json()).toEqual({
      token: "voice-token-with-enough-characters",
      expiresInSeconds: 120,
    });
    expect(upstream).toHaveBeenCalledWith(
      "https://rest.fal.ai/tokens/realtime",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ app: "xai/grok-voice/realtime", duration: 120 }),
      }),
    );
  });

  it("explains how to top up when fal reports an exhausted balance", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json(
        { detail: "User is locked. Reason: Exhausted balance. Top up your balance at fal.ai/dashboard/billing" },
        { status: 403 },
      ),
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const response = await POST(request());

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: "Your fal.ai balance is exhausted. Top up at https://fal.ai/dashboard/billing, then retry voice.",
      code: "fal_balance_exhausted",
      billingUrl: "https://fal.ai/dashboard/billing",
    });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("https://fal.ai/dashboard/billing"),
      expect.objectContaining({ status: 403 }),
    );
  });

  it("returns 502 and logs the upstream reason for other fal rejections", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ detail: "Invalid authentication credentials" }, { status: 401 }),
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const response = await POST(request());

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "Grok Voice is unavailable." });
    expect(warn).toHaveBeenCalledWith(
      "fal realtime token request failed",
      expect.objectContaining({ status: 401, detail: "Invalid authentication credentials" }),
    );
  });

  it("rejects cross-origin requests", async () => {
    const upstream = vi.spyOn(globalThis, "fetch");

    const response = await POST(request("https://attacker.example"));

    expect(response.status).toBe(403);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("is unavailable when Grok Voice is not configured", async () => {
    vi.stubEnv("FAL_GROK_VOICE_ENABLED", "false");
    const upstream = vi.spyOn(globalThis, "fetch");

    const response = await POST(request());

    expect(response.status).toBe(503);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("does not exist in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const upstream = vi.spyOn(globalThis, "fetch");

    const response = await POST(request());

    expect(response.status).toBe(404);
    expect(upstream).not.toHaveBeenCalled();
  });
});
