/**
 * LAN privacy + seat-cap tests (WS1 security fixes).
 *
 * The leaks these guard against: LAN teammate runs receiving the host's
 * PRIVATE memories through (a) the LONG-TERM MEMORY recency preamble
 * (tools/memory.ts getMemoryContext) and (b) a context pack's pinned
 * memories (agent/contextPacks.ts getPackContextBlock). Both must append
 * `AND is_shared=1` iff the run carries lan:true in its runContext.
 *
 * getDb is mocked (metrics.test.ts pattern) with a SQL capture; runContext is
 * REAL — AsyncLocalStorage works fine under vitest, so we enter contexts via
 * runWithContext exactly like the LAN server does.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { state } = vi.hoisted(() => ({
  state: {
    sqls: [] as string[],
    memoryRows: [] as unknown[],
    packRow: undefined as unknown,
    counts: { members: 0, unboundKeys: 0 },
  },
}));

vi.mock('../db/schema', () => ({
  getDb: () => ({
    prepare: (sql: string) => {
      state.sqls.push(sql);
      return {
        all: () => state.memoryRows,
        get: () => {
          if (sql.includes('FROM team_members')) return { n: state.counts.members };
          if (sql.includes('FROM api_keys')) return { n: state.counts.unboundKeys };
          if (sql.includes('LEFT JOIN context_packs')) return state.packRow;
          return undefined;
        },
        run: () => ({ changes: 1 }),
      };
    },
  }),
}));

import { getMemoryContext } from '../tools/memory';
import { getPackContextBlock } from '../agent/contextPacks';
import { runWithContext } from '../agent/runContext';
import { usedSeats } from './seats';

beforeEach(() => {
  state.sqls = [];
  state.memoryRows = [];
  state.packRow = undefined;
  state.counts = { members: 0, unboundKeys: 0 };
});

/** The last memory_entities SELECT captured. */
function lastMemorySql(): string {
  return [...state.sqls].reverse().find(s => s.includes('FROM memory_entities')) ?? '';
}

describe('getMemoryContext LAN filter', () => {
  it('local run (no runContext): no is_shared filter, both branches', () => {
    getMemoryContext(null);
    expect(lastMemorySql()).not.toContain('is_shared');
    getMemoryContext('proj-1');
    expect(lastMemorySql()).not.toContain('is_shared');
  });

  it('lan:false run: no filter', async () => {
    await runWithContext({ actor: 'local', lan: false }, async () => { getMemoryContext(null); });
    expect(lastMemorySql()).not.toContain('is_shared');
  });

  it('lan:true run: shared-only, on BOTH project branches', async () => {
    await runWithContext({ actor: 'teammate', lan: true }, async () => { getMemoryContext(null); });
    expect(lastMemorySql()).toContain('AND is_shared=1');

    await runWithContext({ actor: 'teammate', lan: true }, async () => { getMemoryContext('proj-1'); });
    const sql = lastMemorySql();
    expect(sql).toContain('AND is_shared=1');
    // The filter must bind to BOTH arms of the project_id OR — parenthesised.
    expect(sql).toContain('(project_id IS NULL OR project_id = ?)');
  });
});

describe('getPackContextBlock LAN filter', () => {
  const pack = {
    pack_id: 'pk1', name: 'Deal room', scopes_json: '[]',
    skill_id: null, memory_ids_json: JSON.stringify(['m1', 'm2']), created_at: 1,
  };

  it('local run: pins selected without is_shared', () => {
    state.packRow = pack;
    state.memoryRows = [{ name: 'a', content: 'b' }];
    getPackContextBlock('s1');
    expect(lastMemorySql()).not.toContain('is_shared');
  });

  it('lan:true run: only shared pins are injectable', async () => {
    state.packRow = pack;
    state.memoryRows = [{ name: 'a', content: 'b' }];
    await runWithContext({ actor: 'teammate', lan: true }, async () => { getPackContextBlock('s1'); });
    expect(lastMemorySql()).toContain('AND is_shared=1');
  });
});

describe('usedSeats union', () => {
  it('members + unbound enabled keys, bound keys share the member seat', () => {
    state.counts = { members: 2, unboundKeys: 0 }; // 2 members each with a bound key
    expect(usedSeats()).toBe(2);
    state.counts = { members: 2, unboundKeys: 3 };
    expect(usedSeats()).toBe(5);
    state.counts = { members: 0, unboundKeys: 1 };
    expect(usedSeats()).toBe(1);
  });

  it('the api_keys count only considers enabled unbound keys (SQL shape)', () => {
    state.counts = { members: 0, unboundKeys: 0 };
    usedSeats();
    const keySql = state.sqls.find(s => s.includes('FROM api_keys')) ?? '';
    expect(keySql).toContain('is_enabled=1');
    expect(keySql).toContain('member_id IS NULL');
  });
});
