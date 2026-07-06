/**
 * Current-license accessors shared by IPC handlers AND tool modules.
 *
 * Moved out of ipc/handlers.ts so non-IPC code (e.g. the docs tool's
 * free-tier document cap) can consult entitlements without importing the
 * Electron-heavy handlers module. Reads the raw key from
 * users.settings_json.license_key; getEntitlements caches by key identity
 * and re-checks expiry on every hit (see ./verify.ts).
 */
import { getDb } from '../db/schema';
import { getEntitlements } from './verify';
import type { Entitlements } from './entitlements';

export function getRawLicenseKey(): string | null {
  try {
    const row = getDb().prepare(`SELECT settings_json FROM users WHERE user_id='default'`).get() as { settings_json: string } | undefined;
    const k = (JSON.parse(row?.settings_json ?? '{}') as { license_key?: string }).license_key;
    return typeof k === 'string' && k ? k : null;
  } catch { return null; }
}

export function currentEntitlements(): Entitlements {
  return getEntitlements(getRawLicenseKey);
}

/** Generated documents so far in the CURRENT CALENDAR MONTH (local time) —
 *  the Free tier's doc cap counts against this. */
export function docsGeneratedThisMonth(): number {
  try {
    const start = new Date();
    start.setDate(1);
    start.setHours(0, 0, 0, 0);
    const startSec = Math.floor(start.getTime() / 1000);
    const row = getDb().prepare(
      `SELECT COUNT(*) AS n FROM generated_documents WHERE created_at >= ?`
    ).get(startSec) as { n: number };
    return row.n;
  } catch {
    return 0; // fail open — a broken counter must not block paying users
  }
}
