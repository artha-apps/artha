import { describe, it, expect } from 'vitest';
import { applyToolCallDeltas, toToolCalls, type PartialToolCall } from './streamMerge';

describe('applyToolCallDeltas', () => {
  it('assembles a single tool call across multiple chunks', () => {
    let acc: PartialToolCall[] = [];
    acc = applyToolCallDeltas(acc, [{ index: 0, id: 'call_1', function: { name: 'fs_list_directory' } }]);
    acc = applyToolCallDeltas(acc, [{ index: 0, function: { arguments: '{"path":' } }]);
    acc = applyToolCallDeltas(acc, [{ index: 0, function: { arguments: '"~/Desktop"}' } }]);
    expect(acc[0]).toEqual({ id: 'call_1', name: 'fs_list_directory', arguments: '{"path":"~/Desktop"}' });
  });

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

describe('toToolCalls', () => {
  it('converts partials and drops nameless entries', () => {
    const calls = toToolCalls([
      { id: 'call_1', name: 'web_search', arguments: '{"q":"x"}' },
      { id: '', name: '', arguments: 'orphan' },
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ id: 'call_1', type: 'function', function: { name: 'web_search', arguments: '{"q":"x"}' } });
  });

  it('synthesises an id when missing and defaults empty arguments to {}', () => {
    const calls = toToolCalls([{ id: '', name: 'fs_list_directory', arguments: '' }]);
    expect(calls[0].function.arguments).toBe('{}');
    expect(calls[0].id).toMatch(/^call_/);
  });
});
