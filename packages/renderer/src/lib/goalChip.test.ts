/** Goal chip wording + controls. */
import { describe, it, expect } from 'vitest';
import { goalStatusLabel, goalControls, formatElapsed } from './goalChip';

describe('goal chip', () => {
  it('labels blocked as "Needs you" and never offers a done control', () => {
    expect(goalStatusLabel('blocked')).toBe('Needs you');
    expect(goalControls('active')).toEqual({ pause: true, resume: false, stop: true });
    expect(goalControls('blocked')).toEqual({ pause: false, resume: true, stop: true });
    expect(goalControls('completed')).toEqual({ pause: false, resume: false, stop: false });
    expect(goalControls('terminated')).toEqual({ pause: false, resume: false, stop: false });
  });

  it('formats elapsed time compactly', () => {
    expect(formatElapsed(45_000)).toBe('45s');
    expect(formatElapsed(12 * 60_000)).toBe('12m');
    expect(formatElapsed(65 * 60_000)).toBe('1h 05m');
    expect(formatElapsed(-5)).toBe('0s');
  });
});
