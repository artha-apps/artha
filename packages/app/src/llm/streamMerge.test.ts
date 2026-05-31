/**
 * Tests for the stream-merge helpers that reassemble OpenAI streaming
 * tool-call deltas into complete tool-call objects. Covers:
 *   applyToolCallDeltas — incremental accumulation of id/name/arguments
 *   toToolCalls         — final conversion to ChatCompletionMessageToolCall
 *                         objects, including id synthesis and argument defaulting
 */
import { describe, it, expect } from 'vitest';
import { applyToolCallDeltas, toToolCalls, type PartialToolCall } from './streamMerge';

// ── applyToolCallDeltas ───────────────────────────────────────────────────────

describe('applyToolCallDeltas', () => {
  // Simulates three successive SSE chunks: first carries id+name, the next two
  // carry the argument JSON split across chunk boundaries.
  it('assembles a single tool call across multiple chunks', () => {
    let acc: PartialToolCall[] = [];
    acc = applyToolCallDeltas(acc, [{ index: 0, id: 'call_1', function: { name: 'fs_list_directory' } }]);
    acc = applyToolCallDeltas(acc, [{ index: 0, function: { arguments: '{"path":' } }]);
    acc = applyToolCallDeltas(acc, [{ index: 0, function: { arguments: '"~/Desktop"}' } }]);
    expect(acc[0]).toEqual({ id: 'call_1', name: 'fs_list_directory', arguments: '{"path":"~/Desktop"}' });
  });

  // OpenAI can emit multiple tool calls in parallel; each has its own index.
  it('handles two parallel tool calls by index', () => {
    let acc: PartialToolCall[] = [];
    acc = applyToolCallDeltas(acc, [
      { index: 0, id: 'a', function: { name: 'web_search', arguments: '{"q":"x"}' } },
      { index: 1, id: 'b', function: { name: 'web_fetch' } },
    ]);
    acc = applyToolCallDeltas(acc, [{ index: 1, function: { arguments: '{"url":"y"}' } }]);
    expect(acc).toHaveLength(2);
    expect(acc[1]).toEqual({ id: 'b', name: 'web_fetch', arguments: '{"url":"y"}' });
  });
});

// ── toToolCalls ───────────────────────────────────────────────────────────────

describe('toToolCalls', () => {
  // Nameless partials are stray/orphaned deltas; they must be silently dropped.
  it('converts partials and drops nameless entries', () => {
    const calls = toToolCalls([
      { id: 'call_1', name: 'web_search', arguments: '{"q":"x"}' },
      { id: '', name: '', arguments: 'orphan' },
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ id: 'call_1', type: 'function', function: { name: 'web_search', arguments: '{"q":"x"}' } });
  });

  // Some models omit the id field — ensure a stable synthetic id is generated.
  it('synthesises an id when missing and defaults empty arguments to {}', () => {
    const calls = toToolCalls([{ id: '', name: 'fs_list_directory', arguments: '' }]);
    expect(calls[0].function.arguments).toBe('{}');
    expect(calls[0].id).toMatch(/^call_/);
  });
});
