/**
 * Context Packs tests. Same mocked-getDb pattern as skills/metrics.test.ts —
 * SQL runs against the real DB at runtime; here we dispatch on SQL substrings
 * and assert the TypeScript behaviour:
 *   - savePackFromSession: skill/memory defaults derived from the session,
 *     overrides win, name fallback.
 *   - applyPackToSession: warnings for missing pack/paths/skill/memories,
 *     UNIQUE-skip on duplicate scopes, context_pack_id stamped.
 *   - getPackContextBlock: PINNED CONTEXT rendering, '' fast-paths, never throws.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

interface FakeDb {
  packRow?: unknown;              // context_packs SELECT (single)
  packsRows?: unknown[];          // context_packs SELECT (list)
  skillRun?: unknown;             // skill_runs latest
  sessionProject?: unknown;       // chat_sessions project_id
  projectMemories?: unknown[];    // memory_entities by project
  skillRow?: unknown;             // skills lookup
  memoryExists?: boolean;         // memory_entities existence probe
  memoryRows?: unknown[];         // memory_entities IN (...) fetch
  packSession?: unknown;          // LEFT JOIN pack-for-session
  sqls: string[];                 // every prepared SQL, for shape assertions
  runs: Array<{ sql: string; args: unknown[] }>;
  throwOnScopeInsert?: boolean;
}
const { state } = vi.hoisted(() => ({ state: { db: { runs: [], sqls: [] } as FakeDb } }));

vi.mock('../db/schema', () => ({
  getDb: () => ({
    prepare: (sql: string) => ({
      ...(state.db.sqls.push(sql), {}),
      get: (..._args: unknown[]) => {
        if (sql.includes('LEFT JOIN context_packs')) return state.db.packSession;
        if (sql.includes('FROM context_packs')) return state.db.packRow;
        if (sql.includes('FROM skill_runs')) return state.db.skillRun;
        if (sql.includes('FROM chat_sessions')) return state.db.sessionProject;
        if (sql.includes('FROM skills')) return state.db.skillRow;
        if (sql.includes('SELECT 1 FROM memory_entities')) {
          return state.db.memoryExists ? { 1: 1 } : undefined;
        }
        return undefined;
      },
      all: (..._args: unknown[]) => {
        if (sql.includes('FROM memory_entities') && sql.includes('IN (')) return state.db.memoryRows ?? [];
        if (sql.includes('FROM memory_entities')) return state.db.projectMemories ?? [];
        if (sql.includes('FROM context_packs')) return state.db.packsRows ?? [];
        return [];
      },
      run: (...args: unknown[]) => {
        if (state.db.throwOnScopeInsert && sql.includes('INSERT INTO session_scopes')) {
          throw new Error('UNIQUE constraint failed');
        }
        state.db.runs.push({ sql, args });
        return { changes: 1 };
      },
    }),
  }),
}));

vi.mock('../db/scopes', () => ({
  findOrCreateFolderWorkspace: (p: string) => ({ projectId: `proj-${p}`, ragIndexId: `rag-${p}` }),
  getSessionScopes: () => [
    { scope_id: 'sc1', session_id: 's1', path: '/tmp/proj', kind: 'folder', rag_index_id: 'rag1', added_at: 1 },
    { scope_id: 'sc2', session_id: 's1', path: '/tmp/notes.md', kind: 'file', rag_index_id: null, added_at: 2 },
  ],
  recomputePrimaryProject: vi.fn(),
}));

vi.mock('fs', () => ({ existsSync: (p: string) => !String(p).includes('missing') }));

import {
  savePackFromSession, applyPackToSession, getPackContextBlock, getPackSkillId,
  setPackShared, listSharedPacks, describeSharedPacks,
} from './contextPacks';

beforeEach(() => { state.db = { runs: [], sqls: [] }; });

describe('savePackFromSession', () => {
  it('snapshots scopes and derives skill + memory defaults from the session', () => {
    state.db.skillRun = { skill_id: 'sk9' };
    state.db.sessionProject = { project_id: 'p1' };
    state.db.projectMemories = [{ entity_id: 'm1' }, { entity_id: 'm2' }];
    state.db.packRow = { pack_id: 'pk1', name: 'My pack' };

    savePackFromSession('s1', 'My pack');

    const insert = state.db.runs.find(r => r.sql.includes('INSERT INTO context_packs'));
    expect(insert).toBeDefined();
    const [, name, scopesJson, skillId, memJson] = insert!.args as [string, string, string, string, string];
    expect(name).toBe('My pack');
    expect(JSON.parse(scopesJson)).toEqual([
      { path: '/tmp/proj', kind: 'folder' },
      { path: '/tmp/notes.md', kind: 'file' },
    ]);
    expect(skillId).toBe('sk9');
    expect(JSON.parse(memJson)).toEqual(['m1', 'm2']);
  });

  it('lets overrides beat the derived defaults and falls back on a blank name', () => {
    state.db.skillRun = { skill_id: 'sk9' };
    state.db.packRow = { pack_id: 'pk1', name: 'Untitled pack' };

    savePackFromSession('s1', '   ', { skillId: null, memoryIds: ['only-this'] });

    const insert = state.db.runs.find(r => r.sql.includes('INSERT INTO context_packs'));
    const [, name, , skillId, memJson] = insert!.args as [string, string, string, string | null, string];
    expect(name).toBe('Untitled pack');
    expect(skillId).toBeNull();
    expect(JSON.parse(memJson)).toEqual(['only-this']);
  });
});

describe('applyPackToSession', () => {
  const basePack = {
    pack_id: 'pk1', name: 'Deal room',
    scopes_json: JSON.stringify([{ path: '/tmp/proj', kind: 'folder' }, { path: '/tmp/missing.md', kind: 'file' }]),
    skill_id: 'sk1', memory_ids_json: JSON.stringify(['m1']), created_at: 1,
  };

  it('warns when the pack no longer exists', () => {
    expect(applyPackToSession('gone', 's1').warnings).toEqual(['Pack no longer exists.']);
  });

  it('copies scopes, stamps context_pack_id, and reports missing paths/skill/memories', () => {
    state.db.packRow = basePack;
    state.db.skillRow = undefined;          // skill deleted
    state.db.memoryExists = false;          // memory m1 gone

    const { warnings } = applyPackToSession('pk1', 's1');

    // Folder went through the workspace helper (live rag id), file inserted raw.
    const scopeInserts = state.db.runs.filter(r => r.sql.includes('INSERT INTO session_scopes'));
    expect(scopeInserts).toHaveLength(2);
    expect(scopeInserts[0].args).toContain('rag-/tmp/proj');
    // Pack stamped on the session.
    const stamp = state.db.runs.find(r => r.sql.includes('SET context_pack_id=?'));
    expect(stamp?.args).toEqual(['pk1', 's1']);
    // All three degradations surfaced.
    expect(warnings.some(w => w.includes('missing on disk'))).toBe(true);
    expect(warnings.some(w => w.includes('skill was deleted'))).toBe(true);
    expect(warnings.some(w => w.includes('no longer exist'))).toBe(true);
  });

  it('swallows UNIQUE violations so re-applying merges instead of failing', () => {
    state.db.packRow = { ...basePack, skill_id: null, memory_ids_json: '[]' };
    state.db.throwOnScopeInsert = true;
    const { warnings } = applyPackToSession('pk1', 's1');
    // Only the missing-path warning — the UNIQUE throws never surface.
    expect(warnings).toHaveLength(1);
  });
});

describe('run-time injection', () => {
  it('renders the PINNED CONTEXT block from the pack’s memories', () => {
    state.db.packSession = {
      pack_id: 'pk1', name: 'Deal room',
      scopes_json: '[]', skill_id: null,
      memory_ids_json: JSON.stringify(['m1']), created_at: 1,
    };
    state.db.memoryRows = [{ name: 'budget', content: 'CA$40k ceiling' }];
    const block = getPackContextBlock('s1');
    expect(block).toContain('PINNED CONTEXT (from pack "Deal room")');
    expect(block).toContain('- budget: CA$40k ceiling');
  });

  it('returns empty for no pack / no ids and the pack skill id when set', () => {
    expect(getPackContextBlock('s1')).toBe('');
    expect(getPackSkillId('s1')).toBeNull();
    state.db.packSession = {
      pack_id: 'pk1', name: 'P', scopes_json: '[]',
      skill_id: 'sk5', memory_ids_json: '[]', created_at: 1,
    };
    expect(getPackContextBlock('s1')).toBe('');
    expect(getPackSkillId('s1')).toBe('sk5');
  });
});

describe('shared packs (LAN)', () => {
  it('setPackShared writes 1/0 and listSharedPacks selects only shared rows', () => {
    setPackShared('pk1', true);
    let update = state.db.runs.find(r => r.sql.includes('SET is_shared'));
    expect(update?.args).toEqual([1, 'pk1']);

    state.db.runs = [];
    setPackShared('pk1', false);
    update = state.db.runs.find(r => r.sql.includes('SET is_shared'));
    expect(update?.args).toEqual([0, 'pk1']);

    listSharedPacks();
    const select = state.db.sqls.find(s => s.includes('FROM context_packs') && s.includes('WHERE'));
    expect(select).toContain('is_shared=1');
  });

  it('describeSharedPacks returns JSON-safe summaries (scopes parsed, has_skill)', () => {
    state.db.packsRows = [{
      pack_id: 'pk9', name: 'Legal room',
      scopes_json: JSON.stringify([{ path: '/hub/contracts', kind: 'folder' }]),
      skill_id: 'sk1', memory_ids_json: '[]', is_shared: 1, created_at: 1,
    }];
    const out = describeSharedPacks();
    expect(out).toEqual([{
      pack_id: 'pk9', name: 'Legal room',
      scopes: [{ path: '/hub/contracts', kind: 'folder' }],
      has_skill: true,
    }]);
  });
});
