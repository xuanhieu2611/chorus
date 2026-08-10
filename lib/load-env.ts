import { existsSync } from 'node:fs';

/**
 * Loads `.env.local` for processes Next.js does not boot.
 *
 * The Next.js app reads `.env.local` on its own; the worker and the scripts in
 * `scripts/` are plain Node processes and do not. Import this first, before any
 * module that reads `process.env`.
 *
 * `process.loadEnvFile` is built into Node 21.7+, so this needs no dependency.
 * Real environment variables already set are left alone.
 */
export function loadEnv(path = '.env.local'): void {
  if (existsSync(path)) process.loadEnvFile(path);
}
