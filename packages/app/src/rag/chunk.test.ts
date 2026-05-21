import { describe, it, expect } from 'vitest';
import { chunkOnBoundaries } from './chunk';

describe('chunkOnBoundaries', () => {
  it('returns nothing for empty text', () => {
    expect(chunkOnBoundaries('', 100, 20)).toEqual([]);
  });

  it('keeps short text as a single chunk', () => {
    const t = 'The quick brown fox jumps over the lazy dog.';
    const out = chunkOnBoundaries(t, 512, 64);
    expect(out).toHaveLength(1);
    expect(out[0].text).toBe(t);
    expect(out[0].offset).toBe(0);
  });

  it('never splits a word across chunks', () => {
    const sentence = 'alpha bravo charlie delta echo foxtrot golf hotel india juliet ';
    const text = sentence.repeat(8);
    const chunks = chunkOnBoundaries(text, 80, 16);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      // No chunk should start or end in the middle of one of our known words.
      expect(c.text).toMatch(/^[A-Za-z]/);
      expect(c.text.split(/\s+/).every((w) => /^[A-Za-z]*$/.test(w))).toBe(true);
    }
  });

  it('prefers breaking at sentence boundaries', () => {
    const text =
      'First sentence here that is reasonably long. Second sentence also of a similar length. Third sentence wraps it up nicely.';
    const chunks = chunkOnBoundaries(text, 60, 10);
    // The first chunk should end at a sentence terminator, not mid-clause.
    expect(chunks[0].text.endsWith('.')).toBe(true);
  });

  it('drops chunks below the minimum length', () => {
    const out = chunkOnBoundaries('hi.', 512, 64, 20);
    expect(out).toEqual([]);
  });

  it('makes progress even when a single token exceeds the target', () => {
    const longToken = 'x'.repeat(300);
    const text = `${longToken} and then some trailing words to index here.`;
    const chunks = chunkOnBoundaries(text, 100, 20);
    expect(chunks.length).toBeGreaterThan(0);
    // Offsets must be strictly increasing (no infinite loop / stuck position).
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i].offset).toBeGreaterThan(chunks[i - 1].offset);
    }
  });

  it('overlaps consecutive chunks for boundary-straddling facts', () => {
    const text = Array.from({ length: 40 }, (_, i) => `word${i}`).join(' ');
    const chunks = chunkOnBoundaries(text, 60, 20);
    expect(chunks.length).toBeGreaterThan(1);
    // The next chunk should begin before the previous one ends (overlap).
    expect(chunks[1].offset).toBeLessThan(chunks[0].offset + chunks[0].text.length);
  });
});
