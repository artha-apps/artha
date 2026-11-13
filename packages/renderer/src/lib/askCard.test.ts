/**
 * Inline ask_user card helpers: option toggling honours single vs multi,
 * submit is gated on every question being answered, answers are shaped for
 * `interactions:respond`, and the pending list upserts/removes by id.
 */
import { describe, it, expect } from 'vitest';
import { toggleOption, canSubmit, buildAnswers, upsertPending, removePending, type AskQuestionView } from './askCard';

const single: AskQuestionView = { id: 'a', question: 'One?', options: [{ label: 'x' }, { label: 'y' }], allow_custom: false, multi: false };
const multi: AskQuestionView = { id: 'b', question: 'Many?', options: [{ label: 'p' }, { label: 'q' }], allow_custom: true, multi: true };

describe('askCard helpers', () => {
  it('single-select replaces, multi-select accumulates', () => {
    let d = { selected: [] as string[], custom: '' };
    d = toggleOption(d, single, 'x');
    d = toggleOption(d, single, 'y');
    expect(d.selected).toEqual(['y']);
    let m = { selected: [] as string[], custom: '' };
    m = toggleOption(m, multi, 'p');
    m = toggleOption(m, multi, 'q');
    expect(m.selected).toEqual(['p', 'q']);
    expect(toggleOption(m, multi, 'p').selected).toEqual(['q']);
  });

  it('submit requires every question answered (custom counts when allowed)', () => {
    expect(canSubmit([single, multi], { a: { selected: ['x'], custom: '' } })).toBe(false);
    expect(canSubmit([single, multi], { a: { selected: ['x'], custom: '' }, b: { selected: [], custom: 'mine' } })).toBe(true);
    expect(canSubmit([single], { a: { selected: [], custom: 'not allowed' } })).toBe(false);
  });

  it('builds the answer payload and strips custom when not allowed', () => {
    expect(buildAnswers([single, multi], {
      a: { selected: ['x'], custom: 'ignored' },
      b: { selected: ['p'], custom: '  extra ' },
    })).toEqual({ a: { selected: ['x'] }, b: { selected: ['p'], custom: 'extra' } });
  });

  it('upserts and removes pending interactions by id', () => {
    const i1 = { id: '1', kind: 'ask' as const, run_id: 'r', payload: {}, created_at: 2 };
    const i0 = { id: '0', kind: 'ask' as const, run_id: 'r', payload: {}, created_at: 1 };
    const list = upsertPending(upsertPending([], i1), i0);
    expect(list.map(i => i.id)).toEqual(['0', '1']);
    expect(upsertPending(list, { ...i1, payload: { x: 1 } })).toHaveLength(2);
    expect(removePending(list, '0').map(i => i.id)).toEqual(['1']);
  });
});
