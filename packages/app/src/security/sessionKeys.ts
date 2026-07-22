/**
 * Session-only credential store — process-memory holding for API keys the
 * user chose NOT to persist (no trustworthy OS keychain available).
 *
 * The DB row stores only the `v1:session` sentinel (zero secret material);
 * the real key lives here and dies with the process. After a restart the
 * sentinel resolves to nothing and the caller surfaces an honest
 * "re-enter your key" state — that is the designed behaviour, not a bug.
 *
 * Never serialized, never logged, never sent to the renderer.
 */

const store = new Map<string, string>();

export function setSessionKey(modelId: string, key: string): void {
  if (modelId && key) store.set(modelId, key);
}

export function getSessionKey(modelId: string): string | undefined {
  return store.get(modelId);
}

export function deleteSessionKey(modelId: string): void {
  store.delete(modelId);
}

/** Test hook + defensive wipe (e.g. on explicit user lock-down). */
export function clearSessionKeys(): void {
  store.clear();
}
