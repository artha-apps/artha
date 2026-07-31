/**
 * Cloud-embedding consent gate (Phase B, Slice 2 — enforces D-B1).
 *
 * A cloud embedder sends the user's indexed text (memories, documents) to a
 * third party. Artha is local-first, so this is OFF by default and can only be
 * turned on by an explicit, recorded consent. The invariant this module
 * guarantees: **`resolveEmbeddingProvider` never returns a non-local (cloud)
 * provider unless a consent record exists.** The gate lives in code, not just
 * UI, so a missing or corrupt setting fails closed to local.
 *
 * Pure with respect to an injected `db`; never throws on read.
 */
import {
  EmbeddingProvider, OllamaEmbeddingProvider, OpenAiEmbeddingProvider,
} from './embeddingProvider';

export interface CloudEmbeddingConfig {
  /** The user explicitly turned cloud embedding on. */
  enabled: boolean;
  /** llm_models row that supplies base_url + the sealed BYOK key. */
  modelId: string;
  /** Embedding model name (e.g. text-embedding-3-small) and its dimension. */
  model: string;
  dim: number;
  /** Unix seconds when consent was granted — evidence, not just a flag. */
  consentedAt: number;
}

export interface ConsentDb {
  prepare(sql: string): { get(...a: unknown[]): unknown; run(...a: unknown[]): unknown };
}

const SETTINGS_KEY = 'cloud_embedding';

function readSettings(db: ConsentDb): Record<string, unknown> {
  try {
    const row = db.prepare(`SELECT settings_json FROM users WHERE user_id='default'`).get() as
      { settings_json?: string } | undefined;
    return JSON.parse(row?.settings_json ?? '{}');
  } catch { return {}; }
}

/** The user's cloud-embedding config, or null if never consented. Fails closed
 *  (null) on any malformed/partial record — no accidental cloud routing. */
export function readCloudEmbeddingConfig(db: ConsentDb): CloudEmbeddingConfig | null {
  const raw = readSettings(db)[SETTINGS_KEY] as Partial<CloudEmbeddingConfig> | undefined;
  if (!raw || raw.enabled !== true) return null;
  if (typeof raw.modelId !== 'string' || !raw.modelId) return null;
  if (typeof raw.model !== 'string' || !raw.model) return null;
  if (typeof raw.dim !== 'number' || raw.dim <= 0) return null;
  if (typeof raw.consentedAt !== 'number') return null;
  return { enabled: true, modelId: raw.modelId, model: raw.model, dim: raw.dim, consentedAt: raw.consentedAt };
}

/** Record explicit consent + config. Callers MUST only invoke this after the
 *  user has been shown that their indexed text will be sent to the provider. */
export function grantCloudEmbeddingConsent(
  db: ConsentDb,
  cfg: { modelId: string; model: string; dim: number; consentedAt: number },
): void {
  const settings = readSettings(db);
  settings[SETTINGS_KEY] = { enabled: true, ...cfg } satisfies CloudEmbeddingConfig;
  db.prepare(`UPDATE users SET settings_json=? WHERE user_id='default'`).run(JSON.stringify(settings));
}

/** Turn cloud embedding back off. */
export function revokeCloudEmbeddingConsent(db: ConsentDb): void {
  const settings = readSettings(db);
  delete settings[SETTINGS_KEY];
  db.prepare(`UPDATE users SET settings_json=? WHERE user_id='default'`).run(JSON.stringify(settings));
}

/** How a cloud provider's key is opened. Injected so the resolver stays testable
 *  without the whole llm/client + keychain stack. */
export type KeyOpener = (db: ConsentDb, modelId: string) => { baseUrl: string; apiKey: string } | null;

/**
 * Resolve the embedder to use. Returns the LOCAL Ollama embedder by default.
 * Returns a cloud embedder ONLY when (1) a valid consent record exists AND
 * (2) its BYOK model row resolves to a base URL + key. Any gap → local. This is
 * the enforced D-B1 boundary: no consent, no cloud, no text off-device.
 */
export function resolveEmbeddingProvider(db: ConsentDb, openKey: KeyOpener): EmbeddingProvider {
  const local = new OllamaEmbeddingProvider();
  const cfg = readCloudEmbeddingConfig(db);
  if (!cfg) return local; // fail closed to local
  const creds = openKey(db, cfg.modelId);
  if (!creds || !creds.baseUrl) return local; // misconfigured → local, never leak
  return new OpenAiEmbeddingProvider(cfg.model, cfg.dim, creds.baseUrl, creds.apiKey);
}
