/**
 * Agent Memory tools — let the ReAct loop store and recall persistent facts
 * across sessions. Facts are written to the `memory_entities` SQLite table
 * and surfaced in the system prompt at the start of each workflow.
 *
 * Three tools exposed to the agent:
 *   memory_store   — persist a named fact or entity.
 *   memory_recall  — search memories by keyword.
 *   memory_forget  — delete a specific memory by ID.
 *
 * A fourth helper, `getMemoryContext()`, is NOT an agent tool — it is called
 * by the orchestrator to build the system-prompt preamble.
 */
import OpenAI from 'openai';
import { getDb } from '../db/schema';

interface MemoryEntity {
  entity_id: string;
  name: string;
  entity_type: string;
  content: string;
  tags_json: string;
  source_session_id: string | null;
  created_at: number;
  updated_at: number;
}

export const MEMORY_TOOL_SCHEMAS: OpenAI.ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'memory_store',
      description:
        'Persist a fact, preference, or entity about the user or their work to long-term memory. ' +
        'Call this whenever you learn something that will be useful in future conversations — ' +
        'e.g. the user\'s preferred output format, a project name, a recurring contact, a key decision. ' +
        'Use a short descriptive name and include all relevant context in the content field.',
      parameters: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'Short unique identifier for this memory (e.g. "preferred_doc_format", "client_name").',
          },
          content: {
            type: 'string',
            description: 'The fact or entity to remember, written in plain English.',
          },
          entity_type: {
            type: 'string',
            enum: ['fact', 'preference', 'person', 'project', 'decision', 'other'],
            description: 'Category of this memory.',
          },
          tags: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional keyword tags for easier retrieval.',
          },
        },
        required: ['name', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'memory_recall',
      description:
        'Search long-term memory for facts matching a keyword or topic. ' +
        'Returns matching memories with their IDs, names, and content.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Keyword or phrase to search for in memory names and content.',
          },
          limit: {
            type: 'number',
            description: 'Maximum number of results to return (default 10).',
          },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'memory_forget',
      description: 'Delete a specific memory by its ID. Use when a stored fact is outdated or incorrect.',
      parameters: {
        type: 'object',
        properties: {
          entity_id: {
            type: 'string',
            description: 'The entity_id returned by memory_recall or memory_store.',
          },
        },
        required: ['entity_id'],
      },
    },
  },
];

const MEMORY_TOOL_NAMES = new Set(MEMORY_TOOL_SCHEMAS.map(t => t.function.name));

export function isMemoryTool(name: string): boolean {
  return MEMORY_TOOL_NAMES.has(name);
}

export function invokeMemoryTool(
  name: string,
  args: Record<string, unknown>,
  sessionId?: string,
): string {
  const db = getDb();

  if (name === 'memory_store') {
    const memName   = String(args.name ?? '').trim();
    const content   = String(args.content ?? '').trim();
    const entType   = String(args.entity_type ?? 'fact');
    const tags      = Array.isArray(args.tags) ? args.tags : [];
    if (!memName || !content) return 'Error: name and content are required.';

    // Upsert — update existing row if name matches, insert otherwise.
    const existing = db.prepare(`SELECT entity_id FROM memory_entities WHERE name=? LIMIT 1`).get(memName) as { entity_id: string } | undefined;
    if (existing) {
      db.prepare(
        `UPDATE memory_entities SET content=?, entity_type=?, tags_json=?, updated_at=unixepoch() WHERE entity_id=?`
      ).run(content, entType, JSON.stringify(tags), existing.entity_id);
      return `Memory updated (id: ${existing.entity_id}): "${memName}"`;
    }
    const row = db.prepare(
      `INSERT INTO memory_entities (name, entity_type, content, tags_json, source_session_id)
       VALUES (?, ?, ?, ?, ?) RETURNING entity_id`
    ).get(memName, entType, content, JSON.stringify(tags), sessionId ?? null) as { entity_id: string };
    return `Memory stored (id: ${row.entity_id}): "${memName}"`;
  }

  if (name === 'memory_recall') {
    const query = String(args.query ?? '').trim();
    const limit = Math.min(Number(args.limit ?? 10), 50);
    if (!query) return 'Error: query is required.';
    const pat = `%${query}%`;
    const rows = db.prepare(
      `SELECT entity_id, name, entity_type, content, updated_at
       FROM memory_entities
       WHERE name LIKE ? OR content LIKE ?
       ORDER BY updated_at DESC LIMIT ?`
    ).all(pat, pat, limit) as Pick<MemoryEntity, 'entity_id' | 'name' | 'entity_type' | 'content' | 'updated_at'>[];
    if (!rows.length) return `No memories found matching "${query}".`;
    return rows.map(r =>
      `[${r.entity_id}] (${r.entity_type}) ${r.name}: ${r.content}`
    ).join('\n');
  }

  if (name === 'memory_forget') {
    const id = String(args.entity_id ?? '').trim();
    if (!id) return 'Error: entity_id is required.';
    const info = db.prepare(`DELETE FROM memory_entities WHERE entity_id=?`).run(id);
    return info.changes > 0 ? `Memory ${id} deleted.` : `No memory found with id "${id}".`;
  }

  return `Unknown memory tool: ${name}`;
}

/**
 * Returns a formatted memory preamble injected into the ReAct system prompt.
 * Loads the 20 most recently updated memories. Returns an empty string when
 * there is nothing to inject.
 */
export function getMemoryContext(): string {
  try {
    const db = getDb();
    const rows = db.prepare(
      `SELECT name, entity_type, content FROM memory_entities ORDER BY updated_at DESC LIMIT 20`
    ).all() as Pick<MemoryEntity, 'name' | 'entity_type' | 'content'>[];
    if (!rows.length) return '';
    const lines = rows.map(r => `• [${r.entity_type}] ${r.name}: ${r.content}`).join('\n');
    return `LONG-TERM MEMORY (what you know about this user from past sessions):\n${lines}\n\n`;
  } catch {
    return '';
  }
}
