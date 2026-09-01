import { describe, expect, it } from "vitest";
import {
  isFalFeatureEnabled,
  resolvePublicFalFeature,
} from "./fal-config";

describe("fal configuration", () => {
  it("enables every fal feature when FAL_KEY is the only configured value", () => {
    const environment = { FAL_KEY: "fal-key" };

    expect(isFalFeatureEnabled(environment, "FAL_GROK_VOICE_ENABLED")).toBe(true);
    expect(isFalFeatureEnabled(environment, "FAL_QUEUE_ENABLED")).toBe(true);
  });

  it("keeps fal features disabled without a key", () => {
    expect(isFalFeatureEnabled({}, "FAL_GROK_VOICE_ENABLED")).toBe(false);
  });

  it("honors an explicit server-side kill switch", () => {
    expect(isFalFeatureEnabled(
      { FAL_KEY: "fal-key", FAL_GROK_VOICE_ENABLED: "false" },
      "FAL_GROK_VOICE_ENABLED",
    )).toBe(false);
  });

  it("derives browser-safe feature flags without exposing the key", () => {
    expect(resolvePublicFalFeature(
      { FAL_KEY: "fal-key" },
      "FAL_QUEUE_ENABLED",
      "NEXT_PUBLIC_FAL_QUEUE_ENABLED",
    )).toBe("true");
    expect(resolvePublicFalFeature(
      {
        FAL_KEY: "fal-key",
        FAL_QUEUE_ENABLED: "true",
        NEXT_PUBLIC_FAL_QUEUE_ENABLED: "false",
      },
      "FAL_QUEUE_ENABLED",
      "NEXT_PUBLIC_FAL_QUEUE_ENABLED",
    )).toBe("false");
  });
});
