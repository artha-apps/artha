/**
 * Tool-outcome classification tests.
 *
 * The audit's #1 finding: the app's only definition of a failed tool call was
 * `result.startsWith('Error:')`. These tests pin the cases that convention
 * got wrong — silently, in the layer every evidence surface depends on.
 */
import { describe, it, expect } from 'vitest';
import { classifyToolResult, isFailure, countsAsCompletedMutation } from './toolOutcome';

describe('classifyToolResult', () => {
  it('a plain result is a success', () => {
    expect(classifyToolResult('fs_read_file', 'file contents here').status).toBe('succeeded');
  });

  it('honours the legacy Error: prose convention', () => {
    const o = classifyToolResult('fs_move_file', 'Error: ENOENT: no such file');
    expect(o.status).toBe('failed');
    expect(o.detail).toMatch(/ENOENT/);
  });

  it('a thrown dispatch fails regardless of the result string', () => {
    expect(classifyToolResult('x', 'partial output', { thrown: true }).status).toBe('failed');
  });

  it('a policy-blocked call is a failure, and says so', () => {
    const o = classifyToolResult('fs_delete_file', '{}', { blocked: true });
    expect(o.status).toBe('failed');
    expect(o.detail).toMatch(/blocked by policy/);
  });

  it('an empty result is NOT evidence of success', () => {
    expect(classifyToolResult('browser_click', '').status).toBe('failed');
    expect(classifyToolResult('browser_click', '   ').status).toBe('failed');
  });

  // The case that motivated the whole classifier.
  it('a partial batch is partial, not a success (fs_move_batch 1 of 50)', () => {
    const result = JSON.stringify({ success: true, moved: 1, failed: 49, results: [] });
    const o = classifyToolResult('fs_move_batch', result);
    expect(o.status).toBe('partial');
    expect(o.counts).toEqual({ ok: 1, failed: 49 });
    expect(o.detail).toMatch(/1 succeeded, 49 failed/);
    // Critically: a partial batch must NOT be recorded as a completed mutation.
    expect(countsAsCompletedMutation(o)).toBe(false);
    // …but it is also not a flat failure, so it doesn't inflate the error tally.
    expect(isFailure(o)).toBe(false);
  });

  it('a batch where everything failed is a failure', () => {
    const o = classifyToolResult('fs_move_batch', JSON.stringify({ success: false, moved: 0, failed: 12 }));
    expect(o.status).toBe('failed');
    expect(isFailure(o)).toBe(true);
  });

  it('a fully successful batch is a success', () => {
    const o = classifyToolResult('fs_move_batch', JSON.stringify({ success: true, moved: 20, failed: 0 }));
    expect(o.status).toBe('succeeded');
    expect(countsAsCompletedMutation(o)).toBe(true);
  });

  it('structured error carriers are detected without the prose prefix', () => {
    expect(classifyToolResult('t', JSON.stringify({ error: 'permission denied' })).status).toBe('failed');
    expect(classifyToolResult('t', JSON.stringify({ isError: true, content: [] })).status).toBe('failed');
    expect(classifyToolResult('t', JSON.stringify({ success: false })).status).toBe('failed');
  });

  it('does not mistake prose merely containing the word error for a failure', () => {
    // A search result about errors is not itself an error.
    const o = classifyToolResult('web_search', 'Top result: "How to fix Error: ENOENT in Node"');
    expect(o.status).toBe('succeeded');
  });

  it('details are sanitized and bounded so evidence stays small', () => {
    const o = classifyToolResult('t', 'Error: ' + 'x'.repeat(5000));
    expect((o.detail ?? '').length).toBeLessThanOrEqual(201);
  });

  it('non-JSON and malformed JSON degrade to success only when non-empty', () => {
    expect(classifyToolResult('t', '{not json').status).toBe('succeeded'); // opaque prose result
    expect(classifyToolResult('t', '{"success": false').status).toBe('succeeded'); // unparseable
  });
});
