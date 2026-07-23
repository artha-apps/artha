/**
 * Artha Workflow Bundles — portable, signed packages that capture a complete
 * agent run so another Artha install can inspect its steps, receipts and
 * artifacts. (There is no automated replay engine — this is a shareable,
 * inspectable record, not a re-execution.)
 *
 * Format: `.artha-bundle` = gzip-compressed JSON with this shape:
 *   {
 *     schema: 'artha-bundle/v1',
 *     manifest: {
 *       bundleId, exportedAt, prompt, model, sessionTitle,
 *       mcpServers: [{name, uri}],
 *       goldenContentHash,        // sha256 of golden artifact (if any)
 *       contentHashSignature      // hash of manifest fields
 *     },
 *     run: { goal, steps: [...] },          // condensed agent_steps
 *     artifacts: { '<filename>': '<base64>' }  // optional doc + receipt
 *   }
 */
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as zlib from 'zlib';
import { getDb } from '../db/schema';

/** Version sentinel — incremented only on breaking schema changes. */
export const BUNDLE_SCHEMA = 'artha-bundle/v1';

export interface BundleManifest {
  bundleId: string;
  exportedAt: string;
  /** The original user prompt that triggered the agent run. */
  prompt: string;
  /** The Ollama/cloud model name used during the run. */
  model: string;
  sessionTitle: string;
  /** MCP servers that were active when the run executed. */
  mcpServers: { name: string; uri: string }[];
  /** SHA-256 of the golden artifact file, or null if no doc was attached. */
  goldenContentHash: string | null;
  /** SHA-256 over the stable manifest fields — lets importers detect tampering. */
  signature: string;
}

export interface Bundle {
  schema: typeof BUNDLE_SCHEMA;
  manifest: BundleManifest;
  run: { goal: string; steps: { idx: number; kind: string; payload: unknown }[] };
  /** Keyed by filename; values are base64-encoded file bytes. */
  artifacts: Record<string, string>;
}

/** Deterministic SHA-256 over the manifest fields a verifier needs to trust:
 *  the prompt, model, MCP server list, and the golden content hash. Anything
 *  outside those fields (the run trace, artifact bytes) is excluded so the
 *  signature stays stable under display-only edits. */
function signManifest(m: Omit<BundleManifest, 'signature'>): string {
  const stable = JSON.stringify({
    bundleId: m.bundleId, prompt: m.prompt, model: m.model,
    goldenContentHash: m.goldenContentHash, mcpServers: m.mcpServers,
  });
  return crypto.createHash('sha256').update(stable).digest('hex');
}

// ── Export ───────────────────────────────────────────────────────────────────

/** `runId` selects which agent run to bundle; `docId` (if given) attaches the
 *  generated artifact + its receipt as the "golden output" the importer can
 *  later diff against to detect drift. */
export interface ExportArgs {
  runId: string;
  outPath: string;
  /** Optional doc id to attach the artifact + receipt as golden output. */
  docId?: string;
}

/** Read a run + its steps from SQLite, package any attached artifact as base64,
 *  sign the manifest, gzip the JSON, and write a `.artha-bundle` file. */
export async function exportBundle(args: ExportArgs): Promise<{ bundleId: string; outPath: string; size: number }> {
  const db = getDb();
  const run = db.prepare(`
    SELECT r.run_id, r.session_id, r.goal, r.model, s.title AS session_title
    FROM agent_runs r LEFT JOIN chat_sessions s ON s.session_id = r.session_id
    WHERE r.run_id = ?
  `).get(args.runId) as { run_id: string; session_id: string; goal: string; model: string; session_title: string | null } | undefined;
  if (!run) throw new Error(`Run not found: ${args.runId}`);

  const steps = db.prepare(`
    SELECT idx, kind, payload FROM agent_steps
    WHERE run_id = ? ORDER BY idx ASC
  `).all(args.runId) as { idx: number; kind: string; payload: string }[];

  const mcpRows = db.prepare(`SELECT name, mcp_server_uri FROM tools WHERE mcp_server_uri IS NOT NULL`).all() as { name: string; mcp_server_uri: string }[];

  let goldenContentHash: string | null = null;
  const artifacts: Record<string, string> = {};
  if (args.docId) {
    const doc = db.prepare(`SELECT file_path, receipt_path, content_hash FROM generated_documents WHERE doc_id=?`).get(args.docId) as { file_path: string; receipt_path: string | null; content_hash: string } | undefined;
    if (doc) {
      goldenContentHash = doc.content_hash;
      if (fs.existsSync(doc.file_path)) {
        artifacts[path.basename(doc.file_path)] = fs.readFileSync(doc.file_path).toString('base64');
      }
      if (doc.receipt_path && fs.existsSync(doc.receipt_path)) {
        artifacts[path.basename(doc.receipt_path)] = fs.readFileSync(doc.receipt_path).toString('base64');
      }
    }
  }

  const bundleId = crypto.randomUUID();
  const manifestCore = {
    bundleId,
    exportedAt: new Date().toISOString(),
    prompt: run.goal,
    model: run.model,
    sessionTitle: run.session_title ?? '',
    // Strip any inline ENV:KEY=value tokens so a credential can never travel in
    // a shared/signed bundle. Stored URIs are normally already clean (secrets
    // live encrypted in credentials_enc); this is belt-and-suspenders for any
    // row that predates the scrub migration.
    mcpServers: mcpRows.map(r => ({ name: r.name, uri: r.mcp_server_uri.replace(/(^|\s)ENV:[^\s]+/g, '').trim() })),
    goldenContentHash,
  };
  const manifest: BundleManifest = { ...manifestCore, signature: signManifest(manifestCore) };

  const bundle: Bundle = {
    schema: BUNDLE_SCHEMA,
    manifest,
    run: {
      goal: run.goal,
      steps: steps.map(s => ({ idx: s.idx, kind: s.kind, payload: safeParse(s.payload) })),
    },
    artifacts,
  };

  const json = JSON.stringify(bundle);
  const gz = zlib.gzipSync(Buffer.from(json));
  fs.writeFileSync(args.outPath, gz);

  return { bundleId, outPath: args.outPath, size: gz.length };
}

// ── Import / verify ──────────────────────────────────────────────────────────

/** Returned to the renderer after a bundle is imported. `signatureValid=false`
 *  means the manifest was tampered with; `missingMcpServers` lists tools the
 *  recipient would install to reproduce the same tool setup. */
export interface ImportResult {
  bundleId: string;
  manifest: BundleManifest;
  signatureValid: boolean;
  stepCount: number;
  artifactNames: string[];
  /** Entries rejected by the zip-slip guard (traversal / unsafe names).
   *  Surfaced so a tampered bundle is visible, never silently partial. */
  skippedArtifacts: string[];
  /** MCP servers required but not currently installed locally. */
  missingMcpServers: { name: string; uri: string }[];
  /** Extracted-to directory (artifacts + bundle.json). */
  extractedDir: string;
}

/** Decompress + verify a `.artha-bundle`, extract the artifacts to
 *  `importsDir/<bundleId>/`, and return a manifest/signature report. Does
 *  *not* execute or install anything — that's left to the user via the UI. */
/**
 * Reduce an untrusted archive entry name to a safe basename.
 * Returns '' when nothing safe remains (pure traversal, empty, dotfile-only,
 * or a Windows drive/UNC prefix), which the caller treats as "reject".
 */
export function sanitizeEntryName(name: string): string {
  if (typeof name !== 'string') return '';
  // Take the last segment under BOTH separators so Windows-style names can't
  // slip through a POSIX-only basename() on macOS/Linux.
  const last = name.split(/[/\\]/).pop() ?? '';
  const cleaned = last.replace(/^\.+/, '').replace(/[\u0000-\u001f]/g, '').trim();
  if (!cleaned || cleaned === '.' || cleaned === '..') return '';
  if (/^[a-zA-Z]:/.test(cleaned)) return '';
  return cleaned;
}

export async function importBundle(bundlePath: string, importsDir: string): Promise<ImportResult> {
  const raw = fs.readFileSync(bundlePath);
  const json = zlib.gunzipSync(raw).toString('utf-8');
  const bundle = JSON.parse(json) as Bundle;
  if (bundle.schema !== BUNDLE_SCHEMA) throw new Error(`Unknown bundle schema: ${bundle.schema}`);

  const { signature, ...core } = bundle.manifest;
  const expected = signManifest(core);
  const signatureValid = signature === expected;

  // The bundleId comes from the bundle itself, so it is untrusted too.
  const safeBundleId = sanitizeEntryName(bundle.manifest.bundleId) || 'bundle';
  const extractedDir = path.join(importsDir, safeBundleId);
  fs.mkdirSync(extractedDir, { recursive: true });
  fs.writeFileSync(path.join(extractedDir, 'bundle.json'), JSON.stringify(bundle, null, 2));

  // ZIP-SLIP GUARD. Artifact names are attacker-controlled: a bundle entry
  // named `../../../../.zshrc` previously wrote OUTSIDE extractedDir, and it
  // did so *before* the integrity check ran. Every name is now flattened to a
  // basename, path separators and traversal segments are stripped, and the
  // resolved destination is re-checked against the extraction root before any
  // write. Rejected entries are reported, never silently dropped.
  const skippedArtifacts: string[] = [];
  const resolvedRoot = path.resolve(extractedDir) + path.sep;
  for (const [name, b64] of Object.entries(bundle.artifacts)) {
    const safeName = sanitizeEntryName(name);
    if (!safeName) { skippedArtifacts.push(name); continue; }
    const dest = path.resolve(extractedDir, safeName);
    if (!dest.startsWith(resolvedRoot)) { skippedArtifacts.push(name); continue; }
    try {
      fs.writeFileSync(dest, Buffer.from(b64, 'base64'));
    } catch {
      skippedArtifacts.push(name);
    }
  }

  const db = getDb();
  // Strip "ENV:VAR_NAME " prefixes before comparing so env-substituted URIs
  // still match the stored literal in both the bundle and the local tools table.
  const installed = new Set(
    (db.prepare(`SELECT mcp_server_uri FROM tools WHERE mcp_server_uri IS NOT NULL`).all() as { mcp_server_uri: string }[])
      .map(r => r.mcp_server_uri.replace(/^ENV:[^\s]+ /g, '').trim())
  );
  const missing = bundle.manifest.mcpServers.filter(s =>
    !installed.has(s.uri.replace(/^ENV:[^\s]+ /g, '').trim())
  );

  return {
    bundleId: bundle.manifest.bundleId,
    manifest: bundle.manifest,
    signatureValid,
    stepCount: bundle.run.steps.length,
    artifactNames: Object.keys(bundle.artifacts).filter(n => !skippedArtifacts.includes(n)),
    skippedArtifacts,
    missingMcpServers: missing,
    extractedDir,
  };
}

/** Try to JSON-parse a value; return the raw string on failure so agent_steps
 *  with non-JSON payloads are still included in the bundle verbatim. */
function safeParse(s: string): unknown {
  try { return JSON.parse(s); } catch { return s; }
}
