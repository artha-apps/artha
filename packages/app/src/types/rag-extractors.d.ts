/**
 * Ambient type shims for the RAG text-extraction parsers.
 *
 * pdf-parse ships a bare-JS package with no bundled .d.ts. We import its
 * internal `lib/pdf-parse.js` entry directly (not `index.js`) to suppress
 * the debug-mode file-read that fires on require() — without this the test
 * runner would error with ENOENT for a fixture PDF it expects at a hard-coded
 * path in the package source.
 *
 * mammoth ships its own typings but they are incomplete; the minimal slice
 * here (`extractRawText`) is all Artha uses and avoids dragging in the full
 * (sometimes mismatched) @types/mammoth.
 */

declare module 'pdf-parse/lib/pdf-parse.js' {
  interface PdfParseResult {
    text: string;
    numpages: number;
    info?: unknown;
  }
  function pdfParse(data: Buffer | Uint8Array): Promise<PdfParseResult>;
  export default pdfParse;
}

declare module 'mammoth' {
  export function extractRawText(
    input: { path: string } | { buffer: Buffer }
  ): Promise<{ value: string; messages: unknown[] }>;
}
