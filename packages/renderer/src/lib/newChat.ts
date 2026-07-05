/**
 * createChat — the ONE way to start a new chat session from the renderer.
 *
 * Previously four surfaces (Sidebar, ProjectHome, CommandPalette, SkillsPanel
 * rerun) each re-implemented this flow and disagreed on whether the project's
 * root folder gets attached as a scope — so "the same action" produced chats
 * with different filesystem sandboxes. Centralised here: a project chat ALWAYS
 * starts with the project root attached (that's what "inside this project"
 * means); a general chat (null projectId) starts unscoped.
 *
 * App.tsx's boot-time fallback (create a general session when none exist) is
 * intentionally NOT routed through here — it must not steal the persisted
 * active tab on launch.
 */
import { useChatStore } from '../stores/chat';

/** Create + activate a chat in `projectId` (null = General). Returns the new
 *  session id so callers can chain (e.g. SkillsPanel rerun sends a message). */
export async function createChat(projectId: string | null): Promise<string> {
  const store = useChatStore.getState();
  const session = await window.artha.sessions.create(projectId);

  // Auto-attach the project root so the agent's sandbox + context injection
  // align with the visible project chip. Idempotent on the IPC; non-fatal —
  // a chat with a missing root scope still works, just context-poorer.
  if (projectId) {
    const proj = store.projects.find(p => p.project_id === projectId);
    if (proj) {
      await window.artha.scopes
        .addFolderPath(session.session_id, proj.root_path)
        .catch(() => { /* non-fatal */ });
    }
  }

  store.setSessions(await window.artha.sessions.list());
  store.setActiveSession(session.session_id);
  store.setMessages([]);
  store.setActiveTab('chat');
  return session.session_id;
}
