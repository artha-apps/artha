/**
 * Folder-scoped retrieval tests for the rag tools. When a chat has folders
 * attached, `rag_search` and `rag_list_indexes` must be confined to those
 * folders' indexes (Cowork-style — retrieval stays inside the approved
 * folders); an unscoped chat searches every index.
 *
 * The real retrieval path needs Electron + the DB + Ollama embeddings, so we
 * mock the indexer and DB to assert *which* indexes the tool reaches for.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Spy stand-in for searchAllIndexes — records the (query, topK, indexIds) it's
// called with so we can assert the scoping argument.
const { searchSpy } = vi.hoisted(() => ({ searchSpy: vi.fn() }));
vi.mock('../rag/indexer', () => ({ searchAllIndexes: searchSpy }));

// Fake DB that records the SQL + bound args of the last prepared query.
const { dbState } = vi.hoisted(() => ({ dbState: { sql: '', args: [] as unknown[], rows: [] as unknown[] } }));
vi.mock('../db/schema', () => ({
  getDb: () => ({
    prepare: (sql: string) => ({
      all: (...args: unknown[]) => { dbState.sql = sql; dbState.args = args; return dbState.rows; },
    }),
  }),
}));

import { invokeRagTool } from './rag';

beforeEach(() => {
  searchSpy.mockReset();
  searchSpy.mockResolvedValue([]);
  dbState.sql = '';
  dbState.args = [];
  dbState.rows = [];
});

describe('rag_search scoping', () => {
  it('confines retrieval to the chat folders\' indexes when scoped', async () => {
    await invokeRagTool('rag_search', { query: 'invoices' }, ['idxA', 'idxB']);
    expect(searchSpy).toHaveBeenCalledWith('invoices', 6, ['idxA', 'idxB']);
  });

  it('searches every index (null) for an unscoped chat', async () => {
    await invokeRagTool('rag_search', { query: 'invoices', top_k: 3 }, null);
    expect(searchSpy).toHaveBeenCalledWith('invoices', 3, null);
  });

  it('treats an empty scope list as unscoped (search all)', async () => {
    await invokeRagTool('rag_search', { query: 'invoices' }, []);
    expect(searchSpy).toHaveBeenLastCalledWith('invoices', 6, null);
  });

  it('clamps top_k into [1,20]', async () => {
    await invokeRagTool('rag_search', { query: 'x', top_k: 999 }, null);
    expect(searchSpy).toHaveBeenCalledWith('x', 20, null);
  });
});

describe('rag_list_indexes scoping', () => {
  it('lists only the chat folders\' indexes when scoped', async () => {
    dbState.rows = [{ name: 'Folder: Reports', doc_count: 12 }];
    const out = await invokeRagTool('rag_list_indexes', {}, ['idxA', 'idxB']);
    expect(dbState.sql).toMatch(/WHERE index_id IN \(\?,\?\)/);
    expect(dbState.args).toEqual(['idxA', 'idxB']);
    expect(out).toContain('Folder: Reports (12 chunks)');
  });

  it('lists every index for an unscoped chat', async () => {
    dbState.rows = [{ name: 'Notes', doc_count: 4 }];
    await invokeRagTool('rag_list_indexes', {}, null);
    expect(dbState.sql).not.toMatch(/IN \(/);
  });
});
