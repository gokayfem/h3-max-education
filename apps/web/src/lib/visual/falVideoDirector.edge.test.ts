import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VisualSpec } from "@axiom/protocol";
import { ACTIVE_SESSION_STORAGE_KEY } from "@/lib/session-storage";
import { FalVideoDirector, type FalVideoDirectorOptions } from "./falVideoDirector";

const sessionId = "123e4567-e89b-42d3-a456-426614174000";
const reservationId = "123e4567-e89b-42d3-a456-426614174001";
const spec: VisualSpec = {
  concept: "orbits", teachingIntent: "Explain gravity", visualDescription: "A planet orbits a star",
  durationSeconds: 5, continuityKey: "orbits",
};
const allowance = { remainingSeconds: 115, dailyLimitSeconds: 120 };
const reservation = { reservationId, expiresInSeconds: 60, ...allowance };
const authorization = { sessionId, reservationId, durationSeconds: 5 as const, ...allowance };
const directors: FalVideoDirector[] = [];

function createDirector(options: FalVideoDirectorOptions = {}) {
  const director = new FalVideoDirector(options);
  directors.push(director);
  return director;
}

beforeEach(() => {
  sessionStorage.setItem(ACTIVE_SESSION_STORAGE_KEY, sessionId);
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.endsWith("/reserve")) return Response.json(reservation);
    if (url.endsWith("/generate")) return Response.json({ videoUrl: "https://example.test/clip.mp4", ...allowance });
    if (url.endsWith("/release")) return Response.json({ remainingSeconds: 120, dailyLimitSeconds: 120 });
    throw new Error(`Unexpected test request: ${url}`);
  }));
});

afterEach(async () => {
  await Promise.all(directors.splice(0).map((director) => director.dispose()));
  sessionStorage.clear();
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("visual authorization and cancellation", () => {
  it.each([null, "invalid-session"])("rejects an unavailable session (%s) before requesting a reservation", async (stored) => {
    if (stored === null) sessionStorage.clear();
    else sessionStorage.setItem(ACTIVE_SESSION_STORAGE_KEY, stored);
    const director = createDirector();
    await expect(director.start(spec, 1)).resolves.toBe(false);
    expect(fetch).not.toHaveBeenCalled();
    expect(director.snapshot.failure?.reason).toBe("authorization");
  });

  it.each(["daily_limit", "global_limit", "concurrency_limit"])("preserves the allowance reported with %s", async (code) => {
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({
      error: { code, message: "Limit reached" }, remainingSeconds: 0, dailyLimitSeconds: 120,
    }, { status: 429 }));
    const director = createDirector();
    await expect(director.start(spec, 1)).resolves.toBe(false);
    expect(director.snapshot).toMatchObject({
      status: "failed", remainingSeconds: 0, dailyLimitSeconds: 120,
      failure: { reason: "quota_denied", message: "Limit reached" },
    });
  });

  it.each([
    { error: { code: "forbidden", message: "Access denied" } },
    { error: { code: "forbidden", message: "Access denied" }, remainingSeconds: 20 },
    { unexpected: "provider-internal-detail" },
  ])("handles authorization failures without a complete allowance", async (payload) => {
    vi.mocked(fetch).mockResolvedValueOnce(Response.json(payload, { status: 403 }));
    const director = createDirector();
    await expect(director.start(spec, 1)).resolves.toBe(false);
    expect(director.snapshot.failure?.reason).toBe("authorization");
    expect(director.snapshot.remainingSeconds).toBeNull();
    expect(director.snapshot.failure?.message).not.toContain("provider-internal-detail");
  });

  it("handles a non-JSON authorization error", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response("upstream unavailable", { status: 503 }));
    const director = createDirector();
    await expect(director.start(spec, 1)).resolves.toBe(false);
    expect(director.snapshot.failure?.message).toBe("Unable to authorize visual generation (503)");
  });

  it("sends session-bound same-origin reserve and generation requests", async () => {
    const director = createDirector();
    await expect(director.start(spec, 1)).resolves.toBe(true);
    const calls = vi.mocked(fetch).mock.calls;
    expect(calls.map(([url]) => url)).toEqual(["/api/fal/reserve", "/api/fal/generate"]);
    for (const [, init] of calls) expect(init).toMatchObject({ method: "POST", credentials: "same-origin", cache: "no-store" });
    expect(JSON.parse(String(calls[0]?.[1]?.body))).toEqual({ sessionId, durationSeconds: 5 });
    expect(JSON.parse(String(calls[1]?.[1]?.body))).toMatchObject({ sessionId, reservationId, durationSeconds: 5 });
    const video = document.createElement("video");
    director.attachVideoElement(video);
    expect(video.src).toBe("https://example.test/clip.mp4");
  });

  it.each(["http", "insecure-url", "malformed"])("rejects an invalid generation response (%s) and releases its reservation", async (mode) => {
    vi.mocked(fetch).mockResolvedValueOnce(Response.json(reservation)).mockResolvedValueOnce(
      mode === "http" ? new Response("unavailable", { status: 502 }) : Response.json(
        mode === "insecure-url" ? { videoUrl: "http://example.test/clip.mp4", ...allowance } : { videoUrl: null },
      ),
    );
    const director = createDirector();
    await expect(director.start(spec, 1)).resolves.toBe(false);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/fal/release", expect.objectContaining({ keepalive: true })));
    expect(director.snapshot.failure?.reason).toBe("transport");
  });

  it.each([200, 503])("stops an in-flight generation even when reservation release returns %s", async (status) => {
    const started = Promise.withResolvers<void>();
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (String(input).endsWith("/reserve")) return Response.json(reservation);
      if (String(input).endsWith("/release")) return Response.json({ remainingSeconds: 120, dailyLimitSeconds: 120 }, { status });
      started.resolve();
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
      });
    });
    const director = createDirector();
    const generation = director.start(spec, 1);
    await started.promise;
    await director.stop();
    await expect(generation).resolves.toBe(false);
    expect(director.snapshot.status).toBe("stopped");
    expect(director.snapshot.remainingSeconds).toBe(status === 200 ? 120 : 115);
  });

  it("releases an authorization that arrives after cancellation", async () => {
    const pending = Promise.withResolvers<typeof authorization>();
    const getAuthorization = vi.fn(() => pending.promise);
    const releaseAuthorization = vi.fn(async () => null);
    const generateVideo = vi.fn();
    const director = createDirector({ getAuthorization, releaseAuthorization, generateVideo });
    const generation = director.start(spec, 1);
    await vi.waitFor(() => expect(getAuthorization).toHaveBeenCalledOnce());
    await director.continuePlaybackUntilReplacement();
    pending.resolve(authorization);
    await expect(generation).resolves.toBe(false);
    expect(releaseAuthorization).toHaveBeenCalledWith(authorization);
    expect(generateVideo).not.toHaveBeenCalled();
    expect(director.getPipelineTimings()[0]).toMatchObject({ generationMs: null, triggerToReadyMs: null, triggerToDisplayMs: null });
  });
});

describe("queued playback recovery", () => {
  it("caps prefetch and resumes accepting requests after discarding pending clips", async () => {
    const director = createDirector();
    for (let version = 1; version <= 7; version++) await expect(director.start(spec, version)).resolves.toBe(true);
    expect(director.canAcceptGeneration()).toBe(false);
    await expect(director.start(spec, 8)).resolves.toBe(false);
    await director.continuePlaybackUntilReplacement();
    expect(director.canAcceptGeneration()).toBe(true);
    expect(director.snapshot.status).toBe("holding");
  });

  it("detaches the old video when the playback element changes", async () => {
    const director = createDirector();
    const first = document.createElement("video");
    const second = document.createElement("video");
    director.attachVideoElement(first);
    await director.start(spec, 1);
    director.attachVideoElement(second);
    expect(first.getAttribute("src")).toBeNull();
    expect(second.src).toBe("https://example.test/clip.mp4");
    director.attachVideoElement(null);
    expect(second.getAttribute("src")).toBeNull();
  });

  it("hands off to the next clip without a wrapper element", async () => {
    const director = createDirector();
    const video = document.createElement("video");
    director.attachVideoElement(video);
    await director.start(spec, 1);
    await director.start(spec, 2);
    video.dispatchEvent(new Event("ended"));
    await vi.waitFor(() => expect(director.getPipelineTimings()[1]?.triggerToDisplayMs).not.toBeNull());
    expect(video.loop).toBe(true);
    video.dispatchEvent(new Event("ended"));
    expect(video.play).toHaveBeenCalled();
  });

  it("crossfades decoded clips and removes the temporary overlay", async () => {
    vi.useFakeTimers();
    vi.spyOn(HTMLMediaElement.prototype, "readyState", "get").mockReturnValue(HTMLMediaElement.HAVE_CURRENT_DATA);
    const director = createDirector();
    const container = document.createElement("div");
    const video = document.createElement("video");
    video.style.opacity = "0.8";
    video.style.transition = "opacity 1s";
    container.append(video);
    document.body.append(container);
    director.attachVideoElement(video);
    await director.start(spec, 1);
    await director.start(spec, 2);
    video.dispatchEvent(new Event("ended"));
    await vi.advanceTimersByTimeAsync(500);
    expect(container.querySelectorAll("video")).toHaveLength(1);
    expect(video.style.opacity).toBe("0.8");
    expect(video.style.transition).toBe("opacity 1s");
    expect(director.getPipelineTimings()[1]?.triggerToDisplayMs).not.toBeNull();
  });

  it.each(["error", "timeout", "cancel"])("keeps the current video when crossfade preparation ends in %s", async (failure) => {
    vi.useFakeTimers();
    const director = createDirector();
    const container = document.createElement("div");
    const video = document.createElement("video");
    container.append(video);
    document.body.append(container);
    director.attachVideoElement(video);
    await director.start(spec, 1);
    await director.start(spec, 2);
    video.dispatchEvent(new Event("ended"));
    const overlay = container.querySelectorAll("video")[1]!;
    if (failure === "error") overlay.dispatchEvent(new Event("error"));
    else if (failure === "cancel") await director.continuePlaybackUntilReplacement();
    await vi.advanceTimersByTimeAsync(failure === "timeout" ? 20_001 : 1);
    expect(container.querySelectorAll("video")).toHaveLength(1);
    expect(video.src).toBe("https://example.test/clip.mp4");
    expect(director.getPipelineTimings()[1]?.triggerToDisplayMs).toBeNull();
  });
});
