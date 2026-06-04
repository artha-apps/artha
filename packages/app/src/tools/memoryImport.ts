/**
 * Bring-Your-Own-Memory (BYOM) — parse a memory export pasted from another AI
 * assistant (ChatGPT / Claude / Gemini / …) into structured `memory_entities`
 * rows so Artha "already knows" the user from the first message.
 *
 * Two parse strategies (the UI picks per the user's choice):
 *   1. parseMemoryExport()  — fast, offline, rule-based. Understands the
 *      canonical "ARTHA MEMORY IMPORT v1" skeleton and also tolerates looser
 *      exports (markdown headers, bullet lines, no sentinel).
 *   2. refineMemoryExport() — sends the raw blob to the active local model and
 *      asks for a clean JSON array. Used when the heuristic finds little or the
 *      user clicks "Refine with AI". Falls back to the heuristic on any failure.
 *
 * Committing is separate from parsing (importMemories) so the renderer can show
 * a review/edit step before anything is written. exportMemories() does the
 * round-trip — emits global memory in the same v1 format.
 */
import { getDb } from '../db/schema';
import { getActiveLLMClient } from '../llm/client';

/** A single parsed memory, ready for review and (after edits) insertion. */
export interface ParsedEntry {
  /** Short slug key, unique within the batch (e.g. "always_respond_concisely"). */
  name: string;
  /** The fact/instruction, verbatim where possible. */
  content: string;
  /** One of the memory_entities entity_type enum values. */
  entity_type: string;
  /** Keyword tags (provenance + any inline tags). */
  tags: string[];
  /** Original date string if the export carried one (YYYY-MM-DD or 'unknown'). */
  date?: string | null;
}

/** Canonical category header → entity_type. Headers are matched case- and
 *  punctuation-insensitively (see normaliseHeader), so "**Instructions**",
 *  "[INSTRUCTIONS]", "## Instructions" and "Instructions:" all map here. */
const CATEGORY_TYPE: Record<string, string> = {
  instructions: 'preference',
  identity:     'person',
  career:       'fact',
  projects:     'project',
  preferences:  'preference',
  other:        'other',
};

/** Reverse map for export — entity_type → category header. Lossy by design
 *  (several types collapse to OTHER) but round-trips the common cases. */
const TYPE_CATEGORY: Record<string, string> = {
  preference: 'PREFERENCES',
  person:     'IDENTITY',
  fact:       'CAREER',
  project:    'PROJECTS',
  decision:   'OTHER',
  other:      'OTHER',
};

const VALID_TYPES = new Set(['fact', 'preference', 'person', 'project', 'decision', 'other']);

/** Strip code fences, sentinel lines, and surrounding whitespace from a paste. */
function stripWrapper(raw: string): string {
  let s = raw.trim();
  // Pull the contents out of the first fenced code block if present.
  const fence = s.match(/```(?:[a-zA-Z]*\n)?([\s\S]*?)```/);
  if (fence) s = fence[1].trim();
  return s;
}

/** Collapse a header line to a bare keyword, or null if it isn't a header.
 *  Recognises [HEADER], **Header**, ## Header, "Header:" and bare ALLCAPS. */
function normaliseHeader(line: string): string | null {
  const t = line.trim();
  // Sentinel / separator lines are never headers (and never content).
  if (/^={2,}/.test(t) || /^-{3,}$/.test(t)) return null;
  let m: RegExpMatchArray | null;
  if ((m = t.match(/^\[([A-Za-z][A-Za-z /&]*)\]$/))) return m[1].toLowerCase().trim();
  if ((m = t.match(/^\*\*([A-Za-z][A-Za-z /&]*)\*\*:?$/))) return m[1].toLowerCase().trim();
  if ((m = t.match(/^#{2,4}\s+([A-Za-z][A-Za-z /&]*):?$/))) return m[1].toLowerCase().trim();
  if ((m = t.match(/^([A-Za-z][A-Za-z /&]{1,28}):$/))) return m[1].toLowerCase().trim();
  return null;
}

/** Map a normalised header keyword to an entity_type, defaulting to 'other'. */
function headerToType(header: string): string {
  // Pick the first known category keyword contained in the header text, so
  // "Personal Preferences" or "Career & Skills" still resolve correctly.
  for (const key of Object.keys(CATEGORY_TYPE)) {
    if (header.includes(key)) return CATEGORY_TYPE[key];
  }
  return 'other';
}

/** Turn arbitrary content into a short, slug-ish unique name. */
function slugName(content: string, used: Set<string>, fallbackType: string): string {
  const base = content
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .trim()
    .split(/\s+/)
    .slice(0, 6)
    .join('_')
    .slice(0, 48) || `${fallbackType}`;
  let name = base;
  let n = 2;
  while (used.has(name)) name = `${base}_${n++}`;
  used.add(name);
  return name;
}

/**
 * Heuristic parse. Walks the text line by line: header lines switch the active
 * entity_type; entry lines (`[date] - content`, bullets, or plain prose under a
 * header) become entries. Lines starting with `#` and `(none)` placeholders are
 * ignored so the prompt's own helper comments never leak in.
 */
export function parseMemoryExport(raw: string, provenanceTag?: string): ParsedEntry[] {
  const body = stripWrapper(raw);
  if (!body) return [];

  const used = new Set<string>();
  const entries: ParsedEntry[] = [];
  let currentType = 'other';
  const baseTags = provenanceTag ? ['imported', provenanceTag] : ['imported'];

  for (const rawLine of body.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    if (/^={2,}/.test(line) || /^-{3,}$/.test(line)) continue; // sentinel / separator line
    if (/^#\s/.test(line) || line === '#') continue;           // single-# helper comment (## is a header)
    if (/^\(none\)$/i.test(line)) continue;                    // empty-section placeholder

    const header = normaliseHeader(line);
    if (header) { currentType = headerToType(header); continue; }

    // Entry shapes, in order of specificity:
    //   [2025-03-01] - content      → dated entry
    //   [unknown] - content         → undated entry
    //   - content   /   * content   → bullet
    //   content                     → plain line under a header
    let date: string | null = null;
    let content = line;

    let m = line.match(/^\[([^\]]*)\]\s*[-–:]\s*(.+)$/);
    if (m) {
      date = m[1].trim() || null;
      if (date && /^unknown$/i.test(date)) date = null;
      content = m[2].trim();
    } else {
      m = line.match(/^[-*•]\s+(.+)$/);
      if (m) content = m[1].trim();
      else m = line.match(/^\[([^\]]*)\]\s+(.+)$/);  // "[date] content" (no dash)
      if (m && content === line) { date = m[1].trim() || null; content = m[2].trim(); }
    }

    content = content.replace(/\s+/g, ' ').trim();
    if (content.length < 2) continue;
    if (/^=+$/.test(content)) continue;

    entries.push({
      name: slugName(content, used, currentType),
      content,
      entity_type: VALID_TYPES.has(currentType) ? currentType : 'other',
      tags: [...baseTags],
      date,
    });
  }

  return entries;
}

/**
 * AI-assisted parse. Sends the raw paste to the active local model and asks for
 * a normalised JSON array. Used when the heuristic yields too little or the user
 * explicitly requests it. Any failure (no model, bad JSON, timeout) falls back
 * to the heuristic so the feature never hard-blocks on the model.
 */
export async function refineMemoryExport(raw: string, provenanceTag?: string): Promise<ParsedEntry[]> {
  const heuristic = parseMemoryExport(raw, provenanceTag);
  try {
    const client = getActiveLLMClient(undefined, 'tool_args');
    const sys =
      'You convert a memory export pasted from another AI assistant into a clean JSON array of ' +
      'memory objects. Preserve the user\'s wording verbatim. Output ONLY a JSON array, no prose. ' +
      'Each object: {"name": short_snake_case_id, "content": the fact verbatim, ' +
      '"entity_type": one of "fact"|"preference"|"person"|"project"|"decision"|"other"}. ' +
      'Use "preference" for instructions/style rules, "person" for identity facts, ' +
      '"project" for projects, "fact" for career/skills, "other" otherwise. ' +
      'One object per atomic fact. Do not invent facts.';
    const res = await client.complete([
      { role: 'system', content: sys },
      { role: 'user', content: raw.slice(0, 16000) },
    ]);
    const text = res.choices[0]?.message?.content ?? '';
    const start = text.indexOf('[');
    const end = text.lastIndexOf(']');
    if (start < 0 || end <= start) return heuristic;
    const arr = JSON.parse(text.slice(start, end + 1)) as Array<Record<string, unknown>>;
    if (!Array.isArray(arr) || !arr.length) return heuristic;

    const used = new Set<string>();
    const baseTags = provenanceTag ? ['imported', provenanceTag] : ['imported'];
    const out: ParsedEntry[] = [];
    for (const o of arr) {
      const content = String(o.content ?? '').replace(/\s+/g, ' ').trim();
      if (content.length < 2) continue;
      let type = String(o.entity_type ?? 'other').toLowerCase();
      if (!VALID_TYPES.has(type)) type = 'other';
      const rawName = String(o.name ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
      const name = rawName && !used.has(rawName) ? (used.add(rawName), rawName) : slugName(content, used, type);
      out.push({ name, content, entity_type: type, tags: [...baseTags], date: null });
    }
    return out.length ? out : heuristic;
  } catch (err) {
    console.warn('[Artha] memory AI-refine failed, using heuristic:', err);
    return heuristic;
  }
}

export interface ImportResult {
  /** Rows newly inserted. */
  created: number;
  /** Rows skipped because identical content already existed. */
  skipped: number;
}

/**
 * Commit reviewed entries to memory_entities as global memories (project_id
 * NULL). Skips entries whose exact content already exists globally so a repeat
 * import (or re-import after a tweak) doesn't pile up duplicates. Names are made
 * unique against what's already in the table.
 */
export function importMemories(entries: ParsedEntry[], origin = 'import'): ImportResult {
  const db = getDb();
  let created = 0;
  let skipped = 0;

  const existsStmt = db.prepare(
    `SELECT 1 FROM memory_entities WHERE content = ? AND project_id IS NULL LIMIT 1`
  );
  const nameTakenStmt = db.prepare(
    `SELECT 1 FROM memory_entities WHERE name = ? AND project_id IS NULL LIMIT 1`
  );
  const insertStmt = db.prepare(
    `INSERT INTO memory_entities (name, entity_type, content, tags_json, source_session_id, project_id, origin)
     VALUES (?, ?, ?, ?, NULL, NULL, ?)`
  );

  const tx = db.transaction((rows: ParsedEntry[]) => {
    for (const e of rows) {
      const content = (e.content ?? '').trim();
      if (!content) continue;
      if (existsStmt.get(content)) { skipped++; continue; }

      // De-collide the name against the table (the batch already self-deduped).
      let name = (e.name || 'memory').slice(0, 64);
      let n = 2;
      while (nameTakenStmt.get(name)) name = `${(e.name || 'memory').slice(0, 60)}_${n++}`;

      const type = VALID_TYPES.has(e.entity_type) ? e.entity_type : 'other';
      const tags = Array.isArray(e.tags) && e.tags.length ? e.tags : ['imported'];
      insertStmt.run(name, type, content, JSON.stringify(tags), origin);
      created++;
    }
  });
  tx(entries);

  return { created, skipped };
}

/**
 * Export global memory in the canonical v1 format — the reverse of
 * parseMemoryExport, so a user can move their Artha memory elsewhere (or back
 * in). Grouped by category, oldest-first within each, dates from updated_at.
 */
export function exportMemories(): string {
  const db = getDb();
  const rows = db.prepare(
    `SELECT entity_type, content, updated_at FROM memory_entities
     WHERE project_id IS NULL ORDER BY updated_at ASC`
  ).all() as { entity_type: string; content: string; updated_at: number }[];

  const order = ['INSTRUCTIONS', 'IDENTITY', 'CAREER', 'PROJECTS', 'PREFERENCES', 'OTHER'];
  const buckets: Record<string, string[]> = {};
  for (const h of order) buckets[h] = [];
  for (const r of rows) {
    const header = TYPE_CATEGORY[r.entity_type] ?? 'OTHER';
    const date = new Date(r.updated_at * 1000).toISOString().slice(0, 10);
    buckets[header].push(`[${date}] - ${r.content}`);
  }

  const lines = ['=== ARTHA MEMORY IMPORT v1 ==='];
  for (const h of order) {
    lines.push(`[${h}]`);
    for (const l of buckets[h]) lines.push(l);
  }
  lines.push('=== END ===');
  return lines.join('\n');
}
