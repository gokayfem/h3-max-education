import type { NextConfig } from "next";
import { resolvePublicFalFeature } from "./src/lib/server/fal-config";
const gatewayOrigin = process.env.NEXT_PUBLIC_GATEWAY_URL ?? "";
const publicFalGrokVoiceEnabled = resolvePublicFalFeature(
  process.env,
  "FAL_GROK_VOICE_ENABLED",
  "NEXT_PUBLIC_FAL_GROK_VOICE_ENABLED",
);
const publicFalQueueEnabled = resolvePublicFalFeature(
  process.env,
  "FAL_QUEUE_ENABLED",
  "NEXT_PUBLIC_FAL_QUEUE_ENABLED",
);

const contentSecurityPolicy = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${process.env.NODE_ENV === "development" ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' blob: data:",
  "media-src 'self' blob: https://fal.media https://*.fal.media",
  "font-src 'self' data:",
  `connect-src 'self' https://api.openai.com wss://api.openai.com https://rest.fal.ai https://*.fal.ai wss://fal.run wss://*.fal.run ${gatewayOrigin}`,
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'"
].join("; ");

const nextConfig: NextConfig = {
  allowedDevOrigins: ["127.0.0.1"],
  poweredByHeader: false,
  env: {
    NEXT_PUBLIC_FAL_GROK_VOICE_ENABLED: publicFalGrokVoiceEnabled,
    NEXT_PUBLIC_FAL_QUEUE_ENABLED: publicFalQueueEnabled,
  },
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "Content-Security-Policy", value: contentSecurityPolicy },
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
          { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Strict-Transport-Security", value: "max-age=31536000" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-DNS-Prefetch-Control", value: "off" },
          { key: "X-Permitted-Cross-Domain-Policies", value: "none" },
          { key: "Permissions-Policy", value: "camera=(), geolocation=(), microphone=(self)" }
        ]
      }
    ];
  }
};

export default nextConfig;
