/**
 * Boundary-aware text chunking for RAG indexing.
 *
 * The old approach sliced every CHUNK_SIZE characters regardless of content,
 * which cut words (and often sentences) in half — the embedding model then saw
 * fragments like "…the contract sta" / "tes that the party…", weakening recall.
 *
 * This splits on natural boundaries instead: each chunk grows toward a target
 * size, then breaks at the nearest sentence end (. ! ? or newline) within reach,
 * falling back to a word boundary, and only ever a hard cut if a single "word"
 * is itself longer than the target. Consecutive chunks overlap by ~overlap
 * characters, snapped forward to a word boundary so no chunk starts mid-word.
 *
 * Pure (no fs/Electron) so it can be unit-tested directly.
 */

export interface TextChunk {
  /** The chunk text, trimmed. */
  text: string;
  /** Character offset of the chunk's start in the source text (stable id input). */
  offset: number;
}

/** How far back from the target we'll look for a sentence/word boundary before
 *  giving up and hard-cutting — as a fraction of the target size. */
const LOOKBACK = 0.35;

const isSentenceEnd = (ch: string) => ch === '.' || ch === '!' || ch === '?' || ch === '\n';
const isSpace = (ch: string) => /\s/.test(ch);

/**
 * Split `text` into boundary-aligned chunks of ~`targetChars`, overlapping by
 * ~`overlapChars`. Chunks shorter than `minChars` (after trimming) are dropped.
 */
export function chunkOnBoundaries(
  text: string,
  targetChars = 512,
  overlapChars = 64,
  minChars = 20,
): TextChunk[] {
  const chunks: TextChunk[] = [];
  const len = text.length;
  if (len === 0) return chunks;

  const minBreak = Math.floor(targetChars * (1 - LOOKBACK));
  let pos = 0;

  while (pos < len) {
    const hardEnd = Math.min(pos + targetChars, len);
    let end = hardEnd;

    if (hardEnd < len) {
      // Prefer a sentence boundary within the look-back window…
      let sentence = -1;
      for (let i = hardEnd; i > pos + minBreak; i--) {
        if (isSentenceEnd(text[i - 1])) { sentence = i; break; }
      }
      if (sentence > 0) {
        end = sentence;
      } else {
        // …otherwise the nearest preceding whitespace (don't split a word).
        let space = -1;
        for (let i = hardEnd; i > pos + minBreak; i--) {
          if (isSpace(text[i])) { space = i; break; }
        }
        end = space > 0 ? space : hardEnd; // hard cut only for an over-long token
      }
    }

    const slice = text.slice(pos, end).trim();
    if (slice.length >= minChars) chunks.push({ text: slice, offset: pos });

    if (end >= len) break;

    // Advance, keeping `overlapChars` of trailing context, then snap forward to
    // a word boundary so the next chunk doesn't begin mid-word. Always make
    // progress to avoid looping.
    let next = Math.max(end - overlapChars, pos + 1);
    while (next < end && !isSpace(text[next - 1])) next++;
    pos = next > pos ? next : end;
  }

  return chunks;
}
