import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let cached = null;

/**
 * Single source of truth for the release label (P2-9).
 *
 * `VERSION` at the repository root is the canonical value; `APP_RELEASE`
 * overrides it for container builds that stamp a label at deploy time. The
 * result is cached because it cannot change while the process runs.
 */
export function appVersion() {
  if (cached !== null) return cached;
  const override = String(process.env.APP_RELEASE || '').trim();
  if (override) {
    cached = override;
    return cached;
  }
  try {
    cached = readFileSync(path.join(__dirname, '../../../VERSION'), 'utf8').trim();
  } catch {
    cached = 'dev';
  }
  return cached;
}
