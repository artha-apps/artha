/**
 * Preload script — exposes a typed, safe bridge between the renderer (React)
 * and the Electron main process (Node.js). Never expose raw ipcRenderer.
 */
import { contextBridge, ipcRenderer } from 'electron';

export type ArthaAPI = typeof api;

const api = {
  // ── Agent ────────────────────────────────────────────────────────────────
  agent: {
    sendMessage: (sessionId: string, content: string) =>
      ipcRenderer.invoke('agent:sendMessage', sessionId, content),
    cancelTask: (workflowId: string) =>
      ipcRenderer.invoke('agent:cancelTask', workflowId),
    onToken: (cb: (token: string) => void) => {
      ipcRenderer.on('agent:token', (_e, t) => cb(t));
      return () => ipcRenderer.removeAllListeners('agent:token');
    },
    onToolCall: (cb: (call: unknown) => void) => {
      ipcRenderer.on('agent:toolCall', (_e, c) => cb(c));
      return () => ipcRenderer.removeAllListeners('agent:toolCall');
    },
    onPlanReady: (cb: (plan: unknown) => void) => {
      ipcRenderer.on('agent:planReady', (_e, p) => cb(p));
      return () => ipcRenderer.removeAllListeners('agent:planReady');
    },
    approvePlan: (workflowId: string, approved: boolean) =>
      ipcRenderer.invoke('agent:approvePlan', workflowId, approved),
  },

  // ── Sessions & History ───────────────────────────────────────────────────
  sessions: {
    list: () => ipcRenderer.invoke('sessions:list'),
    create: () => ipcRenderer.invoke('sessions:create'),
    delete: (id: string) => ipcRenderer.invoke('sessions:delete', id),
    getMessages: (sessionId: string) =>
      ipcRenderer.invoke('sessions:getMessages', sessionId),
  },

  // ── LLM / Models ────────────────────────────────────────────────────────
  llm: {
    listModels: () => ipcRenderer.invoke('llm:listModels'),
    getActiveModel: () => ipcRenderer.invoke('llm:getActiveModel'),
    detectHardware: () => ipcRenderer.invoke('llm:detectHardware'),
    pullModel: (name: string) => ipcRenderer.invoke('llm:pullModel', name),
    setActiveModel: (modelName: string) =>
      ipcRenderer.invoke('llm:setActiveModel', modelName),
  },

  // ── MCP Tools ────────────────────────────────────────────────────────────
  mcp: {
    listTools: () => ipcRenderer.invoke('mcp:listTools'),
    installServer: (uri: string) =>
      ipcRenderer.invoke('mcp:installServer', uri),
    toggleTool: (toolId: string, enabled: boolean) =>
      ipcRenderer.invoke('mcp:toggleTool', toolId, enabled),
    removeServer: (id: string) => ipcRenderer.invoke('mcp:removeServer', id),
    getAuditLog: (limit?: number) =>
      ipcRenderer.invoke('mcp:getAuditLog', limit),
  },

  // ── RAG / Indexes ────────────────────────────────────────────────────────
  rag: {
    listIndexes: () => ipcRenderer.invoke('rag:listIndexes'),
    createIndex: (name: string, dirPath: string) =>
      ipcRenderer.invoke('rag:createIndex', name, dirPath),
    deleteIndex: (id: string) => ipcRenderer.invoke('rag:deleteIndex', id),
    rebuildIndex: (id: string) => ipcRenderer.invoke('rag:rebuildIndex', id),
  },

  // ── Document Generation ──────────────────────────────────────────────────
  docs: {
    generate: (type: 'docx' | 'pptx' | 'xlsx' | 'pdf', prompt: string, outPath: string) =>
      ipcRenderer.invoke('docs:generate', type, prompt, outPath),
    openFile: (filePath: string) => ipcRenderer.invoke('docs:openFile', filePath),
  },

  // ── Settings ─────────────────────────────────────────────────────────────
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    set: (patch: unknown) => ipcRenderer.invoke('settings:set', patch),
    getWebConfig: () => ipcRenderer.invoke('settings:getWebConfig'),
    setWebConfig: (patch: unknown) => ipcRenderer.invoke('settings:setWebConfig', patch),
  },

  // ── Web tools (built-in) ─────────────────────────────────────────────────
  // Backed by SearXNG + Mozilla Readability. Surface for managing the on-disk
  // fetch cache shown in the Web settings panel.
  web: {
    clearCache: () => ipcRenderer.invoke('web:clearCache') as Promise<number>,
    getCacheStats: () => ipcRenderer.invoke('web:getCacheStats') as Promise<{ count: number; bytes: number }>,
  },

  // ── Browser (co-piloted BrowserView) ─────────────────────────────────────
  // attach/detach show or hide the BrowserView under the renderer's pane.
  // The renderer is the source of truth for pane geometry; main owns the
  // webContents. Events stream the current URL, title, loading state, and
  // driving mode (agent | user) so the toolbar stays accurate.
  browser: {
    attach: (bounds: { x: number; y: number; width: number; height: number }) =>
      ipcRenderer.invoke('browser:attach', bounds),
    detach: () => ipcRenderer.invoke('browser:detach'),
    setBounds: (bounds: { x: number; y: number; width: number; height: number }) =>
      ipcRenderer.invoke('browser:setBounds', bounds),
    navigate: (url: string) => ipcRenderer.invoke('browser:navigate', url),
    back: () => ipcRenderer.invoke('browser:back'),
    forward: () => ipcRenderer.invoke('browser:forward'),
    reload: () => ipcRenderer.invoke('browser:reload'),
    stop: () => ipcRenderer.invoke('browser:stop'),
    takeWheel: () => ipcRenderer.invoke('browser:takeWheel'),
    resumeAgent: () => ipcRenderer.invoke('browser:resumeAgent'),
    cancelHandoff: () => ipcRenderer.invoke('browser:cancelHandoff'),
    getState: () => ipcRenderer.invoke('browser:getState'),
    onState: (cb: (state: unknown) => void) => {
      ipcRenderer.on('browser:state', (_e, s) => cb(s));
      return () => ipcRenderer.removeAllListeners('browser:state');
    },
    onAutoOpen: (cb: () => void) => {
      ipcRenderer.on('browser:autoOpen', () => cb());
      return () => ipcRenderer.removeAllListeners('browser:autoOpen');
    },
    onHandoffRequested: (cb: (payload: { reason: string }) => void) => {
      ipcRenderer.on('browser:handoffRequested', (_e, p) => cb(p));
      return () => ipcRenderer.removeAllListeners('browser:handoffRequested');
    },
    onHandoffResolved: (cb: (payload: { outcome: 'resumed' | 'cancelled' }) => void) => {
      ipcRenderer.on('browser:handoffResolved', (_e, p) => cb(p));
      return () => ipcRenderer.removeAllListeners('browser:handoffResolved');
    },
  },
};

contextBridge.exposeInMainWorld('artha', api);
