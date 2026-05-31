/**
 * Chat store — Zustand. Manages sessions, messages, streaming state,
 * execution log, and planning mode approval.
 */
import { create } from 'zustand';

/** A web page surfaced by `web_search` / `web_fetch`. Rendered as a citation
 *  chip under the assistant bubble that produced it. */
export interface Citation {
  url: string;
  title: string;
  fetched_at: number;
}

/** Image/file attachment on a user message — stored as base64 for in-memory
 *  display; never persisted to SQLite (too large). */
export interface MessageAttachment {
  name: string;
  mime: string;
  data: string; // base64
}

/** Chat bubble. `senderType='tool'` is reserved — current code stores tool
 *  output on the assistant message via `toolEvents` rather than a separate
 *  bubble, which keeps the visual thread tidy. */
export interface Message {
  id: string;
  sessionId: string;
  senderType: 'user' | 'agent' | 'tool';
  content: string;
  timestamp: number;
  toolCalls?: unknown[];
  toolOutputs?: unknown[];
  toolEvents?: ToolCallEvent[];
  citations?: Citation[];
  attachments?: MessageAttachment[];
}

/** One entry in the live execution log. Mirrors the orchestrator's
 *  `agent:toolCall` event payload. */
export interface ToolCallEvent {
  type: 'step_start' | 'tool_invoke' | 'tool_result';
  name?: string;
  args?: string;
  result?: string;
  step?: unknown;
}

/** A plan the orchestrator paused on — drives the PlanApproval modal. */
export interface AgentPlan {
  workflowId: string;
  goal: string;
  steps: { index: number; description: string; toolName?: string }[];
  requiresApproval: boolean;
}

/** A clarification request the orchestrator paused on — drives the ClarificationModal. */
export interface ClarifyRequest {
  workflowId: string;
  sessionId: string;
  goal: string;
  questions: string[];
}

/** Sidebar row shape. Mirrors `chat_sessions` columns we actually render. */
export interface Session {
  session_id: string;
  title: string;
  last_activity: number;
  project_id?: string | null;
}

/** A folder or file attached to the active chat. The agent is made aware of
 *  these and hard-sandboxed to them (see `session_scopes`). */
export interface SessionScope {
  scope_id: string;
  session_id: string;
  path: string;
  kind: 'folder' | 'file';
  rag_index_id: string | null;
  added_at: number;
}

/** Top-level view selector. `'chat'` puts the canvas in tab mode (driven by
 *  `activeTab`); every other value is a settings panel that, when set, opens
 *  the Workspace Settings modal scoped to that panel. Keeping the union lets
 *  legacy call-sites (`setActiveView('models')`) deep-link into the modal
 *  without changing their signature. */
export type ActiveView = 'chat' | 'models' | 'mcp' | 'skills' | 'web' | 'rag' | 'provenance' | 'timetravel' | 'bundles' | 'router' | 'artifacts' | 'marketplace' | 'memory' | 'ide' | 'cloud' | 'lan' | 'desktop' | 'team' | 'scheduler' | 'settings' | 'license';

/** Three top-level rooms inside the Chat view. Tab selection persists in
 *  localStorage so reloads land where you left off. */
export type ActiveTab = 'chat' | 'workflows' | 'code';

/** A project as exposed by the `projects:*` IPC. Mirrors the `projects`
 *  table on disk (created by migrations v3→v6). */
export interface Project {
  project_id: string;
  name: string;
  root_path: string;
  rag_index_id: string | null;
  summary: string | null;
  created_at: number;
}

/** The skill the orchestrator matched/loaded for the in-flight workflow.
 *  Drives the small "Skill: …" badge in the composer. Cleared on stream end. */
export interface ActiveSkillBadge {
  slug: string;
  name: string;
  icon: string;
}

/** Single source of truth for the chat surface. `pendingToolEvents` and
 *  `pendingCitations` accumulate during a streaming response and are folded
 *  onto the final assistant message in `finaliseStream()`. */
interface ChatState {
  sessions: Session[];
  activeSessionId: string | null;
  messages: Message[];
  streamingContent: string;
  isStreaming: boolean;
  executionLog: ToolCallEvent[];
  pendingPlan: AgentPlan | null;
  pendingClarify: ClarifyRequest | null;
  pendingToolEvents: ToolCallEvent[];
  pendingCitations: Citation[];
  activeView: ActiveView;
  /** Which top-level tab is showing inside the Chat view. Ignored when
   *  `activeView !== 'chat'` (because a settings modal is open). */
  activeTab: ActiveTab;
  /** Workspace Settings modal — open state + which panel to scroll to. The
   *  panel id matches the legacy `ActiveView` value so old call-sites keep
   *  working: `setActiveView('models')` opens the modal to Models. */
  workspaceSettingsOpen: boolean;
  workspaceSettingsSection: Exclude<ActiveView, 'chat'> | null;
  /** Active project context. `null` = "no project" (general chat). Drives
   *  the sidebar switcher, the scope badge, and `@project` autocomplete. */
  activeProjectId: string | null;
  /** All projects loaded once on mount + refreshed when one is created. */
  projects: Project[];
  activeWorkflowId: string | null;
  activeSkill: ActiveSkillBadge | null;
  pendingAttachments: MessageAttachment[];
  scopes: SessionScope[];
  /** Set of FeatureGuide keys the user has dismissed. Persisted to
   *  localStorage so guides don't re-appear after a reload. */
  seenGuides: Set<string>;

  // Actions
  setSessions: (s: Session[]) => void;
  setScopes: (scopes: SessionScope[]) => void;
  setActiveSession: (id: string) => void;
  setMessages: (msgs: Message[]) => void;
  addUserMessage: (sessionId: string, content: string, attachments?: MessageAttachment[]) => void;
  setPendingAttachments: (a: MessageAttachment[]) => void;
  appendToken: (token: string) => void;
  resetStream: () => void;
  finaliseStream: () => void;
  addToolEvent: (ev: ToolCallEvent) => void;
  addCitations: (citations: Citation[]) => void;
  setPendingPlan: (plan: AgentPlan | null) => void;
  setPendingClarify: (req: ClarifyRequest | null) => void;
  setActiveView: (view: ActiveView) => void;
  setActiveTab: (tab: ActiveTab) => void;
  /** Open the Workspace Settings modal, optionally scrolled to a section. */
  openWorkspaceSettings: (section?: Exclude<ActiveView, 'chat'> | null) => void;
  /** Close the modal and return to the Chat view. */
  closeWorkspaceSettings: () => void;
  setActiveProjectId: (id: string | null) => void;
  /** Pick a project AND auto-land on its most recent session (or empty
   *  state if there are none). Returns the picked session id, so the caller
   *  can hydrate messages over IPC. */
  selectProject: (id: string | null) => string | null;
  setProjects: (projects: Project[]) => void;
  setStreaming: (streaming: boolean) => void;
  setActiveWorkflowId: (id: string | null) => void;
  setActiveSkill: (skill: ActiveSkillBadge | null) => void;
  /** Mark a feature guide as seen — collapses the inline card. */
  dismissGuide: (featureKey: string) => void;
  /** Re-open a feature guide (called from the panel header "?" button). */
  reopenGuide: (featureKey: string) => void;
}

const SEEN_GUIDES_KEY = 'artha.seenGuides.v1';
const ACTIVE_TAB_KEY = 'artha.activeTab.v1';
const ACTIVE_PROJECT_KEY = 'artha.activeProjectId.v1';

function loadSeenGuides(): Set<string> {
  if (typeof window === 'undefined') return new Set();
  try {
    const raw = window.localStorage.getItem(SEEN_GUIDES_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? new Set(parsed) : new Set();
  } catch {
    return new Set();
  }
}

function saveSeenGuides(set: Set<string>) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(SEEN_GUIDES_KEY, JSON.stringify([...set]));
  } catch {
    /* quota exceeded or storage blocked — non-fatal */
  }
}

/** Read the persisted tab choice; default to 'chat' for new users. */
function loadActiveTab(): ActiveTab {
  if (typeof window === 'undefined') return 'chat';
  try {
    const raw = window.localStorage.getItem(ACTIVE_TAB_KEY);
    if (raw === 'chat' || raw === 'workflows' || raw === 'code') return raw;
  } catch { /* fall through */ }
  return 'chat';
}

function saveActiveTab(tab: ActiveTab) {
  if (typeof window === 'undefined') return;
  try { window.localStorage.setItem(ACTIVE_TAB_KEY, tab); } catch { /* non-fatal */ }
}

/** Read the persisted project pick; null = "no project (general)". */
function loadActiveProjectId(): string | null {
  if (typeof window === 'undefined') return null;
  try { return window.localStorage.getItem(ACTIVE_PROJECT_KEY); } catch { return null; }
}

function saveActiveProjectId(id: string | null) {
  if (typeof window === 'undefined') return;
  try {
    if (id) window.localStorage.setItem(ACTIVE_PROJECT_KEY, id);
    else window.localStorage.removeItem(ACTIVE_PROJECT_KEY);
  } catch { /* non-fatal */ }
}

export const useChatStore = create<ChatState>((set) => ({
  // ── Initial state ──────────────────────────────────────────────────────────
  sessions: [],
  activeSessionId: null,
  messages: [],
  streamingContent: '',
  isStreaming: false,
  executionLog: [],
  pendingPlan: null,
  pendingClarify: null,
  pendingToolEvents: [],
  pendingCitations: [],
  activeView: 'chat',
  activeTab: loadActiveTab(),
  workspaceSettingsOpen: false,
  workspaceSettingsSection: null,
  activeProjectId: loadActiveProjectId(),
  projects: [],
  activeWorkflowId: null,
  activeSkill: null,
  pendingAttachments: [],
  scopes: [],
  seenGuides: loadSeenGuides(),

  // ── Actions ────────────────────────────────────────────────────────────────
  setSessions: (sessions) => set({ sessions }),
  setScopes: (scopes) => set({ scopes }),
  // Switching sessions clears ALL in-flight state, including isStreaming — so a
  // stuck stream from a failed send never bleeds into the new session. Scopes
  // are cleared too and reloaded for the new session by ChatWindow.
  setActiveSession: (id) => set({
    activeSessionId: id, messages: [], streamingContent: '',
    isStreaming: false, executionLog: [], pendingToolEvents: [],
    pendingCitations: [], activeWorkflowId: null, activeSkill: null,
    scopes: [],
  }),
  setMessages: (messages) => set({ messages }),

  addUserMessage: (sessionId, content, attachments) =>
    set((s) => ({
      messages: [...s.messages, {
        id: crypto.randomUUID(), sessionId, senderType: 'user', content,
        timestamp: Date.now(),
        attachments: attachments?.length ? attachments : undefined,
      }],
    })),

  setPendingAttachments: (a) => set({ pendingAttachments: a }),

  // Streaming token from the orchestrator. We set isStreaming here too so
  // tool-only responses (no text emitted before tools) still flip the UI
  // into the streaming state via the first token they do emit.
  appendToken: (token) =>
    set((s) => ({ streamingContent: s.streamingContent + token, isStreaming: true })),

  // Clear the in-flight streamed text without ending the stream. Used when the
  // orchestrator decides a turn's live preamble should be suppressed (a tool
  // step) or replaced (a verified summary).
  resetStream: () => set({ streamingContent: '' }),

  // Called once on agent:streamEnd. Folds pending content + tool events +
  // citations into a single assistant message and resets the streaming state.
  // No-op (other than the reset) when the stream produced nothing visible.
  finaliseStream: () =>
    set((s) => {
      const hasContent = s.streamingContent.trim().length > 0;
      const hasToolEvents = s.pendingToolEvents.length > 0;
      const hasCitations = s.pendingCitations.length > 0;
      // Only skip if there's truly nothing to show and no session
      if ((!hasContent && !hasToolEvents) || !s.activeSessionId) {
        return { streamingContent: '', isStreaming: false, pendingToolEvents: [], pendingCitations: [], activeWorkflowId: null, activeSkill: null };
      }
      return {
        messages: [...s.messages, {
          id: crypto.randomUUID(), sessionId: s.activeSessionId,
          senderType: 'agent' as const, content: s.streamingContent,
          timestamp: Date.now(),
          toolEvents: hasToolEvents ? [...s.pendingToolEvents] : undefined,
          citations: hasCitations ? [...s.pendingCitations] : undefined,
        }],
        streamingContent: '',
        isStreaming: false,
        pendingToolEvents: [],
        pendingCitations: [],
        activeWorkflowId: null,
        activeSkill: null,
      };
    }),

  // Tool events fan out to two places: the persistent right-rail execution log
  // and the per-message pending list (so they get folded onto the bubble that
  // produced them in finaliseStream).
  addToolEvent: (ev) =>
    set((s) => ({
      executionLog: [...s.executionLog, ev],
      pendingToolEvents: [...s.pendingToolEvents, ev],
    })),

  addCitations: (citations) =>
    set((s) => {
      // De-dupe by URL across pending + incoming
      const seen = new Set(s.pendingCitations.map(c => c.url));
      const fresh = citations.filter(c => !seen.has(c.url));
      return { pendingCitations: [...s.pendingCitations, ...fresh] };
    }),

  setPendingPlan: (plan) => set({ pendingPlan: plan }),
  setPendingClarify: (req) => set({ pendingClarify: req }),
  // Legacy view setter. 'chat' returns to the tabbed canvas; anything else is
  // a settings panel id and routes to the Workspace Settings modal so old
  // call-sites keep working without refactor.
  setActiveView: (view) => {
    if (view === 'chat') {
      set({ activeView: 'chat', workspaceSettingsOpen: false, workspaceSettingsSection: null });
    } else {
      set({ activeView: view, workspaceSettingsOpen: true, workspaceSettingsSection: view });
    }
  },
  setActiveTab: (tab) => {
    saveActiveTab(tab);
    set({ activeTab: tab });
  },
  openWorkspaceSettings: (section = null) =>
    set({ workspaceSettingsOpen: true, workspaceSettingsSection: section, activeView: section ?? 'settings' }),
  closeWorkspaceSettings: () =>
    set({ workspaceSettingsOpen: false, workspaceSettingsSection: null, activeView: 'chat' }),
  setActiveProjectId: (id) => {
    saveActiveProjectId(id);
    set({ activeProjectId: id });
  },
  // Pick a project AND land on its most recent session (or empty if none).
  // Loads scopes for the picked session via the same path Sidebar.openSession
  // uses, so the user sees the right sandbox immediately.
  // Returns the picked session id (or null) so the caller can drive any
  // further IPC (message hydration etc.) without re-walking the array.
  // The use of `get()` (Zustand's selector) here breaks the otherwise
  // circular type chain (`useChatStore` → action → `useChatStore`) that
  // would force an explicit annotation on the action signature.
  selectProject: (id): string | null => {
    saveActiveProjectId(id);
    const all: Session[] = useChatStore.getState().sessions;
    const candidates: Session[] = id === null
      ? all.filter((s: Session) => !s.project_id)
      : all.filter((s: Session) => s.project_id === id);
    // sessions:list comes back sorted by last_activity DESC, so [0] is "most recent".
    const next: Session | null = candidates[0] ?? null;
    set({
      activeProjectId: id,
      activeSessionId: next?.session_id ?? null,
      messages: [],
      streamingContent: '',
      isStreaming: false,
      executionLog: [],
      pendingToolEvents: [],
      pendingCitations: [],
      activeWorkflowId: null,
      activeSkill: null,
      scopes: [],
    });
    return next?.session_id ?? null;
  },
  setProjects: (projects) => set({ projects }),
  setStreaming: (streaming) => set({ isStreaming: streaming }),
  setActiveWorkflowId: (id) => set({ activeWorkflowId: id }),
  setActiveSkill: (skill) => set({ activeSkill: skill }),

  dismissGuide: (featureKey) =>
    set((s) => {
      const next = new Set(s.seenGuides);
      next.add(featureKey);
      saveSeenGuides(next);
      return { seenGuides: next };
    }),

  reopenGuide: (featureKey) =>
    set((s) => {
      if (!s.seenGuides.has(featureKey)) return s;
      const next = new Set(s.seenGuides);
      next.delete(featureKey);
      saveSeenGuides(next);
      return { seenGuides: next };
    }),
}));
