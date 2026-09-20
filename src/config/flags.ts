export interface FeatureFlags {
  enableV2: boolean;
  enableLearnedRanker: boolean;
  enableTreeSitter: boolean;
  enableScip: boolean;
  enableAdaptiveContext: boolean;
  enableTelemetry: boolean;
}

let activeOverrides: Partial<FeatureFlags> | null = null;

export function getFeatureFlags(): FeatureFlags {
  const envV2 = process.env.SIFTR_V2 === 'true' || process.env.SIFTR_V2 === '1';

  const defaults: FeatureFlags = {
    enableV2: envV2,
    enableLearnedRanker: false,
    enableTreeSitter: false,
    enableScip: false,
    enableAdaptiveContext: false,
    enableTelemetry: false,
  };

  if (activeOverrides) {
    return { ...defaults, ...activeOverrides };
  }

  return defaults;
}

export function isV2Enabled(): boolean {
  return getFeatureFlags().enableV2;
}

export function setFeatureFlags(overrides: Partial<FeatureFlags>): void {
  activeOverrides = { ...(activeOverrides || {}), ...overrides };
}

export function resetFeatureFlags(): void {
  activeOverrides = null;
}
