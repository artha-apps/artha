/**
 * Per-chat scope helpers.
 *
 * A "scope" is a folder or individual file attached to a single chat session
 * (table `session_scopes`). Scopes do two jobs:
 *   1. Context — the orchestrator injects the attached paths (and inlines small
 *      files) into the system prompt so the agent is aware of them.
 *   2. Sandbox — the filesystem tools confine all reads/writes to these paths
 *      (folders = subtree, files = the exact file). See `tools/filesystem.ts`.
 *
 * Folder scopes mirror a row in `projects` (deduped by absolute path) so a
 * folder keeps its auto-built RAG index + cross-session memory even when opened
 * from several chats. To avoid changing the memory/summary machinery — which is
 * keyed on `chat_sessions.project_id` — we keep that column pointing at the
 * chat's *primary* (first) folder workspace via `recomputePrimaryProject`.
 */
import { getDb } from './schema';

export interface ScopeRoot {
  path: string;
  kind: 'folder' | 'file';
}

export interface SessionScope {
  scope_id: string;
  session_id: string;
  path: string;
  kind: 'folder' | 'file';
  rag_index_id: string | null;
  added_at: number;
}

/** All scopes for a chat, oldest first (so the first folder is the primary). */
export function getSessionScopes(sessionId: string): SessionScope[] {
  return getDb()
    .prepare(`SELECT * FROM session_scopes WHERE session_id=? ORDER BY added_at ASC, rowid ASC`)
    .all(sessionId) as SessionScope[];
}

/** The allowed-root set handed to the filesystem sandbox. Empty array ⇒ the
 *  chat has no scopes, and the tools fall back to home-directory behaviour. */
export function getSessionAllowedRoots(sessionId: string): ScopeRoot[] {
  return getSessionScopes(sessionId).map(s => ({ path: s.path, kind: s.kind }));
}

/** The RAG index IDs for the chat's attached folders. Passed to `rag_search`
 *  so a scoped chat retrieves only from its own folders (Cowork-style: search
 *  is confined to the approved folders). Empty ⇒ search every index. */
export function getSessionRagIndexIds(sessionId: string): string[] {
  return getSessionScopes(sessionId)
    .filter(s => s.kind === 'folder' && s.rag_index_id)
    .map(s => s.rag_index_id as string);
}

/** The chat's primary folder = its first attached folder (the default output
 *  directory for generated docs, and the key for cross-session memory). Null
 *  when no folder is attached. */
export function getSessionPrimaryFolder(sessionId: string): string | null {
  const folder = getSessionScopes(sessionId).find(s => s.kind === 'folder');
  return folder ? folder.path : null;
}

/** Point `chat_sessions.project_id` at the primary folder's workspace so the
 *  existing memory + rolling-summary code (keyed on project_id) keeps working
 *  without change. Call after every scope add/remove. */
export function recomputePrimaryProject(sessionId: string): void {
  const db = getDb();
  const folder = getSessionScopes(sessionId).find(s => s.kind === 'folder');
  let projectId: string | null = null;
  if (folder) {
    const p = db
      .prepare(`SELECT project_id FROM projects WHERE root_path=? ORDER BY created_at ASC LIMIT 1`)
      .get(folder.path) as { project_id: string } | undefined;
    projectId = p?.project_id ?? null;
  }
  db.prepare(`UPDATE chat_sessions SET project_id=? WHERE session_id=?`).run(projectId, sessionId);
}
