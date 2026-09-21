/**
 * Test Environment Scrubber
 *
 * Ensures that non-integration test environments are hermetic and cannot
 * inadvertently leak live JEV tokens, trigger remote processing, or rely on
 * ambient JEV tuning environment variables.
 */

export const JEV_ENV_PREFIXES = ['SIFTR_JEV_', 'JEV_', 'TYPESAFE_'];

export const JEV_SPECIFIC_KEYS = [
  'SIFTR_JEV_REMOTE_PROCESSING',
  'SIFTR_JEV_ENABLED',
  'SIFTR_JEV_MODE',
  'SIFTR_JEV_MAX_CALLS',
  'SIFTR_JEV_MAX_CANDIDATES',
  'SIFTR_JEV_MODEL',
  'SIFTR_JEV_API_KEY',
  'TYPESAFE_API_KEY',
  'JEV_API_KEY',
];

/**
 * Checks if the given environment indicates an integration test execution.
 */
export function isIntegrationTest(env: Record<string, string | undefined> = process.env): boolean {
  return env.INTEGRATION_TEST === 'true' || env.SIFTR_INTEGRATION_TEST === 'true';
}

/**
 * Returns true if the environment key is related to JEV remote processing, credentials, or tuning.
 */
export function isJevEnvKey(key: string): boolean {
  const upper = key.toUpperCase();
  return (
    JEV_SPECIFIC_KEYS.includes(key) ||
    JEV_ENV_PREFIXES.some((prefix) => upper.startsWith(prefix))
  );
}

/**
 * Scrubs all JEV remote processing, API key, and tuning variables from an environment object.
 * When force=true or when isIntegrationTest(env) is false, all matching keys are removed.
 * Returns the scrubbed environment object.
 */
export function scrubJevTestEnvironment<T extends Record<string, string | undefined>>(
  env: T,
  force: boolean = false
): T {
  if (!force && isIntegrationTest(env)) {
    return env;
  }

  for (const key of Object.keys(env)) {
    if (isJevEnvKey(key)) {
      delete env[key];
    }
  }

  return env;
}
