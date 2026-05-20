/**
 * Text extraction for RAG indexing. Binary/Office formats must be parsed, not
 * read as UTF-8 — reading a .pdf or .docx as a string yields garbage that
 * poisons the embeddings. This module routes each file to a real extractor:
 *
 *   .pdf   → pdf-parse
 *   .docx  → mammoth (raw text)
 *   .xlsx  → xlsx (every sheet → CSV)
 *   others → UTF-8 read (txt/md/csv/json/code)
 *
 * Heavy parsers are dynamically imported so they only load when a matching file
 * is actually encountered.
 */
import * as fs from 'fs';
import * as path from 'path';

/** Extensions safe to read directly as UTF-8 text. */
const PLAIN_TEXT = new Set([
  '.txt', '.md', '.csv', '.json', '.ts', '.js', '.py',
  '.html', '.htm', '.xml', '.yaml', '.yml', '.tsx', '.jsx',
]);

/** Extract plain text from a file based on its extension. Returns '' on any
 *  parser failure so a single bad file never aborts a whole index build. */
export async function extractText(filePath: string): Promise<string> {
  const ext = path.extname(filePath).toLowerCase();
  try {
    if (ext === '.pdf') return await extractPdf(filePath);
    if (ext === '.docx') return await extractDocx(filePath);
    if (ext === '.xlsx') return extractXlsx(filePath);
    if (PLAIN_TEXT.has(ext)) return fs.readFileSync(filePath, 'utf-8');
    // Unknown but collected — best-effort UTF-8 (legacy behaviour).
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return '';
  }
}

async function extractPdf(filePath: string): Promise<string> {
  // Import the lib entry directly to skip pdf-parse's index.js debug-mode file read.
  const pdfParse = (await import('pdf-parse/lib/pdf-parse.js')).default;
  const data = await pdfParse(fs.readFileSync(filePath));
  return data.text ?? '';
}

async function extractDocx(filePath: string): Promise<string> {
  const mammoth = await import('mammoth');
  const { value } = await mammoth.extractRawText({ path: filePath });
  return value ?? '';
}

function extractXlsx(filePath: string): string {
  // xlsx is already a dependency (used by the document generator).
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const XLSX = require('xlsx') as typeof import('xlsx');
  const wb = XLSX.readFile(filePath);
  return wb.SheetNames
    .map(name => `# ${name}\n${XLSX.utils.sheet_to_csv(wb.Sheets[name])}`)
    .join('\n\n');
}
