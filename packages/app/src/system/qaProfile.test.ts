/**
 * QA profile override tests (founder-required safeguards):
 *  - the default production path stays untouched when the override is absent
 *  - invalid overrides fail SAFELY (ignored outside QA mode; FATAL in QA mode
 *    so a validation run can never fall back onto the live profile)
 *  - the live profile directory is unreachable through the override
 */
import { describe, it, expect } from 'vitest';
import { resolveQaProfile } from './qaProfile';

const LIVE = '/Users/someone/Library/Application Support/Artha';

describe('resolveQaProfile', () => {
  it('no override → production path untouched (packaged and dev alike)', () => {
    expect(resolveQaProfile({}, LIVE, true).action).toBe('none');
    expect(resolveQaProfile({ NODE_ENV: 'development' }, LIVE, false).action).toBe('none');
    expect(resolveQaProfile({ ARTHA_USER_DATA_DIR: '   ' }, LIVE, true).action).toBe('none');
  });

  it('packaged build WITHOUT ARTHA_QA_MODE=1 ignores the override (no silent redirect)', () => {
    const d = resolveQaProfile({ ARTHA_USER_DATA_DIR: '/tmp/Artha.Validation.BYOK' }, LIVE, true);
    expect(d.action).toBe('none');
    expect(d.reason).toMatch(/ARTHA_QA_MODE/);
  });

  it('packaged build WITH both flags applies the isolated profile', () => {
    const d = resolveQaProfile(
      { ARTHA_USER_DATA_DIR: '/tmp/qa/Artha.Validation.BYOK', ARTHA_QA_MODE: '1' }, LIVE, true);
    expect(d.action).toBe('apply');
    expect(d.resolvedPath).toBe('/tmp/qa/Artha.Validation.BYOK');
    // Log-safe reason: basename only, never the full path.
    expect(d.reason).toContain('Artha.Validation.BYOK');
    expect(d.reason).not.toContain('/tmp/qa/');
  });

  it('development honors the override without the extra flag', () => {
    const d = resolveQaProfile(
      { ARTHA_USER_DATA_DIR: '/tmp/qa/Artha.Validation.Local', NODE_ENV: 'development' }, LIVE, false);
    expect(d.action).toBe('apply');
  });

  it('relative or ambiguous paths are refused', () => {
    // QA mode → FATAL (refuse to run), never a silent fallback to the live profile.
    expect(resolveQaProfile({ ARTHA_USER_DATA_DIR: 'relative/dir', ARTHA_QA_MODE: '1' }, LIVE, true).action).toBe('fatal');
    // Outside QA mode → ignored entirely.
    expect(resolveQaProfile({ ARTHA_USER_DATA_DIR: 'relative/dir', NODE_ENV: 'development' }, LIVE, false).action).toBe('none');
  });

  it('the live profile directory is unreachable: equal, inside, or containing it', () => {
    for (const bad of [LIVE, `${LIVE}/sub`, '/Users/someone/Library/Application Support']) {
      const d = resolveQaProfile({ ARTHA_USER_DATA_DIR: bad, ARTHA_QA_MODE: '1' }, LIVE, true);
      expect(d.action, bad).toBe('fatal');
      expect(d.reason).toMatch(/live profile/);
    }
  });

  it('fatal reasons never leak the supplied path', () => {
    const d = resolveQaProfile({ ARTHA_USER_DATA_DIR: `${LIVE}/secret-place`, ARTHA_QA_MODE: '1' }, LIVE, true);
    expect(d.reason).not.toContain('secret-place');
  });
});
