/**
 * Context Packs — named, reusable context sets (scopes + skill + pinned
 * memories) a user can save from one chat and apply to any other.
 *
 * Semantics:
 *   - SCOPES copy PHYSICALLY on apply (rows in session_scopes, folders routed
 *     through findOrCreateFolderWorkspace for live RAG index ids). Editing the
 *     pack later does not retro-edit chats that already applied it.
 *   - SKILL and PINNED MEMORIES inject BY REFERENCE at run time through
 *     chat_sessions.context_pack_id — pack edits propagate, and a deleted
 *     skill/memory simply drops out (LEFT-JOIN/IN-list degrade, never throws).
 *   - Applying a second pack MERGES scopes (UNIQUE-skips) and the NEW pack
 *     wins for skill/memories (context_pack_id is single-valued).
 */
import { getDb } from '../db/schema';
import {
  findOrCreateFolderWorkspace,
  getSessionScopes,
  recomputePrimaryProject,
} from '../db/scopes';
import * as crypto from 'crypto';
import * as fs from 'fs';

/** DB row of a pack, with parsed convenience fields. */
export interface ContextPack {
  pack_id: string;
  name: string;
  scopes_json: string;
  skill_id: string | null;
  memory_ids_json: string;
  created_at: number;
}

/** One scope entry as stored in scopes_json. */
interface PackScope {
  path: string;
  kind: 'folder' | 'file';
}

function parseScopes(json: string): PackScope[] {
  try {
    const parsed = JSON.parse(json) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((s): s is PackScope =>
      !!s && typeof (s as PackScope).path === 'string' &&
      ((s as PackScope).kind === 'folder' || (s as PackScope).kind === 'file'));
  } catch { return []; }
}

function parseMemoryIds(json: string): string[] {
  try {
    const parsed = JSON.parse(json) as unknown;
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch { return []; }
}

export function listPacks(): ContextPack[] {
  return getDb().prepare(`SELECT * FROM context_packs ORDER BY created_at DESC`).all() as ContextPack[];
}

/**
 * Snapshot a session's context into a new named pack.
 * Defaults (both overridable by the save dialog):
 *   - skill: the session's most recent skill_runs row — "the skill this chat
 *     actually used" beats asking the user to remember its id.
 *   - memories: the session's project pins (memory_entities.project_id).
 */
export function savePackFromSession(
  sessionId: string,
  name: string,
  overrides: { skillId?: string | null; memoryIds?: string[] } = {},
): ContextPack {
  const db = getDb();
  const scopes: PackScope[] = getSessionScopes(sessionId).map(s => ({ path: s.path, kind: s.kind }));

  let skillId = overrides.skillId;
  if (skillId === undefined) {
    const run = db.prepare(
      `SELECT skill_id FROM skill_runs WHERE session_id=? ORDER BY created_at DESC LIMIT 1`
    ).get(sessionId) as { skill_id: string } | undefined;
    skillId = run?.skill_id ?? null;
  }

  let memoryIds = overrides.memoryIds;
  if (memoryIds === undefined) {
    const proj = db.prepare(`SELECT project_id FROM chat_sessions WHERE session_id=?`)
      .get(sessionId) as { project_id: string | null } | undefined;
    memoryIds = proj?.project_id
      ? (db.prepare(`SELECT entity_id FROM memory_entities WHERE project_id=?`)
          .all(proj.project_id) as { entity_id: string }[]).map(r => r.entity_id)
      : [];
  }

  const packId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO context_packs (pack_id, name, scopes_json, skill_id, memory_ids_json) VALUES (?,?,?,?,?)`
  ).run(packId, name.trim() || 'Untitled pack', JSON.stringify(scopes), skillId, JSON.stringify(memoryIds));
  return db.prepare(`SELECT * FROM context_packs WHERE pack_id=?`).get(packId) as ContextPack;
}

/**
 * Apply a pack to a session: copy scopes in, stamp context_pack_id. Returns
 * human-readable warnings for anything that no longer resolves (missing paths,
 * deleted skill/memories) — the UI surfaces them, the run tolerates them.
 */
export function applyPackToSession(packId: string, sessionId: string): { warnings: string[] } {
  const db = getDb();
  const pack = db.prepare(`SELECT * FROM context_packs WHERE pack_id=?`).get(packId) as ContextPack | undefined;
  if (!pack) return { warnings: ['Pack no longer exists.'] };

  const warnings: string[] = [];

  for (const s of parseScopes(pack.scopes_json)) {
    if (!fs.existsSync(s.path)) {
      warnings.push(`Path missing on disk: ${s.path}`);
      // Still attach — consistent with existing scope behaviour (stale paths
      // are tolerated; the sandbox tools handle missing dirs gracefully).
    }
    const scopeId = crypto.randomUUID();
    try {
      if (s.kind === 'folder') {
        const { ragIndexId } = findOrCreateFolderWorkspace(s.path);
        db.prepare(`INSERT INTO session_scopes (scope_id, session_id, path, kind, rag_index_id) VALUES (?,?,?,?,?)`)
          .run(scopeId, sessionId, s.path, 'folder', ragIndexId);
      } else {
        db.prepare(`INSERT INTO session_scopes (scope_id, session_id, path, kind) VALUES (?,?,?,?)`)
          .run(scopeId, sessionId, s.path, 'file');
      }
    } catch { /* UNIQUE(session_id, path) — already attached */ }
  }
  recomputePrimaryProject(sessionId);

  if (pack.skill_id) {
    const skill = db.prepare(`SELECT is_enabled FROM skills WHERE skill_id=?`)
      .get(pack.skill_id) as { is_enabled: number } | undefined;
    if (!skill) warnings.push('The pack’s skill was deleted — it will be skipped.');
    else if (!skill.is_enabled) warnings.push('The pack’s skill is disabled — it will be skipped.');
  }
  const missingMemories = parseMemoryIds(pack.memory_ids_json).filter(id =>
    !db.prepare(`SELECT 1 FROM memory_entities WHERE entity_id=?`).get(id));
  if (missingMemories.length) {
    warnings.push(`${missingMemories.length} pinned memor${missingMemories.length === 1 ? 'y' : 'ies'} no longer exist${missingMemories.length === 1 ? 's' : ''} — skipped.`);
  }

  db.prepare(`UPDATE chat_sessions SET context_pack_id=? WHERE session_id=?`).run(packId, sessionId);
  return { warnings };
}

/** The pack applied to a session (null if none / pack deleted). */
export function getPackForSession(sessionId: string): ContextPack | null {
  const row = getDb().prepare(
    `SELECT p.* FROM chat_sessions s
     LEFT JOIN context_packs p ON p.pack_id = s.context_pack_id
     WHERE s.session_id=?`
  ).get(sessionId) as ContextPack | { pack_id: null } | undefined;
  return row && row.pack_id ? (row as ContextPack) : null;
}

/** Detach the pack from a session. Copied scopes stay (they're the user's
 *  working set now); only the by-reference skill/memory injection stops. */
export function detachPackFromSession(sessionId: string): void {
  getDb().prepare(`UPDATE chat_sessions SET context_pack_id=NULL WHERE session_id=?`).run(sessionId);
}

/** Delete a pack. Sessions that applied it keep their copied scopes; their
 *  context_pack_id dangles harmlessly (getPackForSession LEFT-JOINs to null). */
export function deletePack(packId: string): void {
  getDb().prepare(`DELETE FROM context_packs WHERE pack_id=?`).run(packId);
}

/**
 * Run-time injection for the orchestrator: the pinned-memory block from the
 * session's pack, or '' when no pack / nothing resolves. Deleted memory ids
 * drop out of the IN-list naturally. Never throws.
 */
export function getPackContextBlock(sessionId: string): string {
  try {
    const pack = getPackForSession(sessionId);
    if (!pack) return '';
    const ids = parseMemoryIds(pack.memory_ids_json);
    if (ids.length === 0) return '';
    const placeholders = ids.map(() => '?').join(',');
    const rows = getDb().prepare(
      `SELECT name, content FROM memory_entities WHERE entity_id IN (${placeholders}) ORDER BY updated_at DESC`
    ).all(...ids) as { name: string; content: string }[];
    if (rows.length === 0) return '';
    const lines = rows.map(r => `- ${r.name}: ${r.content}`).join('\n');
    return `PINNED CONTEXT (from pack "${pack.name}"):\n${lines}\n\n`;
  } catch {
    return '';
  }
}

/** The pack's skill id for a session, if the pack pins one and it's enabled.
 *  Used by the orchestrator's skill precedence chain. Never throws. */
export function getPackSkillId(sessionId: string): string | null {
  try {
    const pack = getPackForSession(sessionId);
    return pack?.skill_id ?? null;
  } catch {
    return null;
  }
}
