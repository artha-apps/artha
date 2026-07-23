/**
 * RUNTIME profile-isolation test (founder requirement): writes representative
 * data and proves every created file stays under the disposable root.
 *
 * The static guard (qaProfileIsolation.test.ts) catches the *syntax* of a
 * module-load path capture; this catches the *behaviour* — a module imported
 * BEFORE the QA override is applied must still resolve its paths under the
 * override root once it is actually used.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** Mutable userData, mirroring Electron's app.setPath('userData', …). */
const { appState } = vi.hoisted(() => ({
  appState: { userData: '' },
}));

vi.mock('electron', () => ({
  app: {
    getPath: (k: string) => (k === 'userData' ? appState.userData : os.tmpdir()),
    setPath: (k: string, v: string) => { if (k === 'userData') appState.userData = v; },
    isPackaged: true,
  },
}));

vi.mock('../db/schema', () => ({
  getDb: () => ({ prepare: () => ({ run: () => ({ changes: 1 }), get: () => undefined, all: () => [] }) }),
}));

// Imported HERE, at module-evaluation time — i.e. while userData still points
// at the "live" profile, exactly as handlers.ts is imported by main.ts before
// the override runs.
import { getDefaultRagIndexer, __resetDefaultIndexerForTests } from '../rag/indexer';
import { resolveQaProfile } from './qaProfile';

let liveRoot: string;
let qaRoot: string;
let corpus: string;

/** Every file created under a root, recursively. */
function walk(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

beforeEach(() => {
  liveRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'artha-live-'));
  qaRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'artha-qa-'));
  corpus = fs.mkdtempSync(path.join(os.tmpdir(), 'artha-corpus-'));
  fs.writeFileSync(path.join(corpus, 'doc.txt'), 'Synthetic validation content for isolation testing.');
  appState.userData = liveRoot;          // app starts on the live profile
  __resetDefaultIndexerForTests();       // fresh process semantics
  // Embeddings stub so buildIndex completes without a local runtime.
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true, status: 200,
    json: async () => ({ embedding: new Array(768).fill(0.25) }),
  } as unknown as Response)));
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const d of [liveRoot, qaRoot, corpus]) fs.rmSync(d, { recursive: true, force: true });
});

describe('QA override redirects real writes (runtime)', () => {
  it('a module imported BEFORE the override still writes under the override root', async () => {
    // 1. The override decision, as main.ts makes it.
    const decision = resolveQaProfile(
      { ARTHA_USER_DATA_DIR: qaRoot, ARTHA_QA_MODE: '1' }, liveRoot, true);
    expect(decision.action).toBe('apply');
    appState.userData = decision.resolvedPath!;   // app.setPath('userData', …)

    // 2. FIRST use of the indexer happens after the override (lazy resolution).
    const indexer = getDefaultRagIndexer();
    await indexer.buildIndex('iso-test', corpus);

    // 3. Every created file must live under the disposable root.
    const qaFiles = walk(qaRoot);
    const liveFiles = walk(liveRoot);
    expect(qaFiles.length).toBeGreaterThan(0);
    expect(liveFiles).toEqual([]);                            // live profile untouched
    for (const f of qaFiles) expect(f.startsWith(qaRoot)).toBe(true);
  });

  it('without QA authorization the production root is used unchanged', async () => {
    const decision = resolveQaProfile({ ARTHA_USER_DATA_DIR: qaRoot }, liveRoot, true); // no ARTHA_QA_MODE
    expect(decision.action).toBe('none');                     // override ignored
    // userData stays on the live root; writes land there, as production expects.
    const indexer = getDefaultRagIndexer();
    await indexer.buildIndex('prod-test', corpus);
    expect(walk(liveRoot).length).toBeGreaterThan(0);
    expect(walk(qaRoot)).toEqual([]);
  });

  it('an override pointing at the live profile is refused, so writes cannot be redirected onto it', () => {
    for (const bad of [liveRoot, path.join(liveRoot, 'nested')]) {
      const d = resolveQaProfile({ ARTHA_USER_DATA_DIR: bad, ARTHA_QA_MODE: '1' }, liveRoot, true);
      expect(d.action).toBe('fatal');
      expect(d.resolvedPath).toBeUndefined();
    }
  });
});
