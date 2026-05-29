/**
 * Built-in RAG tools — let the agent search and cite the user's own indexed
 * files in any conversation (not just document generation). Backed by the same
 * local vector indexes managed in the RAG panel; nothing leaves the machine.
 */
import OpenAI from 'openai';
import { getDb } from '../db/schema';
import { searchAllIndexes } from '../rag/indexer';
import { formatRagResults, formatIndexList } from './ragFormat';

export const RAG_TOOL_SCHEMAS: OpenAI.ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'rag_search',
      description:
        "Search the user's own indexed files (their notes, documents, local knowledge base) and return the most " +
        'relevant passages with their source filenames. Use this whenever the user asks about their own files, ' +
        'notes, or documents, or refers to information that would live in their personal knowledge base. ' +
        'Cite the returned filenames in your answer.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'What to look for, phrased as a search query.' },
          top_k: { type: 'number', description: 'How many passages to return (default 6, max 20).' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'rag_list_indexes',
      description:
        'List the file indexes available to search with rag_search, with how many chunks each holds. ' +
        'Use this to check whether the user has any searchable files before relying on rag_search.',
      parameters: { type: 'object', properties: {} },
    },
  },
];

const RAG_TOOL_NAMES = new Set(RAG_TOOL_SCHEMAS.map(t => t.function.name));

/** Returns true when `name` is a built-in RAG tool — used by MCPRegistry for
 *  routing without importing the full schema list. */
export function isRagTool(name: string): boolean {
  return RAG_TOOL_NAMES.has(name);
}

/**
 * Dispatch a RAG tool call.
 *
 * @param name        Tool name from the model's function call.
 * @param args        Raw argument object as parsed from the LLM response.
 * @param ragIndexIds When non-empty, restricts retrieval and index listing to
 *                    these specific index IDs (the chat's folder-scoped indexes).
 *                    Null or empty array means "search all indexes".
 */
export async function invokeRagTool(
  name: string,
  args: Record<string, unknown>,
  ragIndexIds?: string[] | null,
): Promise<string> {
  // Empty array and null are both treated as "no scope" — search all indexes.
  const scoped = !!(ragIndexIds && ragIndexIds.length);

  if (name === 'rag_list_indexes') {
    // A scoped chat sees only its own folders' indexes; otherwise list all.
    const rows = (scoped
      ? getDb().prepare(
          `SELECT name, doc_count FROM rag_indexes WHERE index_id IN (${ragIndexIds!.map(() => '?').join(',')}) ORDER BY created_at DESC`
        ).all(...ragIndexIds!)
      : getDb().prepare(`SELECT name, doc_count FROM rag_indexes ORDER BY created_at DESC`).all()
    ) as { name: string; doc_count: number }[];
    return formatIndexList(rows);
  }

  if (name === 'rag_search') {
    const query = typeof args.query === 'string' ? args.query.trim() : '';
    if (!query) return 'Error: "query" is required.';
    const topK = Math.min(Math.max(Number(args.top_k) || 6, 1), 20);
    // When the chat is scoped to folders, confine retrieval to their indexes.
    const hits = await searchAllIndexes(query, topK, scoped ? ragIndexIds : null);
    return formatRagResults(query, hits);
  }

  throw new Error(`Unknown rag tool: ${name}`);
}
