/**
 * Chat store — Zustand. Manages sessions, messages, streaming state,
 * execution log, and planning mode approval.
 */
import { create } from 'zustand';

export interface Message {
  id: string;
  sessionId: string;
  senderType: 'user' | 'agent' | 'tool';
  content: string;
  timestamp: number;
  toolCalls?: unknown[];
  toolOutputs?: unknown[];
}

export interface ToolCallEvent {
  type: 'step_start' | 'tool_invoke' | 'tool_result';
  name?: string;
  args?: string;
  result?: string;
  step?: unknown;
}

export interface AgentPlan {
  workflowId: string;
  goal: string;
  steps: { index: number; description: string; toolName?: string }[];
  requiresApproval: boolean;
}

export interface Session {
  session_id: string;
  title: string;
  last_activity: number;
}

export type ActiveView = 'chat' | 'models' | 'mcp' | 'web' | 'rag' | 'router' | 'timetravel' | 'settings';

interface ChatState {
  sessions: Session[];
  activeSessionId: string | null;
  messages: Message[];
  streamingContent: string;
  isStreaming: boolean;
  executionLog: ToolCallEvent[];
  pendingPlan: AgentPlan | null;
  activeView: ActiveView;
  activeWorkflowId: string | null;

  // Actions
  setSessions: (s: Session[]) => void;
  setActiveSession: (id: string) => void;
  setMessages: (msgs: Message[]) => void;
  addUserMessage: (sessionId: string, content: string) => void;
  appendToken: (token: string) => void;
  finaliseStream: () => void;
  addToolEvent: (ev: ToolCallEvent) => void;
  setPendingPlan: (plan: AgentPlan | null) => void;
  setActiveView: (view: ActiveView) => void;
  setStreaming: (streaming: boolean) => void;
  setActiveWorkflowId: (id: string | null) => void;
}

export const useChatStore = create<ChatState>((set, get) => ({
  sessions: [],
  activeSessionId: null,
  messages: [],
  streamingContent: '',
  isStreaming: false,
  executionLog: [],
  pendingPlan: null,
  activeView: 'chat',
  activeWorkflowId: null,

  setSessions: (sessions) => set({ sessions }),
  setActiveSession: (id) => set({ activeSessionId: id, messages: [], streamingContent: '', executionLog: [] }),
  setMessages: (messages) => set({ messages }),

  addUserMessage: (sessionId, content) =>
    set((s) => ({
      messages: [...s.messages, {
        id: crypto.randomUUID(), sessionId, senderType: 'user', content,
        timestamp: Date.now(),
      }],
    })),

  appendToken: (token) =>
    set((s) => ({ streamingContent: s.streamingContent + token, isStreaming: true })),

  finaliseStream: () =>
    set((s) => {
      if (!s.streamingContent.trim() || !s.activeSessionId) {
        return { streamingContent: '', isStreaming: false, activeWorkflowId: null };
      }
      return {
        messages: [...s.messages, {
          id: crypto.randomUUID(), sessionId: s.activeSessionId,
          senderType: 'agent', content: s.streamingContent, timestamp: Date.now(),
        }],
        streamingContent: '',
        isStreaming: false,
        activeWorkflowId: null,
      };
    }),

  addToolEvent: (ev) =>
    set((s) => ({ executionLog: [...s.executionLog, ev] })),

  setPendingPlan: (plan) => set({ pendingPlan: plan }),
  setActiveView: (view) => set({ activeView: view }),
  setStreaming: (streaming) => set({ isStreaming: streaming }),
  setActiveWorkflowId: (id) => set({ activeWorkflowId: id }),
}));
