import { describe, it, expect } from 'vitest';
import { formatRagResults, formatIndexList, type RagHit } from './ragFormat';

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
