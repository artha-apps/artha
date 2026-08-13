/**
 * Unit tests for the pure formatting helpers in ragFormat.ts. No mocking
 * needed — just inputs and expected output strings.
 *
 * Verifies:
 *   - formatRagResults: actionable message on zero hits (no hallucination bait)
 *   - formatRagResults: hit list includes basename, relevance score, and snippet
 *   - formatRagResults: internal whitespace in snippets is collapsed
 *   - formatRagResults: long text is truncated to SNIPPET_CHARS
 *   - formatIndexList: actionable message on empty index list
 *   - formatIndexList: index names and chunk counts are rendered
 */
import { describe, it, expect } from 'vitest';
import { formatRagResults, formatIndexList, type RagHit } from './ragFormat';

// ── formatRagResults ──────────────────────────────────────────────────────────
describe('formatRagResults', () => {
  it('returns an actionable message when there are no hits', () => {
    const out = formatRagResults('quarterly goals', []);
    expect(out).toMatch(/no matching passages/i);
    expect(out).toContain('quarterly goals');
  });

  it('lists hits with basename, relevance, and a snippet', () => {
    const hits: RagHit[] = [
      { filePath: '/home/u/notes/plan.md', text: 'Ship v1 in Q3 and start the beta program.', score: 0.873 },
      { filePath: '/home/u/notes/budget.csv', text: 'line1\n  line2   spaced', score: 0.41 },
    ];
    const out = formatRagResults('plan', hits);
    expect(out).toContain('Found 2 passage(s) for "plan"');
    expect(out).toContain('[plan.md]');
    expect(out).toContain('relevance 0.87');
    expect(out).toContain('[budget.csv]');
    // whitespace in snippet is collapsed
    expect(out).toContain('line1 line2 spaced');
  });

  it('truncates long snippets', () => {
    const long = 'x'.repeat(500);
    const out = formatRagResults('q', [{ filePath: '/a/b.txt', text: long, score: 1 }]);
    expect(out).not.toContain('x'.repeat(400));
  });
});

// ── formatIndexList ───────────────────────────────────────────────────────────
describe('formatIndexList', () => {
  it('handles the empty case', () => {
    expect(formatIndexList([])).toMatch(/no rag indexes/i);
  });
  it('lists index names and counts', () => {
    const out = formatIndexList([{ name: 'Notes', doc_count: 12 }, { name: 'Docs', doc_count: 3 }]);
    expect(out).toContain('- Notes (12 chunks)');
    expect(out).toContain('- Docs (3 chunks)');
  });
});

describe('formatRagResults — degraded retriever honesty (review M2)', () => {
  it('says the files could NOT be searched when semantic retrieval is unavailable', () => {
    const out = formatRagResults('tax rules', [], true);
    expect(out).toMatch(/could NOT be searched/i);
    expect(out).toMatch(/not a statement about their contents/i);
    expect(out).not.toMatch(/No matching passages/i);   // never a content claim
  });

  it('keeps the ordinary no-match message when the retriever DID run', () => {
    const out = formatRagResults('tax rules', [], false);
    expect(out).toMatch(/No matching passages/i);
  });
});

describe('formatRagResults — embedder-mismatch honesty (Slice 2c, D-B3)', () => {
  const hit = { filePath: '/x/notes.md', text: 'Revenue rose in Q3.', score: 0.91 };
  const mm = [{ index: 'Old Docs', reason: 'This index was built with nomic-embed-text (768-dim) but the active embedder is text-embedding-3-small (1536-dim). Re-index to search it.' }];

  it('names the unsearchable index alongside real hits', () => {
    const out = formatRagResults('revenue', [hit], false, mm);
    expect(out).toContain('[notes.md]');
    expect(out).toContain('"Old Docs"');
    expect(out).toMatch(/could NOT be searched/i);
  });

  it('never claims "no matches" when the only indexes were unsearchable', () => {
    const out = formatRagResults('revenue', [], false, mm);
    expect(out).not.toMatch(/No matching passages/i);
    expect(out).toMatch(/could NOT be searched/i);
    expect(out).toMatch(/not a statement about their contents/i);
    expect(out).toContain('"Old Docs"');
  });
});
