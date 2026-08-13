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

// ── Provider side-channel preservation (Gemini thought_signature) ────────────

describe('extra_content passthrough (Gemini 3.x thought signatures)', () => {
  it('keeps extra_content from the first delta through reassembly and emission', () => {
    const sig = { google: { thought_signature: 'Er4DCrsD…' } };
    let acc = applyToolCallDeltas([], [
      { index: 0, id: 'call_1', function: { name: 'web_search' }, extra_content: sig },
    ]);
    acc = applyToolCallDeltas(acc, [
      { index: 0, function: { arguments: '{"query":"blogs"}' } }, // later chunks carry no extra_content
    ]);
    const calls = toToolCalls(acc);
    // Gemini 400s the whole follow-up turn if this is not echoed back verbatim.
    expect((calls[0] as unknown as { extra_content?: unknown }).extra_content).toEqual(sig);
    expect(calls[0].function.arguments).toBe('{"query":"blogs"}');
  });

  it('emits no extra_content key for providers that never sent one', () => {
    const calls = toToolCalls([{ id: 'call_1', name: 'fs_read', arguments: '{}' }]);
    expect('extra_content' in calls[0]).toBe(false);
  });
});

describe('id-keyed deltas without index (Gemini parallel tool calls)', () => {
  it('keeps two complete id-keyed calls separate instead of fusing into slot 0', () => {
    // Gemini's compat stream: each parallel call arrives as ONE complete delta
    // with an id and NO index. Pre-fix these fused into "namename" + two JSON
    // bodies concatenated, which broke tool dispatch entirely.
    let acc = applyToolCallDeltas([], [
      { id: 'call_a', function: { name: 'get_weather', arguments: '{"city":"Paris"}' } },
    ]);
    acc = applyToolCallDeltas(acc, [
      { id: 'call_b', function: { name: 'get_weather', arguments: '{"city":"London"}' } },
    ]);
    const calls = toToolCalls(acc);
    expect(calls).toHaveLength(2);
    expect(calls.map(c => c.function.arguments)).toEqual(['{"city":"Paris"}', '{"city":"London"}']);
    expect(calls.every(c => c.function.name === 'get_weather')).toBe(true);
  });

  it('routes a repeated id back to its own slot', () => {
    let acc = applyToolCallDeltas([], [
      { id: 'call_a', function: { name: 'search', arguments: '{"q":' } },
      { id: 'call_b', function: { name: 'read', arguments: '{}' } },
    ]);
    acc = applyToolCallDeltas(acc, [{ id: 'call_a', function: { arguments: '"x"}' } }]);
    const calls = toToolCalls(acc);
    expect(calls[0].function.arguments).toBe('{"q":"x"}');
    expect(calls[1].function.arguments).toBe('{}');
  });

  it('appends bare argument fragments (no index, no id) to the last slot', () => {
    let acc = applyToolCallDeltas([], [{ id: 'call_a', function: { name: 'search', arguments: '{"q":' } }]);
    acc = applyToolCallDeltas(acc, [{ function: { arguments: '"y"}' } }]);
    expect(toToolCalls(acc)[0].function.arguments).toBe('{"q":"y"}');
  });
});
