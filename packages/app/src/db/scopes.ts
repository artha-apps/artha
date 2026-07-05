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
import * as path from 'path';
import * as crypto from 'crypto';
import { getDb } from './schema';
import { getDefaultRagIndexer } from '../rag/indexer';

/**
 * Minimal scope descriptor passed to the filesystem sandbox and RAG search.
 * Carries only what those subsystems need: the path and whether it's a folder
 * (subtree access) or a single file (exact-path access).
 */
export interface ScopeRoot {
  path: string;
  kind: 'folder' | 'file';
}

/** Full DB row from `session_scopes`. Use `ScopeRoot` when you only need
 *  path + kind for sandbox / RAG purposes. */
export interface SessionScope {
  scope_id: string;
  session_id: string;
  path: string;
  kind: 'folder' | 'file';
  /** Non-null only for kind='folder' scopes that have a RAG index. */
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
 *  so a scoped chat retrieves only from its own folders — search is confined to
 *  the folders the user approved for this chat. Returns an empty array when the
 *  chat has no folders attached, which the caller treats as "search every
 *  index". */
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

/**
 * One workspace (projects row + RAG index) per folder path — find it or create
 * it, kicking off a background index build for new/index-less folders. Shared
 * by the scopes IPC handlers and Context Pack application so every folder
 * attachment goes through the same dedupe + auto-index path.
 * (Moved here from ipc/handlers.ts so non-IPC callers can use it.)
 */
export function findOrCreateFolderWorkspace(rootPath: string): { projectId: string; ragIndexId: string } {
  const db = getDb();
  const ragIndexer = getDefaultRagIndexer();
  const existing = db.prepare(`SELECT project_id, rag_index_id FROM projects WHERE root_path=? ORDER BY created_at ASC LIMIT 1`)
    .get(rootPath) as { project_id: string; rag_index_id: string | null } | undefined;
  if (existing) {
    let indexId = existing.rag_index_id;
    if (!indexId) {
      indexId = crypto.randomUUID();
      const name = path.basename(rootPath) || rootPath;
      db.prepare(`INSERT INTO rag_indexes (index_id, name, directory_path) VALUES (?,?,?)`).run(indexId, `Folder: ${name}`, rootPath);
      db.prepare(`UPDATE projects SET rag_index_id=? WHERE project_id=?`).run(indexId, existing.project_id);
      ragIndexer.buildIndex(indexId, rootPath).catch(err => console.warn('[Artha] folder index build failed:', err));
    }
    return { projectId: existing.project_id, ragIndexId: indexId };
  }
  const name = path.basename(rootPath) || rootPath;
  const projectId = crypto.randomUUID();
  const indexId = crypto.randomUUID();
  db.prepare(`INSERT INTO rag_indexes (index_id, name, directory_path) VALUES (?,?,?)`).run(indexId, `Folder: ${name}`, rootPath);
  db.prepare(`INSERT INTO projects (project_id, name, root_path, rag_index_id) VALUES (?,?,?,?)`).run(projectId, name, rootPath, indexId);
  // Build in the background — embedding a large folder is slow and we don't
  // want to block the caller returning.
  ragIndexer.buildIndex(indexId, rootPath).catch(err => console.warn('[Artha] folder index build failed:', err));
  return { projectId, ragIndexId: indexId };
}
