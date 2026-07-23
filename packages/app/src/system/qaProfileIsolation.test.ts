/**
 * Regression guard for the QA-profile isolation defect found during row 13:
 * `handlers.ts` captured the RAG indexer at MODULE LOAD, binding it to the
 * default userData path before main.ts applied ARTHA_USER_DATA_DIR — so an
 * isolated validation session wrote an index file into the real profile.
 *
 * These are static-source assertions (no Electron boot required): they fail
 * if a userData-derived singleton is ever re-introduced at import time.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const SRC = path.join(__dirname, '..');
const read = (rel: string) => fs.readFileSync(path.join(SRC, rel), 'utf-8');

/** Strip block/line comments so doc-comments mentioning a pattern don't match. */
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('QA profile isolation: no userData binding at module load', () => {
  it('handlers.ts does not construct the RAG indexer at import time', () => {
    const src = code(read('ipc/handlers.ts'));
    // A bare top-level `const x = getDefaultRagIndexer();` re-introduces the bug.
    expect(src).not.toMatch(/^const\s+\w+\s*=\s*getDefaultRagIndexer\(\)\s*;/m);
  });

  it('no module-level top-level call captures app.getPath at import time', () => {
    for (const rel of ['ipc/handlers.ts', 'rag/indexer.ts', 'db/schema.ts', 'scheduler/scheduler.ts']) {
      const src = code(read(rel));
      // Allowed: app.getPath INSIDE a function/method body (indented).
      // Disallowed: a top-level `const … = …app.getPath(…)` binding.
      expect(src, rel).not.toMatch(/^const\s+[^\n=]+=\s*[^\n]*app\.getPath\(/m);
    }
  });

  it('main.ts applies the QA override before importing-time side effects can matter', () => {
    const src = read('main.ts');
    const qaIdx = src.indexOf('resolveQaProfile(');
    const lockIdx = src.indexOf('requestSingleInstanceLock(');
    // The CALL site (with semicolon), not the function declaration above it.
    const readyIdx = src.indexOf('initTelemetryBeforeReady();');
    expect(qaIdx).toBeGreaterThan(-1);
    // The override must precede both the userData-keyed instance lock and the
    // pre-ready DB/telemetry bootstrap.
    expect(qaIdx).toBeLessThan(lockIdx);
    expect(qaIdx).toBeLessThan(readyIdx);
  });
});
