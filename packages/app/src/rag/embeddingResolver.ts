/**
 * Main-process composition of the D-B1 consent gate with the real credential
 * stack (Phase B, Slice 2c). `embeddingConsent.ts` stays pure and injected;
 * this module supplies the concrete pieces: the app database and a KeyOpener
 * backed by `usableApiKey` (sealed BYOK keys, session keys, credential policy).
 *
 * Every failure path here returns null / the local embedder — a locked
 * keychain, expired session key, or deleted model row can never route indexed
 * text to a cloud endpoint by accident.
 */
import { getDb } from '../db/schema';
import { usableApiKey } from '../llm/client';
import { resolveEmbeddingProvider, type KeyOpener } from './embeddingConsent';
import type { EmbeddingProvider } from './embeddingProvider';

/**
 * Open the base URL + API key for a saved llm_models row. The base URL is
 * taken from the ROW, never from a caller-supplied value — same rule as the
 * probe path in handlers (security review H1): a compromised renderer must not
 * be able to pair a stored key with an attacker URL.
 */
export const openLlmModelKey: KeyOpener = (db, modelId) => {
  try {
    const row = db.prepare(`SELECT model_id, base_url, api_key FROM llm_models WHERE model_id=?`)
      .get(modelId) as { model_id: string; base_url: string; api_key: string | null } | undefined;
    if (!row?.base_url) return null;
    return { baseUrl: row.base_url, apiKey: usableApiKey(db, row.model_id, row.api_key) };
  } catch {
    // CredentialLockedError / SessionKeyExpiredError / DB failure → no cloud.
    return null;
  }
};

/** The embedder the app should use RIGHT NOW: local Ollama unless a valid
 *  cloud-embedding consent record resolves end-to-end (D-B1, fails closed). */
export function resolveActiveEmbedder(): EmbeddingProvider {
  return resolveEmbeddingProvider(getDb(), openLlmModelKey);
}
