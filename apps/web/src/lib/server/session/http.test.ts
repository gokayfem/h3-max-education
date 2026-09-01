import { describe, expect, it, vi, type Mock } from "vitest";
import { SessionServiceError } from "./service";
import { readBoundedJsonBody, readBoundedRequestBody } from "./http";

vi.mock("server-only", () => ({}));

function streamedRequest(
  chunks: Uint8Array[],
  headers: Record<string, string> = {},
  cancel: Mock = vi.fn(),
): { request: Request; cancel: Mock } {
  let index = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[index++];
      if (chunk) controller.enqueue(chunk);
      else controller.close();
    },
    cancel,
  }, { highWaterMark: 0 });
  return {
    request: new Request("https://axiom.test/api/session", {
      method: "POST",
      headers,
      body,
      duplex: "half",
    } as RequestInit & { duplex: "half" }),
    cancel,
  };
}

describe("bounded request bodies", () => {
  it("cancels a chunked body as soon as cumulative bytes exceed the ceiling", async () => {
    const first = new TextEncoder().encode("1234");
    const second = new TextEncoder().encode("5678");
    const { request, cancel } = streamedRequest([first, second], {
      "content-length": "1",
    });

    await expect(readBoundedRequestBody(request, 6)).rejects.toMatchObject({
      status: 413,
      code: "request_too_large",
    });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("rejects a declared oversize body without reading it and cancels the stream", async () => {
    const pull = vi.fn();
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ pull, cancel }, { highWaterMark: 0 });
    const request = new Request("https://axiom.test/api/session", {
      method: "POST",
      headers: { "content-length": "100" },
      body,
      duplex: "half",
    } as RequestInit & { duplex: "half" });

    await expect(readBoundedRequestBody(request, 8)).rejects.toBeInstanceOf(SessionServiceError);
    expect(cancel).toHaveBeenCalledOnce();
    expect(pull).not.toHaveBeenCalled();
  });

  it("parses JSON split across chunks when it remains within the byte ceiling", async () => {
    const encoder = new TextEncoder();
    const { request, cancel } = streamedRequest(
      [encoder.encode('{"display'), encoder.encode('Name":"Maya"}')],
      { "content-type": "application/json", "content-length": "2" },
    );

    await expect(readBoundedJsonBody(request, 64)).resolves.toEqual({ displayName: "Maya" });
    expect(cancel).not.toHaveBeenCalled();
  });
});
