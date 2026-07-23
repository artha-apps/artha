/**
 * QA profile isolation — founder-approved validation infrastructure.
 *
 * `ARTHA_USER_DATA_DIR` points a session at a disposable profile directory so
 * scripted validation NEVER touches the real profile. Guardrails (normative,
 * per founder approval):
 *   - Ordinary production launches are unaffected: the override is honored
 *     only in development/test, or in a packaged build that ALSO sets
 *     ARTHA_QA_MODE=1 (two explicit flags — no silent redirection).
 *   - The path must be absolute, normalized, and non-ambiguous; empty or
 *     relative paths are refused.
 *   - The override may never point at (or contain) the LIVE default profile
 *     directory.
 *   - In QA mode an invalid override is FATAL — failing safe means refusing
 *     to run rather than falling back onto the live profile mid-validation.
 *     Outside QA mode an invalid override is ignored entirely.
 *   - Logging discloses that an isolated QA profile is active using the
 *     directory BASENAME only (no full personal paths in logs).
 *
 * Pure and electron-free so every branch is unit-testable; main.ts applies
 * the decision via app.setPath('userData', …) before anything opens the DB.
 */
import * as path from 'path';

export interface QaProfileDecision {
  /** 'none' = run normally · 'apply' = use resolvedPath · 'fatal' = refuse to start. */
  action: 'none' | 'apply' | 'fatal';
  resolvedPath?: string;
  /** Sanitized, log-safe reason (basename only — never a full user path). */
  reason: string;
}

export interface QaProfileEnv {
  ARTHA_USER_DATA_DIR?: string;
  ARTHA_QA_MODE?: string;
  NODE_ENV?: string;
}

export function resolveQaProfile(env: QaProfileEnv, defaultUserDataDir: string, packaged: boolean): QaProfileDecision {
  const raw = env.ARTHA_USER_DATA_DIR;
  if (!raw || raw.trim() === '') return { action: 'none', reason: 'no override set' };

  const qaMode = env.ARTHA_QA_MODE === '1';
  const devLike = env.NODE_ENV === 'development' || env.NODE_ENV === 'test';

  // Packaged builds require the second explicit flag; dev/test allow the
  // override directly (it cannot reach ordinary users there).
  if (packaged && !qaMode) {
    return { action: 'none', reason: 'override ignored: packaged build without ARTHA_QA_MODE=1' };
  }
  if (!packaged && !devLike && !qaMode) {
    return { action: 'none', reason: 'override ignored: not development/test and ARTHA_QA_MODE not set' };
  }

  const invalid = (why: string): QaProfileDecision =>
    qaMode
      ? { action: 'fatal', reason: `invalid ARTHA_USER_DATA_DIR (${why}) — refusing to run rather than risk the live profile` }
      : { action: 'none', reason: `override ignored: ${why}` };

  const candidate = raw.trim();
  if (!path.isAbsolute(candidate)) return invalid('path is not absolute');
  const normalized = path.normalize(candidate);
  if (normalized !== path.resolve(normalized)) return invalid('path is ambiguous after normalization');

  // Never the live profile — not equal to it, not inside it, not a parent of it.
  const live = path.normalize(defaultUserDataDir);
  const rel = path.relative(live, normalized);
  if (normalized === live || rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) {
    return invalid('path points at or inside the live profile directory');
  }
  const relUp = path.relative(normalized, live);
  if (!relUp.startsWith('..') && !path.isAbsolute(relUp)) {
    return invalid('path contains the live profile directory');
  }

  return {
    action: 'apply',
    resolvedPath: normalized,
    reason: `isolated QA profile active: …/${path.basename(normalized)}`,
  };
}
