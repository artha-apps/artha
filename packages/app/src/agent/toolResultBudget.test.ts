import { describe, it, expect } from 'vitest';
import { clampToolResult, MAX_TOOL_RESULT_CHARS } from './toolResultBudget';

describe('clampToolResult', () => {
  it('passes small results through untouched', () => {
    expect(clampToolResult('{"ok":true}')).toBe('{"ok":true}');
  });
  it('clamps oversized results and says how much was cut', () => {
    const big = 'x'.repeat(MAX_TOOL_RESULT_CHARS + 5_000);
    const out = clampToolResult(big);
    expect(out.length).toBeLessThan(big.length);
    expect(out.startsWith('x'.repeat(MAX_TOOL_RESULT_CHARS))).toBe(true);
    expect(out).toMatch(/truncated 5,000 more characters/);
    expect(out).toMatch(/Narrow the request/);
  });
  it('honours a custom budget', () => {
    expect(clampToolResult('abcdef', 3)).toMatch(/^abc\n…\[truncated 3 more/);
  });
});
