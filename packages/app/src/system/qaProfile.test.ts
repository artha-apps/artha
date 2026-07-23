/**
 * QA profile override tests (founder-required safeguards):
 *  - the default production path stays untouched when the override is absent
 *  - invalid overrides fail SAFELY (ignored outside QA mode; FATAL in QA mode
 *    so a validation run can never fall back onto the live profile)
 *  - the live profile directory is unreachable through the override
 */
import { describe, it, expect } from 'vitest';
import * as path from 'path';
import * as os from 'os';
import { resolveQaProfile } from './qaProfile';

/** Platform-appropriate absolute paths: POSIX literals normalize differently
 *  on Windows (a drive letter is prepended), which is exactly what the
 *  ambiguity guard is designed to reject. */
const abs = (...parts: string[]) => path.join(os.tmpdir(), ...parts);
const LIVE = abs('artha-live-profile', 'Artha');

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
      { ARTHA_USER_DATA_DIR: abs('qa', 'Artha.Validation.BYOK'), ARTHA_QA_MODE: '1' }, LIVE, true);
    expect(d.action).toBe('apply');
    expect(d.resolvedPath).toBe(abs('qa', 'Artha.Validation.BYOK'));
    // Log-safe reason: basename only, never the full path.
    expect(d.reason).toContain('Artha.Validation.BYOK');
    expect(d.reason).not.toContain(path.join(os.tmpdir(), 'qa'));
  });

  it('development honors the override without the extra flag', () => {
    const d = resolveQaProfile(
      { ARTHA_USER_DATA_DIR: abs('qa', 'Artha.Validation.Local'), NODE_ENV: 'development' }, LIVE, false);
    expect(d.action).toBe('apply');
  });

  it('relative or ambiguous paths are refused', () => {
    // QA mode → FATAL (refuse to run), never a silent fallback to the live profile.
    expect(resolveQaProfile({ ARTHA_USER_DATA_DIR: 'relative/dir', ARTHA_QA_MODE: '1' }, LIVE, true).action).toBe('fatal');
    // Outside QA mode → ignored entirely.
    expect(resolveQaProfile({ ARTHA_USER_DATA_DIR: 'relative/dir', NODE_ENV: 'development' }, LIVE, false).action).toBe('none');
  });

  it('the live profile directory is unreachable: equal, inside, or containing it', () => {
    for (const bad of [LIVE, path.join(LIVE, 'sub'), path.dirname(LIVE)]) {
      const d = resolveQaProfile({ ARTHA_USER_DATA_DIR: bad, ARTHA_QA_MODE: '1' }, LIVE, true);
      expect(d.action, bad).toBe('fatal');
      expect(d.reason).toMatch(/live profile/);
    }
  });

  it('case-variant paths cannot sneak onto the live profile (review M3)', () => {
    // macOS/Windows default volumes are case-insensitive, so a lowercase
    // spelling of the live directory must be refused too.
    const variant = LIVE.toLowerCase() === LIVE ? LIVE.toUpperCase() : LIVE.toLowerCase();
    const d = resolveQaProfile({ ARTHA_USER_DATA_DIR: variant, ARTHA_QA_MODE: '1' }, LIVE, true);
    if (process.platform === 'darwin' || process.platform === 'win32') {
      expect(d.action).toBe('fatal');
      expect(d.reason).toMatch(/live profile/);
    } else {
      // Linux volumes are case-sensitive: a different case IS a different dir.
      expect(d.action).toBe('apply');
    }
  });

  it('fatal reasons never leak the supplied path', () => {
    const d = resolveQaProfile({ ARTHA_USER_DATA_DIR: path.join(LIVE, 'secret-place'), ARTHA_QA_MODE: '1' }, LIVE, true);
    expect(d.reason).not.toContain('secret-place');
  });
});
