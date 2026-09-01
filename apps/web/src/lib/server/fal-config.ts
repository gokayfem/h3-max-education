type FalFeatureEnvironment = Readonly<Record<string, string | undefined>>;

type FalServerFeature =
  | "FAL_GROK_VOICE_ENABLED"
  | "FAL_QUEUE_ENABLED";

type FalPublicFeature =
  | "NEXT_PUBLIC_FAL_GROK_VOICE_ENABLED"
  | "NEXT_PUBLIC_FAL_QUEUE_ENABLED";

function configuredBoolean(value: string | undefined): boolean | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return undefined;
  return normalized === "true";
}

export function isFalFeatureEnabled(
  environment: FalFeatureEnvironment,
  feature: FalServerFeature,
): boolean {
  if (!environment.FAL_KEY?.trim()) return false;
  return configuredBoolean(environment[feature]) ?? true;
}

export function resolvePublicFalFeature(
  environment: FalFeatureEnvironment,
  serverFeature: FalServerFeature,
  publicFeature: FalPublicFeature,
): "true" | "false" {
  if (!isFalFeatureEnabled(environment, serverFeature)) return "false";
  return configuredBoolean(environment[publicFeature]) === false ? "false" : "true";
}
