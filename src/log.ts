/**
 * STUB — local copy for standalone typecheck/tests in this port repo.
 * Real implementation lives in upstream nanoclaw at `src/log.ts`.
 */
type LogFn = (msg: string, data?: Record<string, unknown>) => void;
export const log: { debug: LogFn; info: LogFn; warn: LogFn; error: LogFn } = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};
