/**
 * Proactive briefing — an opt-in digest of what happened since the user last
 * looked. Aggregates local activity (runs, file changes, new artifacts/memory/
 * CRM contacts) since `lastBriefingAt`. Strictly opt-in (off by default) to
 * respect the privacy-first audience; nothing here leaves the device.
 *
 * Every count is wrapped so a missing table/column (the schema is evolving)
 * degrades to 0 rather than throwing — a briefing must never break boot.
 */
import { getDb } from '../db/schema';

export interface Briefing {
  /** Window start, unix seconds. */
  since: number;
  runs: number;
  failedRuns: number;
  filesChanged: number;
  newArtifacts: number;
  newMemories: number;
  newContacts: number;
  /** True when there's anything worth surfacing. */
  hasActivity: boolean;
}

function count(sql: string, ...params: unknown[]): number {
  try {
    const row = getDb().prepare(sql).get(...params) as { n: number } | undefined;
    return row?.n ?? 0;
  } catch {
    return 0;
  }
}

function readSettings(): Record<string, unknown> {
  try {
    const row = getDb().prepare(`SELECT settings_json FROM users WHERE user_id='default'`).get() as { settings_json: string } | undefined;
    return JSON.parse(row?.settings_json ?? '{}');
  } catch {
    return {};
  }
}

/** Aggregate activity since the last seen briefing (or the last 24h on first run). */
export function getBriefing(): Briefing {
  const now = Math.floor(Date.now() / 1000);
  const last = readSettings().lastBriefingAt;
  const since = typeof last === 'number' ? last : now - 24 * 3600;

  const runs = count(`SELECT COUNT(*) AS n FROM agent_runs WHERE created_at >= ?`, since);
  const failedRuns = count(`SELECT COUNT(*) AS n FROM agent_runs WHERE created_at >= ? AND status='failed'`, since);
  const filesChanged = count(
    `SELECT COUNT(*) AS n FROM tool_receipts tr JOIN agent_runs ar ON ar.run_id = tr.run_id
      WHERE ar.created_at >= ? AND tr.is_mutation = 1 AND tr.status = 'ok'`, since);
  const newArtifacts = count(`SELECT COUNT(*) AS n FROM artifacts WHERE created_at >= ?`, since);
  const newMemories = count(`SELECT COUNT(*) AS n FROM memory_entities WHERE created_at >= ?`, since);
  const newContacts = count(`SELECT COUNT(*) AS n FROM crm_contacts WHERE created_at >= ?`, since);

  return {
    since,
    runs, failedRuns, filesChanged, newArtifacts, newMemories, newContacts,
    hasActivity: runs + newArtifacts + newMemories + newContacts > 0,
  };
}

/** Stamp "seen now" so the next briefing only covers activity after this point. */
export function markBriefingSeen(): void {
  try {
    const db = getDb();
    const existing = JSON.parse(
      (db.prepare(`SELECT settings_json FROM users WHERE user_id='default'`).get() as { settings_json: string })?.settings_json ?? '{}',
    );
    existing.lastBriefingAt = Math.floor(Date.now() / 1000);
    db.prepare(`UPDATE users SET settings_json=? WHERE user_id='default'`).run(JSON.stringify(existing));
  } catch {
    /* non-fatal */
  }
}
