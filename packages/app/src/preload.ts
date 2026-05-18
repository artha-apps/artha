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
    removeServer: (id: string) => ipcRenderer.invoke('mcp:removeServer', id),
    updatePermissions: (toolId: string, perms: unknown) =>
      ipcRenderer.invoke('mcp:updatePermissions', toolId, perms),
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
  },
};

contextBridge.exposeInMainWorld('artha', api);
