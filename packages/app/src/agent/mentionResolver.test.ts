/**
 * mentionResolver tests. SQL itself runs against the real DB at runtime; here
 * we mock getDb (same pattern as skills/metrics.test.ts) with a dispatcher
 * keyed on SQL substrings and assert the TypeScript behaviour:
 *   - parseMentions: grammar (quoted/bare), cap at 3, kind extraction.
 *   - resolveMentionBlock: '' fast-path, chat transcript condensation
 *     (reversal + clipping), memory expansion, unresolved-NOTE fallback,
 *     and that DB errors degrade to the NOTE instead of throwing.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

interface FakeRows {
  session?: unknown;            // chat_sessions title lookup
  currentProject?: unknown;     // chat_sessions project_id lookup
  messages?: unknown[];         // messages of the referenced chat
  memory?: unknown;             // memory_entities lookup
  throwOnPrepare?: boolean;
}
const { state } = vi.hoisted(() => ({ state: { fake: {} as FakeRows } }));

vi.mock('../db/schema', () => ({
  getDb: () => ({
    prepare: (sql: string) => {
      if (state.fake.throwOnPrepare) throw new Error('db locked');
      return {
        get: () => {
          if (sql.includes('FROM chat_sessions') && sql.includes('title LIKE')) return state.fake.session;
          if (sql.includes('FROM chat_sessions')) return state.fake.currentProject;
          if (sql.includes('FROM memory_entities')) return state.fake.memory;
          return undefined;
        },
        all: () => state.fake.messages ?? [],
      };
    },
  }),
}));

import { parseMentions, resolveMentionBlock } from './mentionResolver';

beforeEach(() => { state.fake = {}; });

describe('parseMentions', () => {
  it('parses quoted and bare tokens with their kinds', () => {
    const got = parseMentions('see @chat:"Budget planning" and @memory:release-date please');
    expect(got).toEqual([
      { kind: 'chat', query: 'Budget planning' },
      { kind: 'memory', query: 'release-date' },
    ]);
  });

  it('caps at 3 references', () => {
    const got = parseMentions('@memory:a @memory:b @memory:c @memory:d');
    expect(got).toHaveLength(3);
    expect(got.map(m => m.query)).toEqual(['a', 'b', 'c']);
  });

  it('ignores plain @tokens that are not chat/memory refs', () => {
    expect(parseMentions('hey @web and @someFolder')).toEqual([]);
  });
});

describe('resolveMentionBlock', () => {
  it('returns the empty string when the message has no mentions', () => {
    expect(resolveMentionBlock('no refs here', 's1')).toBe('');
  });

  it('expands a chat mention into a chronological condensed transcript', () => {
    state.fake.session = { session_id: 's2', title: 'Budget planning' };
    // DB returns DESC (newest first) — the block must read oldest→newest.
    state.fake.messages = [
      { sender_type: 'assistant', content: 'Total is $40k' },
      { sender_type: 'user', content: 'Sum it up' },
    ];
    const block = resolveMentionBlock('@chat:"Budget planning" — what was the total?', 's1');
    expect(block).toContain('[Chat "Budget planning"]');
    expect(block.indexOf('user: Sum it up')).toBeLessThan(block.indexOf('assistant: Total is $40k'));
  });

  it('clips long messages to one line with an ellipsis', () => {
    state.fake.session = { session_id: 's2', title: 'Notes' };
    state.fake.messages = [{ sender_type: 'user', content: `a\n${'x'.repeat(500)}` }];
    const block = resolveMentionBlock('@chat:Notes', 's1');
    expect(block).not.toContain('\nx'); // newline collapsed
    expect(block).toContain('…');
    // 280-char budget + label overhead, never the raw 500.
    expect(block.length).toBeLessThan(500);
  });

  it('expands a memory mention with its content', () => {
    state.fake.memory = { name: 'release-date', content: 'v2 ships March 3' };
    const block = resolveMentionBlock('when again? @memory:release-date', 's1');
    expect(block).toContain('[Memory "release-date"] v2 ships March 3');
  });

  it('injects an explicit NOTE for unresolved references', () => {
    const block = resolveMentionBlock('@chat:"gone forever"', 's1');
    expect(block).toContain('did not match any chat');
    expect(block).toContain('REFERENCED CONTEXT');
  });

  it('degrades to the NOTE (never throws) when the DB errors', () => {
    state.fake.throwOnPrepare = true;
    const block = resolveMentionBlock('@memory:foo', 's1');
    expect(block).toContain('did not match any memory');
  });
});
