/**
 * STUB — local copy for standalone typecheck/tests in this port repo.
 *
 * Real implementation lives in upstream nanoclaw at `src/env.ts`. This file
 * is NOT installed by the /add-discord skill. Tests vi.mock this module to
 * return controlled env values.
 */
export function readEnvFile(_keys: string[]): Record<string, string> {
  return {};
}
