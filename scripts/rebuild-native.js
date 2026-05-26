#!/usr/bin/env node
/**
 * postinstall hook — rebuild native modules (better-sqlite3) against the
 * installed Electron's ABI so the database can open at runtime.
 *
 * Skipped in two cases:
 *   - CI: the typecheck/lint/test jobs never load better-sqlite3 (verified),
 *     and the release job rebuilds native deps via electron-builder during
 *     packaging. Running it in every CI job just wastes minutes.
 *   - No Electron installed yet (e.g. a partial install): nothing to target.
 *
 * Failure is non-fatal — we warn with the manual command rather than breaking
 * `npm install`, so a machine without build tools can still install and rebuild
 * later. main.ts surfaces a clear dialog if the binary is missing at launch.
 */
const { execSync } = require('child_process');

if (process.env.CI) {
  console.log('[postinstall] CI detected — skipping electron-rebuild (release packaging rebuilds natives itself).');
  process.exit(0);
}

try {
  console.log('[postinstall] Rebuilding better-sqlite3 against the installed Electron…');
  // Use npx so this resolves the local bin whether run by npm (PATH includes
  // node_modules/.bin) or standalone.
  execSync('npx electron-rebuild -f -w better-sqlite3', { stdio: 'inherit' });
} catch (err) {
  console.warn('[postinstall] electron-rebuild failed:', err && err.message);
  console.warn('[postinstall] Run it manually before launching the app:');
  console.warn('[postinstall]   npx electron-rebuild -f -w better-sqlite3');
  // Do not fail the install.
  process.exit(0);
}
