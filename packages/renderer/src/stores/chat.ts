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
}

/** Top-level view selector. Each value maps to a panel mounted under <main>
 *  in App.tsx. */
export type ActiveView = 'chat' | 'models' | 'mcp' | 'skills' | 'web' | 'rag' | 'provenance' | 'timetravel' | 'bundles' | 'router' | 'artifacts' | 'marketplace' | 'memory' | 'ide' | 'settings';

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
  activeWorkflowId: string | null;
  activeSkill: ActiveSkillBadge | null;
  pendingAttachments: MessageAttachment[];

  // Actions
  setSessions: (s: Session[]) => void;
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
  setStreaming: (streaming: boolean) => void;
  setActiveWorkflowId: (id: string | null) => void;
  setActiveSkill: (skill: ActiveSkillBadge | null) => void;
}

export const useChatStore = create<ChatState>((set, get) => ({
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
  activeWorkflowId: null,
  activeSkill: null,
  pendingAttachments: [],

  setSessions: (sessions) => set({ sessions }),
  // Switching sessions clears ALL in-flight state, including isStreaming — so a
  // stuck stream from a failed send never bleeds into the new session.
  setActiveSession: (id) => set({
    activeSessionId: id, messages: [], streamingContent: '',
    isStreaming: false, executionLog: [], pendingToolEvents: [],
    pendingCitations: [], activeWorkflowId: null, activeSkill: null,
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
  setActiveView: (view) => set({ activeView: view }),
  setStreaming: (streaming) => set({ isStreaming: streaming }),
  setActiveWorkflowId: (id) => set({ activeWorkflowId: id }),
  setActiveSkill: (skill) => set({ activeSkill: skill }),
}));
