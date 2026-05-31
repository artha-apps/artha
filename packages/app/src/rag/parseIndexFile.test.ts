/**
 * Unit tests for `parseIndexFile` in `rag/indexFormat.ts`.
 *
 * Verifies: backward-compatible parsing of the legacy bare-array format (which
 * has no fileHashes), the current v2 object format (chunks + fileHashes), and
 * graceful handling of partially-populated v2 objects that omit optional fields.
 */
import { describe, it, expect } from 'vitest';
import { parseIndexFile } from './indexFormat';

/** Minimal chunk fixture — only the fields parseIndexFile cares about. */
const chunk = (id: string, filePath: string) => ({ id, filePath, text: 't', embedding: [0.1, 0.2] });

describe('parseIndexFile', () => {
  // ── Legacy format ──────────────────────────────────────────────────────────
  it('reads the legacy bare-array format with no file hashes', () => {
    const raw = JSON.stringify([chunk('a', '/x.md'), chunk('b', '/y.md')]);
    const out = parseIndexFile(raw);
    expect(out.chunks).toHaveLength(2);
    expect(out.fileHashes).toEqual({});
  });

  // ── v2 format ──────────────────────────────────────────────────────────────

  it('reads the v2 object format with chunks + fileHashes', () => {
    const raw = JSON.stringify({ version: 2, chunks: [chunk('a', '/x.md')], fileHashes: { '/x.md': 'abc' } });
    const out = parseIndexFile(raw);
    expect(out.chunks).toHaveLength(1);
    expect(out.fileHashes['/x.md']).toBe('abc');
  });

  // ── Fault tolerance ────────────────────────────────────────────────────────

  it('tolerates a malformed v2 object missing fields', () => {
    const out = parseIndexFile(JSON.stringify({ version: 2 }));
    expect(out.chunks).toEqual([]);
    expect(out.fileHashes).toEqual({});
  });
});
