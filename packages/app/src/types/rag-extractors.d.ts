/** Minimal ambient types for the RAG text-extraction parsers. */

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
