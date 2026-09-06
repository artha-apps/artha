import { describe, it, expect } from 'vitest';
import { decideAutoApprove } from './autoApprove';

const blast = (o: Partial<{ deletions: number; reversible: boolean; moves: number; writes: number }> = {}) =>
  ({ deletions: 0, reversible: true, moves: 0, writes: 0, ...o });

describe('decideAutoApprove', () => {
  it('runs reversible moves/writes automatically and says so', () => {
    const d = decideAutoApprove({ autonomous: undefined, blast: blast({ moves: 2, writes: 1 }) });
    expect(d.auto).toBe(true);
    expect(d.reason).toMatch(/2 moves · 1 write/);
    expect(d.reason).toMatch(/Undo/);
  });
  it('asks for any delete', () => {
    expect(decideAutoApprove({ autonomous: true, blast: blast({ deletions: 1 }) })).toMatchObject({ auto: false });
  });
  it('asks when the estimate is not reversible or missing', () => {
    expect(decideAutoApprove({ autonomous: true, blast: blast({ reversible: false }) }).auto).toBe(false);
    expect(decideAutoApprove({ autonomous: true, blast: undefined }).auto).toBe(false);
  });
  it('respects the off switch', () => {
    expect(decideAutoApprove({ autonomous: false, blast: blast({ moves: 1 }) }).auto).toBe(false);
  });
});
