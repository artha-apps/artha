/**
 * Bodhi — Knowledge Graph engine.
 *
 * The general-purpose relationship layer of the intelligence stack: typed
 * **entities** (person / company / deal / …) connected by typed directed
 * **relations** (works_at / owns_deal / interacted_with / …). It is a real
 * engine, not a tool or an optional MCP — domain producers (the CRM Agent
 * today; Email/Calendar later) PROJECT their rows in here so "who knows whom"
 * questions become graph traversals.
 *
 * Distinct from `memory_entities` (a flat fact bag with no relation concept):
 * the KG carries a stable `(source, kind, external_id)` key so a producer can
 * re-project the same row idempotently, plus directed typed edges.
 *
 * The row→object projections and the in-memory graph assembly are PURE and
 * unit-tested (`knowledgeGraph.test.ts`); the query/mutation helpers are thin
 * wrappers over the shared SQLite connection (the `tasks.ts` convention).
 */
import { getDb } from '../db/schema';

// ── Types ────────────────────────────────────────────────────────────────────

/** A node in the graph, with `props_json` parsed into a structured object. */
export interface KgEntity {
  entity_id: string;
  kind: string;
  name: string;
  external_id: string | null;
  source: string;
  props: Record<string, unknown>;
  project_id: string | null;
  created_at: number;
  updated_at: number;
}

/** A directed typed edge between two entities. */
export interface KgRelation {
  relation_id: string;
  src_id: string;
  dst_id: string;
  rel_type: string;
  props: Record<string, unknown>;
  created_at: number;
}

/** One entity plus its incident edges and the entities on the other end —
 *  the unit the UI and tool output render. */
export interface KgNeighborhood {
  entity: KgEntity;
  edges: KgEdge[];
}

/** An edge as seen from a center entity: which way it points + who's on the
 *  other end (resolved to a full entity when known). */
export interface KgEdge {
  relation: KgRelation;
  direction: 'out' | 'in';
  other: KgEntity | null;
}

/** A validated relation to create — produced by `parseRelationSpec` from raw
 *  tool args before it touches the DB. */
export interface RelationSpec {
  srcId: string;
  dstId: string;
  relType: string;
  props: Record<string, unknown>;
}

/** Raw DB row shapes (kept local so the pure helpers don't depend on the DB). */
interface KgEntityRow {
  entity_id: string;
  kind: string;
  name: string;
  external_id: string | null;
  source: string;
  props_json: string;
  project_id: string | null;
  created_at: number;
  updated_at: number;
}
interface KgRelationRow {
  relation_id: string;
  src_id: string;
  dst_id: string;
  rel_type: string;
  props_json: string;
  created_at: number;
}

// ── Pure helpers (no DB — unit-tested) ───────────────────────────────────────

/** Tolerant JSON-object parse: malformed or non-object input yields `{}`,
 *  mirroring `skillToCapability`'s defensive parse of an allowlist. */
export function parseProps(json: string | null | undefined): Record<string, unknown> {
  if (!json) return {};
  try {
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** Project a DB entity row into a `KgEntity`. */
export function rowToKgEntity(row: KgEntityRow): KgEntity {
  return {
    entity_id: row.entity_id,
    kind: row.kind,
    name: row.name,
    external_id: row.external_id ?? null,
    source: row.source,
    props: parseProps(row.props_json),
    project_id: row.project_id ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/** Project a DB relation row into a `KgRelation`. */
export function rowToKgRelation(row: KgRelationRow): KgRelation {
  return {
    relation_id: row.relation_id,
    src_id: row.src_id,
    dst_id: row.dst_id,
    rel_type: row.rel_type,
    props: parseProps(row.props_json),
    created_at: row.created_at,
  };
}

/** Canonical dedupe key for a producer-owned node. Case/whitespace-insensitive
 *  on the external id so the same logical record always maps to one node. */
export function normaliseEntityKey(kind: string, externalId: string): string {
  return `${kind.trim().toLowerCase()}:${externalId.trim().toLowerCase()}`;
}

/** Assemble a center entity + a pool of entities + a pool of relations into the
 *  center's 1-hop neighborhood. Pure: pass plain arrays, get a structured
 *  object. Only relations actually incident to the center are kept. */
export function projectGraph(
  center: KgEntity,
  entities: KgEntity[],
  relations: KgRelation[],
): KgNeighborhood {
  const byId = new Map(entities.map(e => [e.entity_id, e]));
  const edges: KgEdge[] = [];
  for (const r of relations) {
    if (r.src_id === center.entity_id) {
      edges.push({ relation: r, direction: 'out', other: byId.get(r.dst_id) ?? null });
    } else if (r.dst_id === center.entity_id) {
      edges.push({ relation: r, direction: 'in', other: byId.get(r.src_id) ?? null });
    }
  }
  return { entity: center, edges };
}

/** Render a neighborhood as compact text for tool output (parallel to
 *  `ragFormat.formatRagResults`). */
export function formatNeighborhood(n: KgNeighborhood): string {
  const head = `${n.entity.name} (${n.entity.kind})`;
  if (n.edges.length === 0) return `${head}\n  (no relationships recorded)`;
  const lines = n.edges.map(e => {
    const other = e.other ? `${e.other.name} (${e.other.kind})` : '(unknown)';
    return e.direction === 'out'
      ? `  —[${e.relation.rel_type}]→ ${other}`
      : `  ←[${e.relation.rel_type}]— ${other}`;
  });
  return `${head}\n${lines.join('\n')}`;
}

/** Validate a raw relation triple from tool args into a `RelationSpec`, or null
 *  if it's incomplete. `props` defaults to `{}`. */
export function parseRelationSpec(args: Record<string, unknown>): RelationSpec | null {
  const srcId = typeof args.src_id === 'string' ? args.src_id.trim() : '';
  const dstId = typeof args.dst_id === 'string' ? args.dst_id.trim() : '';
  const relType = typeof args.rel_type === 'string' ? args.rel_type.trim() : '';
  if (!srcId || !dstId || !relType) return null;
  const props = args.props && typeof args.props === 'object' && !Array.isArray(args.props)
    ? (args.props as Record<string, unknown>)
    : {};
  return { srcId, dstId, relType, props };
}

/** Pure keyword search over in-memory graph data: returns the entities whose
 *  name/kind matches `query` (case-insensitive substring) plus every edge
 *  incident to a matched node. Empty query → empty result. Used by both the
 *  DB-backed query and the unit tests (which pass arrays directly). */
export function queryGraph(
  entities: KgEntity[],
  relations: KgRelation[],
  query: string,
  opts: { kind?: string } = {},
): { nodes: KgEntity[]; edges: KgRelation[] } {
  const q = query.trim().toLowerCase();
  if (!q) return { nodes: [], edges: [] };
  const nodes = entities.filter(e => {
    if (opts.kind && e.kind !== opts.kind) return false;
    return e.name.toLowerCase().includes(q) || e.kind.toLowerCase().includes(q);
  });
  const ids = new Set(nodes.map(n => n.entity_id));
  const edges = relations.filter(r => ids.has(r.src_id) || ids.has(r.dst_id));
  return { nodes, edges };
}

// ── DB-backed API (thin wrappers over the shared connection) ─────────────────

/** Insert or update a node. With an `externalId`, the node is keyed by
 *  `(source, kind, external_id)` so re-projecting the same record updates it in
 *  place (idempotent). Without one, an existing node with the same
 *  `(source, kind, name, project)` is reused; otherwise a fresh node is made. */
export function upsertEntity(input: {
  kind: string;
  name: string;
  externalId?: string | null;
  source?: string;
  props?: Record<string, unknown>;
  projectId?: string | null;
}): KgEntity {
  const db = getDb();
  const source = input.source ?? 'manual';
  const projectId = input.projectId ?? null;
  const propsJson = JSON.stringify(input.props ?? {});

  let existing: KgEntityRow | undefined;
  if (input.externalId) {
    existing = db.prepare(
      `SELECT * FROM kg_entities WHERE source=? AND kind=? AND external_id=?`
    ).get(source, input.kind, input.externalId) as KgEntityRow | undefined;
  } else {
    existing = db.prepare(
      `SELECT * FROM kg_entities
        WHERE source=? AND kind=? AND lower(name)=lower(?) AND IFNULL(project_id,'')=IFNULL(?, '')`
    ).get(source, input.kind, input.name, projectId) as KgEntityRow | undefined;
  }

  if (existing) {
    db.prepare(
      `UPDATE kg_entities SET name=?, props_json=?, updated_at=unixepoch() WHERE entity_id=?`
    ).run(input.name, propsJson, existing.entity_id);
    return rowToKgEntity(
      db.prepare(`SELECT * FROM kg_entities WHERE entity_id=?`).get(existing.entity_id) as KgEntityRow
    );
  }

  const row = db.prepare(
    `INSERT INTO kg_entities (kind, name, external_id, source, props_json, project_id)
     VALUES (?, ?, ?, ?, ?, ?)
     RETURNING *`
  ).get(input.kind, input.name, input.externalId ?? null, source, propsJson, projectId) as KgEntityRow;
  return rowToKgEntity(row);
}

/** Ensure a typed directed edge exists between two nodes (idempotent — the
 *  unique index on (src,dst,rel_type) makes a repeat call a no-op). */
export function linkEntities(
  srcId: string,
  dstId: string,
  relType: string,
  props: Record<string, unknown> = {},
): void {
  getDb().prepare(
    `INSERT OR IGNORE INTO kg_relations (src_id, dst_id, rel_type, props_json) VALUES (?, ?, ?, ?)`
  ).run(srcId, dstId, relType, JSON.stringify(props));
}

/** Keyword search for entities by name (LIKE), optionally filtered by kind and
 *  scoped to a project (NULL project rows are always global/visible). */
export function findEntities(
  query: string,
  opts: { kind?: string; projectId?: string | null; limit?: number } = {},
): KgEntity[] {
  const limit = Math.min(Math.max(opts.limit ?? 25, 1), 200);
  const clauses: string[] = [`name LIKE ?`];
  const params: unknown[] = [`%${query}%`];
  if (opts.kind) { clauses.push(`kind = ?`); params.push(opts.kind); }
  if (opts.projectId) { clauses.push(`(project_id = ? OR project_id IS NULL)`); params.push(opts.projectId); }
  const rows = getDb().prepare(
    `SELECT * FROM kg_entities WHERE ${clauses.join(' AND ')} ORDER BY updated_at DESC LIMIT ${limit}`
  ).all(...params) as KgEntityRow[];
  return rows.map(rowToKgEntity);
}

/** All entities (optionally filtered by kind / project) — backs the UI graph view. */
export function listEntities(opts: { kind?: string; projectId?: string | null } = {}): KgEntity[] {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (opts.kind) { clauses.push(`kind = ?`); params.push(opts.kind); }
  if (opts.projectId) { clauses.push(`(project_id = ? OR project_id IS NULL)`); params.push(opts.projectId); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = getDb().prepare(
    `SELECT * FROM kg_entities ${where} ORDER BY kind ASC, name ASC`
  ).all(...params) as KgEntityRow[];
  return rows.map(rowToKgEntity);
}

/** All relations, or just those incident to one node — backs the UI graph view. */
export function listRelations(nodeId?: string): KgRelation[] {
  const rows = nodeId
    ? getDb().prepare(`SELECT * FROM kg_relations WHERE src_id=? OR dst_id=?`).all(nodeId, nodeId)
    : getDb().prepare(`SELECT * FROM kg_relations`).all();
  return (rows as KgRelationRow[]).map(rowToKgRelation);
}

/** Resolve an entity (by id, else by exact name) and assemble its 1-hop
 *  neighborhood via the pure `projectGraph`. */
export function getNeighborhood(idOrName: string): KgNeighborhood | null {
  const db = getDb();
  let row = db.prepare(`SELECT * FROM kg_entities WHERE entity_id=?`).get(idOrName) as KgEntityRow | undefined;
  if (!row) {
    row = db.prepare(`SELECT * FROM kg_entities WHERE lower(name)=lower(?) ORDER BY updated_at DESC LIMIT 1`)
      .get(idOrName) as KgEntityRow | undefined;
  }
  if (!row) return null;
  const center = rowToKgEntity(row);
  const relRows = db.prepare(`SELECT * FROM kg_relations WHERE src_id=? OR dst_id=?`)
    .all(center.entity_id, center.entity_id) as KgRelationRow[];
  const relations = relRows.map(rowToKgRelation);
  const otherIds = new Set<string>();
  for (const r of relations) {
    otherIds.add(r.src_id === center.entity_id ? r.dst_id : r.src_id);
  }
  const others = [...otherIds].map(id =>
    db.prepare(`SELECT * FROM kg_entities WHERE entity_id=?`).get(id) as KgEntityRow | undefined
  ).filter((r): r is KgEntityRow => !!r).map(rowToKgEntity);
  return projectGraph(center, [center, ...others], relations);
}

/** DB-backed keyword query: load the candidate nodes + their incident edges and
 *  run the pure `queryGraph` over them. */
export function queryGraphDb(
  query: string,
  opts: { kind?: string; projectId?: string | null } = {},
): { nodes: KgEntity[]; edges: KgRelation[] } {
  const entities = listEntities({ kind: opts.kind, projectId: opts.projectId });
  const relations = listRelations();
  return queryGraph(entities, relations, query, { kind: opts.kind });
}
