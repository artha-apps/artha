/**
 * Knowledge Graph tools — the LLM-facing surface over the Bodhi KG engine
 * (`bodhi/knowledgeGraph.ts`). These let the agent record and traverse typed
 * relationships ("who knows whom", "what connects to what") in any
 * conversation. All logic lives in the engine; this module is a thin adapter,
 * following the `tools/rag.ts` contract (schemas + predicate + dispatcher).
 */
import OpenAI from 'openai';
import {
  upsertEntity,
  linkEntities,
  getNeighborhood,
  queryGraphDb,
  formatNeighborhood,
} from '../bodhi/knowledgeGraph';

export const KG_TOOL_SCHEMAS: OpenAI.ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'kg_link',
      description:
        'Record a typed relationship between two things in the knowledge graph, creating either node if it does not exist yet. ' +
        'Example: kg_link(src="Alice", dst="Acme", rel_type="works_at").',
      parameters: {
        type: 'object',
        properties: {
          src: { type: 'string', description: 'Name (or id) of the source entity.' },
          dst: { type: 'string', description: 'Name (or id) of the destination entity.' },
          rel_type: { type: 'string', description: "The relationship, e.g. 'works_at', 'knows', 'reports_to'." },
          src_kind: { type: 'string', description: "Type of the source entity, e.g. 'person', 'company'. Defaults to 'thing'." },
          dst_kind: { type: 'string', description: "Type of the destination entity. Defaults to 'thing'." },
        },
        required: ['src', 'dst', 'rel_type'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'kg_query',
      description:
        "Look up one entity's relationships — its neighborhood of connected entities and the typed edges to them. " +
        'Identify the entity by name or id.',
      parameters: {
        type: 'object',
        properties: {
          entity: { type: 'string', description: 'Name or id of the entity to inspect.' },
        },
        required: ['entity'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'kg_search',
      description: 'Search the knowledge graph for entities by name or type. Returns matching entities with their ids and kinds.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Name or keyword to search for.' },
          kind: { type: 'string', description: "Optional type filter, e.g. 'person', 'company'." },
        },
        required: ['query'],
      },
    },
  },
];

const KG_TOOL_NAMES = new Set(KG_TOOL_SCHEMAS.map(t => t.function.name));

/** True when `name` is a built-in KG tool — used by MCPRegistry for routing. */
export function isKgTool(name: string): boolean {
  return KG_TOOL_NAMES.has(name);
}

/** Synchronous dispatcher for the KG tools (the engine is blocking SQLite). */
export function invokeKgTool(name: string, args: Record<string, unknown>, projectId?: string | null): string {
  try {
    if (name === 'kg_link') {
      const src = String(args.src ?? '').trim();
      const dst = String(args.dst ?? '').trim();
      const relType = String(args.rel_type ?? '').trim();
      if (!src || !dst || !relType) return 'Error: "src", "dst", and "rel_type" are all required.';
      const srcEnt = upsertEntity({ kind: String(args.src_kind ?? 'thing'), name: src, source: 'manual', projectId: projectId ?? null });
      const dstEnt = upsertEntity({ kind: String(args.dst_kind ?? 'thing'), name: dst, source: 'manual', projectId: projectId ?? null });
      linkEntities(srcEnt.entity_id, dstEnt.entity_id, relType);
      return `Linked: ${src} —[${relType}]→ ${dst}.`;
    }

    if (name === 'kg_query') {
      const ref = String(args.entity ?? '').trim();
      if (!ref) return 'Error: "entity" is required.';
      const neighborhood = getNeighborhood(ref);
      if (!neighborhood) return `No entity found matching "${ref}".`;
      return formatNeighborhood(neighborhood);
    }

    if (name === 'kg_search') {
      const query = String(args.query ?? '').trim();
      if (!query) return 'Error: "query" is required.';
      const kind = args.kind ? String(args.kind) : undefined;
      const { nodes } = queryGraphDb(query, { kind, projectId: projectId ?? null });
      if (!nodes.length) return `No entities match "${query}".`;
      return nodes.map(n => `[${n.entity_id}] ${n.name} (${n.kind})`).join('\n');
    }

    return `Unknown KG tool: ${name}`;
  } catch (err) {
    return `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
}
