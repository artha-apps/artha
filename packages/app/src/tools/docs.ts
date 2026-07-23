/**
 * Built-in Document tools — let the agent *produce* polished DOCX/PPTX/XLSX/PDF
 * files as part of a ReAct workflow (not just from the UI button). This is what
 * makes "research X and write me a report.docx" work end-to-end and is Artha's
 * headline differentiator.
 *
 * Wraps the provenance-anchored `generateDocument()` engine. Output files
 * default to ~/Documents; the finished file is opened in its native app.
 */
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { shell } from 'electron';
import OpenAI from 'openai';
import { generateDocument, type DocType, type SourceChunk } from '../docs/generator';
import { searchAllIndexes } from '../rag/indexer';
import { getSemanticStatus } from '../llm/ollamaRuntime';
import { resolveDocOutPath } from './docPath';
import { getDb } from '../db/schema';
import { currentEntitlements, docsGeneratedThisMonth } from '../license/current';

const HOME = os.homedir();
const DOC_TYPES: DocType[] = ['docx', 'pptx', 'xlsx', 'pdf'];

export const DOCS_TOOL_SCHEMAS: OpenAI.ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'docs_generate',
      description:
        'Produce a polished document (Word .docx, PowerPoint .pptx, Excel .xlsx, or PDF) from a content brief. ' +
        'Use this whenever the user asks you to write, create, draft, or produce a report, proposal, summary, ' +
        'spreadsheet, or presentation as a file. If you gathered facts from web_search/web_fetch or files, pass ' +
        'them in "context" so the document is grounded and sourced. The file is saved and opened automatically.',
      parameters: {
        type: 'object',
        properties: {
          type: {
            type: 'string',
            enum: DOC_TYPES,
            description: 'Document format: docx (Word), pptx (PowerPoint), xlsx (Excel), or pdf.',
          },
          prompt: {
            type: 'string',
            description:
              'A detailed brief of what the document should contain — topic, audience, sections, tone. ' +
              'The richer the brief, the better the output.',
          },
          filename: {
            type: 'string',
            description:
              'File name including extension, e.g. "EV-Market-Report.docx". Saved to ~/Documents unless an ' +
              'absolute path is given.',
          },
          context: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Optional grounding facts (e.g. snippets you found via web_fetch). Each becomes a citable source.',
          },
          use_rag: {
            type: 'boolean',
            description:
              "Set true to ground the document in the user's own indexed files (RAG). Use when the request " +
              'refers to their notes, documents, or local knowledge. Retrieved passages are cited by filename.',
          },
          rag_query: {
            type: 'string',
            description: 'Search query for RAG retrieval. Defaults to the document prompt if omitted.',
          },
        },
        required: ['type', 'prompt', 'filename'],
      },
    },
  },
];

const DOCS_TOOL_NAMES = new Set(DOCS_TOOL_SCHEMAS.map(t => t.function.name));

/** Returns true when `name` identifies a docs tool — used by MCPRegistry to
 *  route tool calls without importing the full schema list. */
export function isDocsTool(name: string): boolean {
  return DOCS_TOOL_NAMES.has(name);
}

/**
 * Dispatch a docs tool call. Currently only `docs_generate` is defined.
 *
 * @param name         Tool name from the model's function call.
 * @param args         Raw arguments object as parsed from the LLM response.
 * @param defaultDir   Output directory override — set to the chat's scoped
 *                     folder so generated files land inside the working folder.
 *                     Null/undefined falls back to ~/Documents.
 * @param ragIndexIds  When non-empty, confines RAG retrieval to these index IDs
 *                     (the chat's folder-scoped indexes). Null searches all.
 */
export async function invokeDocsTool(name: string, args: Record<string, unknown>, defaultDir?: string | null, ragIndexIds?: string[] | null): Promise<string> {
  if (name !== 'docs_generate') throw new Error(`Unknown docs tool: ${name}`);

  // Free-tier cap: document generation is the flagship, and the Free plan is
  // limited to N documents per calendar month (Entitlements.docsPerMonth;
  // null = unlimited on every paid tier). Returned as a tool-error string so
  // the agent relays the limit + upgrade path instead of crashing the run.
  const ents = currentEntitlements();
  if (ents.docsPerMonth !== null) {
    const used = docsGeneratedThisMonth();
    if (used >= ents.docsPerMonth) {
      return `Error: the Free plan includes ${ents.docsPerMonth} generated documents per month and this month's allowance is used up (${used}/${ents.docsPerMonth}). Tell the user the limit resets next month, or they can upgrade to Personal at artha.space for unlimited documents.`;
    }
  }

  const type = String(args.type ?? '').toLowerCase() as DocType;
  if (!DOC_TYPES.includes(type)) {
    return `Error: unsupported document type "${args.type}". Use one of: ${DOC_TYPES.join(', ')}.`;
  }
  const prompt = typeof args.prompt === 'string' ? args.prompt : '';
  if (!prompt.trim()) return 'Error: "prompt" (a content brief) is required.';
  const filename = typeof args.filename === 'string' && args.filename.trim()
    ? args.filename.trim()
    : `artha-document.${type}`;
  const userContext: string[] = Array.isArray(args.context)
    ? args.context.filter((c): c is string => typeof c === 'string')
    : [];

  // Pull grounding passages from the user's own indexed files when requested,
  // carrying the source filename so each becomes a real citation.
  const ragChunks: SourceChunk[] = [];
  let ragNote = '';
  if (args.use_rag === true) {
    const ragQuery = typeof args.rag_query === 'string' && args.rag_query.trim() ? args.rag_query.trim() : prompt;
    try {
      const hits = await searchAllIndexes(ragQuery, 6, ragIndexIds && ragIndexIds.length ? ragIndexIds : null);
      for (const h of hits) {
        ragChunks.push({ id: h.id.slice(0, 8), type: 'rag', ref: path.basename(h.filePath), text: h.text });
      }
      ragNote = hits.length
        ? ` Grounded in ${hits.length} passage(s) from your indexed files.`
        : (await getSemanticStatus()).available
          ? ' No indexed files matched.'
          : ' Your indexed files could NOT be searched (semantic search unavailable — local embeddings are not running), so this document is not grounded in them.';
    } catch {
      ragNote = ' (RAG retrieval unavailable.)';
    }
  }

  const contextChunks: SourceChunk[] = [
    ...ragChunks,
    ...userContext.map((text, i) => ({ id: `ctx-${i}`, type: 'user' as const, ref: 'provided', text })),
  ];

  // When the chat is scoped to a folder, drop generated docs there so the
  // agent's output stays inside the working folder; otherwise default ~/Documents.
  const outPath = resolveDocOutPath(filename, type, HOME, defaultDir ?? undefined);

  const result = await generateDocument({
    type, prompt, outPath,
    contextChunks: contextChunks.length ? contextChunks : undefined,
  });

  // Open the finished file in its native app — the payoff moment.
  shell.openPath(result.filePath).catch(() => { /* non-fatal */ });

  // Persist to artifacts table so ArtifactsPanel can list this file.
  try {
    const sizeBytes = fs.statSync(result.filePath).size;
    getDb().prepare(
      `INSERT INTO artifacts (name, file_path, file_type, size_bytes)
       VALUES (?, ?, ?, ?)`
    ).run(path.basename(result.filePath), result.filePath, type, sizeBytes);
  } catch { /* non-fatal — artifact log is best-effort */ }

  return [
    `Created ${path.basename(result.filePath)} (${type.toUpperCase()}) at ${result.filePath}.`,
    `${result.anchors} provenance-anchored section(s); receipt written to ${path.basename(result.receiptPath)}.${ragNote}`,
    `The file has been opened.`,
  ].join(' ');
}
