/**
 * Pure decision helpers for BrowserView crash recovery, split out from
 * BrowserController so the crashloop-guard and target-selection logic can be
 * unit-tested without spinning up Electron.
 */

/** How long after a silent auto-reload a second crash is treated as a
 *  crashloop — within this window we stop reloading and show the manual
 *  recovery overlay instead. */
export const AUTO_RECOVER_WINDOW_MS = 10_000;

/** Decide what to do when the page renderer dies. `auto-reload` for the first
 *  crash (or one long after the last silent reload); `show-overlay` when it
 *  crashed again within `windowMs` of that reload, so we don't loop forever. */
export function decideCrashAction(
  now: number,
  lastAutoRecoverAt: number,
  windowMs: number = AUTO_RECOVER_WINDOW_MS,
): 'auto-reload' | 'show-overlay' {
  return now - lastAutoRecoverAt > windowMs ? 'auto-reload' : 'show-overlay';
}

/** Pick the URL a recovery should navigate to: the last real page if there is
 *  one, otherwise the home page (we never try to "recover" to about:blank). */
export function recoveryTarget(lastUrl: string, aboutBlank: string, homeUrl: string): string {
  return lastUrl && lastUrl !== aboutBlank ? lastUrl : homeUrl;
}
