/**
 * The citation/workflow token is per ReAct loop (bug-hunt R3 #2).
 *
 * It used to be one process-wide variable saved/restored like a stack. Two
 * loops that INTERLEAVE (a chat run while a scheduled run works) broke it:
 * the chat's citations went to the scheduled run, then the scheduled run's
 * later citations were dropped. These tests interleave two loops and check
 * each keeps its own token and sources.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getPath: () => '/tmp' } }));
vi.mock('../db/schema', () => ({ getDb: () => { throw new Error('no db'); } }));

import {
  runWithCitationToken, getActiveCitationToken, startCitationCollection, drainCitations, recordCitation,
} from './web';

const tick = () => new Promise(r => setTimeout(r, 0));
const cite = (url: string) => recordCitation({ url, title: url, fetched_at: 0 });

describe('citation token scope', () => {
  it('interleaved loops keep their own token and citations', async () => {
    startCitationCollection('A');
    startCitationCollection('S');
    let releaseA!: () => void;
    const aWaits = new Promise<void>(r => { releaseA = r; });

    const loopA = runWithCitationToken('A', async () => {
      cite('https://a/1');
      await aWaits;                 // S starts and runs while A is mid-loop
      cite('https://a/2');
      expect(getActiveCitationToken()).toBe('A');
    });
    const loopS = runWithCitationToken('S', async () => {
      cite('https://s/1');
      releaseA();
      await tick();                 // A finishes first…
      cite('https://s/2');          // …S must still be collecting
      expect(getActiveCitationToken()).toBe('S');
    });
    await Promise.all([loopA, loopS]);

    expect(drainCitations('A').map(c => c.url)).toEqual(['https://a/1', 'https://a/2']);
    expect(drainCitations('S').map(c => c.url)).toEqual(['https://s/1', 'https://s/2']);
    expect(getActiveCitationToken()).toBeNull();
  });

  it("a nested loop's token ends with it and the parent's is back", async () => {
    await runWithCitationToken('parent', async () => {
      await runWithCitationToken('child', async () => {
        expect(getActiveCitationToken()).toBe('child');
      });
      expect(getActiveCitationToken()).toBe('parent');
    });
  });
});
