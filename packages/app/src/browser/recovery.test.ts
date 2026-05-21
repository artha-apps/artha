import { describe, it, expect } from 'vitest';
import { decideCrashAction, recoveryTarget, AUTO_RECOVER_WINDOW_MS } from './recovery';

describe('decideCrashAction', () => {
  it('auto-reloads the first crash (no prior auto-recover)', () => {
    expect(decideCrashAction(1_000_000, 0)).toBe('auto-reload');
  });

  it('shows the overlay when a crash recurs within the window', () => {
    const last = 1_000_000;
    expect(decideCrashAction(last + 3_000, last)).toBe('show-overlay');
  });

  it('auto-reloads again once the window has elapsed', () => {
    const last = 1_000_000;
    expect(decideCrashAction(last + AUTO_RECOVER_WINDOW_MS + 1, last)).toBe('auto-reload');
  });

  it('treats exactly-at-the-boundary as still within the window (overlay)', () => {
    const last = 1_000_000;
    expect(decideCrashAction(last + AUTO_RECOVER_WINDOW_MS, last)).toBe('show-overlay');
  });
});

describe('recoveryTarget', () => {
  const ABOUT_BLANK = 'about:blank';
  const HOME = 'data:text/html;home';

  it('returns the last real URL when there is one', () => {
    expect(recoveryTarget('https://example.com', ABOUT_BLANK, HOME)).toBe('https://example.com');
  });

  it('falls back to home for about:blank', () => {
    expect(recoveryTarget(ABOUT_BLANK, ABOUT_BLANK, HOME)).toBe(HOME);
  });

  it('falls back to home for an empty last URL', () => {
    expect(recoveryTarget('', ABOUT_BLANK, HOME)).toBe(HOME);
  });
});
