import { describe, expect, it } from "vitest";
import nextConfig from "../next.config";

describe("browser security headers", () => {
  it("applies transport and cross-origin hardening to every response", async () => {
    const headers = await nextConfig.headers?.();
    const configured = Object.fromEntries(
      (headers?.[0]?.headers ?? []).map(({ key, value }) => [key, value]),
    );

    expect(configured).toMatchObject({
      "Cross-Origin-Resource-Policy": "same-origin",
      "Strict-Transport-Security": "max-age=31536000",
      "X-DNS-Prefetch-Control": "off",
      "X-Permitted-Cross-Domain-Policies": "none",
    });
  });
});
