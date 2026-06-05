/**
 * Preload script — exposes a typed, safe bridge between the renderer (React)
 * and the Electron main process (Node.js). Never expose raw ipcRenderer.
 */
import { contextBridge, ipcRenderer } from 'electron';
import type { SkillMetric, SkillModelStats, SkillToolUsage, SkillFailure } from './skills/metrics';

/**
 * The full type of `window.artha` as seen by the renderer. Inferred from the
 * `api` object so the renderer and main process can never drift out of sync —
 * adding a channel here automatically widens the type.
 */
export type ArthaAPI = typeof api;

/** Phase of the local-model startup flow (auto-start Ollama + pre-warm). */
export interface ModelStatus {
  phase: 'checking' | 'starting' | 'warming' | 'ready' | 'not_installed' | 'error';
  model?: string;
  detail?: string;
}

/** A parsed Bring-Your-Own-Memory entry, exchanged with the BYOM importer.
 *  Mirrors `ParsedEntry` in `tools/memoryImport.ts`. */
export interface MemoryImportEntry {
  name: string;
  content: string;
  entity_type: string;
  tags: string[];
  date?: string | null;
}

/** A Knowledge Graph node as sent to the renderer (props parsed). Mirrors
 *  `KgEntity` in `bodhi/knowledgeGraph.ts`. */
export interface KgNodeDTO {
  entity_id: string;
  kind: string;
  name: string;
  external_id: string | null;
  source: string;
  props: Record<string, unknown>;
  project_id: string | null;
  created_at: number;
  updated_at: number;
}

/** A Knowledge Graph edge as sent to the renderer. Mirrors `KgRelation`. */
export interface KgEdgeDTO {
  relation_id: string;
  src_id: string;
  dst_id: string;
  rel_type: string;
  props: Record<string, unknown>;
  created_at: number;
}

/** A folder or file attached to a single chat (see `session_scopes`). */
export interface SessionScope {
  scope_id: string;
  session_id: string;
  path: string;
  kind: 'folder' | 'file';
  rag_index_id: string | null;
  added_at: number;
}

/**
 * The preload API surface exposed on `window.artha`.
 *
 * Convention for event-listener helpers (e.g. `onToken`, `onStreamEnd`):
 *   - They register a listener and return an unsubscribe function.
 *   - Callers must invoke the returned cleanup when the component unmounts;
 *     failing to do so leaks listeners across re-renders.
 *
 * All `invoke` calls map 1-to-1 to an `ipcMain.handle` in `ipc/handlers.ts`.
 */
const api = {
  // ── Agent ────────────────────────────────────────────────────────────────
  agent: {
    sendMessage: (sessionId: string, content: string, attachments?: { name: string; mime: string; data: string }[]) =>
      ipcRenderer.invoke('agent:sendMessage', sessionId, content, attachments),
    pickImage: () =>
      ipcRenderer.invoke('dialog:pickImage') as Promise<{ name: string; mime: string; data: string; path: string } | null>,
    pickPdf: () =>
      ipcRenderer.invoke('dialog:pickPdf') as Promise<{ pdfName: string; pages: { name: string; mime: string; data: string }[] } | null>,
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
    onStreamEnd: (cb: () => void) => {
      ipcRenderer.on('agent:streamEnd', () => cb());
      return () => ipcRenderer.removeAllListeners('agent:streamEnd');
    },
    // Fired when the orchestrator resets its in-progress stream (e.g. on cancel
    // or re-send) so the renderer can clear its partial token accumulator.
    onStreamReset: (cb: () => void) => {
      ipcRenderer.on('agent:streamReset', () => cb());
      return () => ipcRenderer.removeAllListeners('agent:streamReset');
    },
    // Carries the workflow ID the orchestrator assigned to this run. The renderer
    // needs it to call `cancelTask` or `approvePlan` for the in-flight workflow.
    onWorkflowStart: (cb: (workflowId: string) => void) => {
      ipcRenderer.on('agent:workflowStart', (_e, id) => cb(id));
      return () => ipcRenderer.removeAllListeners('agent:workflowStart');
    },
    onCitations: (cb: (payload: { citations: { url: string; title: string; fetched_at: number }[] }) => void) => {
      ipcRenderer.on('agent:citations', (_e, p) => cb(p));
      return () => ipcRenderer.removeAllListeners('agent:citations');
    },
    // Internal chain-of-thought from the <think> phase. Emitted once per run
    // before tool use. `showReasoning` mirrors the Settings toggle so the
    // renderer can hide the disclosure while the phase still runs server-side.
    onReasoning: (cb: (payload: { steps: { phase: string; content: string; context_score: number }[]; showReasoning: boolean }) => void) => {
      ipcRenderer.on('agent:reasoning', (_e, p) => cb(p));
      return () => ipcRenderer.removeAllListeners('agent:reasoning');
    },
    approvePlan: (workflowId: string, approved: boolean) =>
      ipcRenderer.invoke('agent:approvePlan', workflowId, approved),
    onSkillActive: (cb: (payload: { slug: string; name: string; icon: string }) => void) => {
      ipcRenderer.on('agent:skillActive', (_e, p) => cb(p));
      return () => ipcRenderer.removeAllListeners('agent:skillActive');
    },
    onClarifyRequest: (cb: (payload: { workflowId: string; sessionId: string; goal: string; questions: string[] }) => void) => {
      ipcRenderer.on('agent:clarifyRequest', (_e, p) => cb(p));
      return () => ipcRenderer.removeAllListeners('agent:clarifyRequest');
    },
    clarifyRespond: (workflowId: string, answers: string[] | null) =>
      ipcRenderer.invoke('agent:clarifyRespond', workflowId, answers),
    // Per-tool-call approval (policy `confirm` tier). The orchestrator pauses a
    // specific function call until the user approves or denies it here.
    onToolApprovalRequest: (cb: (payload: { approvalId: string; workflowId: string; sessionId: string; toolName: string; argsPreview: string; note: string }) => void) => {
      ipcRenderer.on('agent:toolApprovalRequest', (_e, p) => cb(p));
      return () => ipcRenderer.removeAllListeners('agent:toolApprovalRequest');
    },
    respondToolApproval: (approvalId: string, approved: boolean) =>
      ipcRenderer.invoke('agent:respondToolApproval', approvalId, approved),
    // Decompose a goal into sub-tasks and run them concurrently.
    runParallel: (sessionId: string, goal: string, subTasks: string[]) =>
      ipcRenderer.invoke('agent:runParallel', { sessionId, goal, subTasks }) as Promise<string[]>,
    onParallelStart: (cb: (payload: { goal: string; subTasks: string[] }) => void) => {
      ipcRenderer.on('agent:parallelStart', (_e, p) => cb(p));
      return () => ipcRenderer.removeAllListeners('agent:parallelStart');
    },
    onParallelTaskDone: (cb: (payload: { index: number; result: string }) => void) => {
      ipcRenderer.on('agent:parallelTaskDone', (_e, p) => cb(p));
      return () => ipcRenderer.removeAllListeners('agent:parallelTaskDone');
    },
  },

  // ── Delegate ───────────────────────────────────────────────────────────────
  // Goal-driven execution surface. `run` hands a goal to Bodhi, which routes it
  // to a capability and executes it through the orchestrator, returning the
  // final output + artifacts. `steps` reads a Task's step trace for progress.
  delegate: {
    /** Non-blocking: kick off a goal, get back the Task id to poll. */
    start: (goal: string) => ipcRenderer.invoke('delegate:start', goal) as Promise<{
      runId: string;
      sessionId: string;
      capability: string;
    }>,
    /** Poll a running Task; terminal responses carry the output + artifacts. */
    status: (runId: string, sessionId: string) =>
      ipcRenderer.invoke('delegate:status', runId, sessionId) as Promise<{
        status: 'running' | 'completed' | 'failed';
        output: string;
        files: { name: string; kind: string }[];
        stepCount: number;
      }>,
    /** Synchronous "invoke and wait" capability API (used programmatically). */
    run: (goal: string) => ipcRenderer.invoke('delegate:run', goal) as Promise<{
      runId: string | null;
      sessionId: string;
      status: 'completed' | 'failed';
      output: string;
      error: string | null;
      capability: string;
      files: { name: string; kind: string }[];
    }>,
    steps: (runId: string) => ipcRenderer.invoke('delegate:steps', runId) as Promise<
      { idx: number; kind: string; payload: string; ts: number }[]
    >,
  },

  // ── Projects ─────────────────────────────────────────────────────────────
  // Project = a folder + auto-built RAG index + rolling cross-session memory.
  // The renderer uses these to drive the switcher, the sidebar list, and
  // `@project` references in the composer.
  projects: {
    list: () => ipcRenderer.invoke('projects:list') as Promise<Array<{
      project_id: string;
      name: string;
      root_path: string;
      rag_index_id: string | null;
      summary: string | null;
      created_at: number;
    }>>,
    get: (projectId: string) => ipcRenderer.invoke('projects:get', projectId),
    create: () => ipcRenderer.invoke('projects:create'),
    /** Delete a project; its chats + scoped memories are preserved by being
     *  moved to "General" (project_id NULL). Resolves to the number of chats
     *  relocated so the caller can surface where the history went. */
    delete: (projectId: string) =>
      ipcRenderer.invoke('projects:delete', projectId) as Promise<{ movedChats: number }>,
  },

  // ── Filesystem reads (renderer-safe, read-only) ──────────────────────────
  fs: {
    /** Depth-2 directory tree as a multi-line string (Cowork-style). Used by
     *  the Code tab's file pane; returns '' for empty / unreadable paths. */
    tree: (rootPath: string, maxEntries?: number) =>
      ipcRenderer.invoke('fs:tree', rootPath, maxEntries) as Promise<string>,
  },

  // ── Sessions & History ───────────────────────────────────────────────────
  sessions: {
    list: () => ipcRenderer.invoke('sessions:list'),
    create: (projectId?: string | null) => ipcRenderer.invoke('sessions:create', projectId),
    /** Permanently delete a chat; cascades to its messages/scopes/agent state. No undo. */
    delete: (id: string) => ipcRenderer.invoke('sessions:delete', id),
    /** Rename a chat; returns the cleaned title actually stored. */
    rename: (id: string, title: string) => ipcRenderer.invoke('sessions:rename', id, title) as Promise<string>,
    /** Sessions filtered to one project (or `null` for no-project). */
    listByProject: (projectId: string | null) =>
      ipcRenderer.invoke('sessions:listByProject', projectId),
    getMessages: (sessionId: string) =>
      ipcRenderer.invoke('sessions:getMessages', sessionId),
    onTitleUpdated: (cb: (payload: { sessionId: string; title: string }) => void) => {
      ipcRenderer.on('session:titleUpdated', (_e, p) => cb(p));
      return () => ipcRenderer.removeAllListeners('session:titleUpdated');
    },
  },

  // ── Scopes ───────────────────────────────────────────────────────────────
  // Per-chat folders/files. The agent is made aware of them and hard-sandboxed
  // to them. `addFolder`/`addFile` open native pickers; folders get an auto RAG
  // index built in the background.
  scopes: {
    list: (sessionId: string) => ipcRenderer.invoke('scopes:list', sessionId) as Promise<SessionScope[]>,
    addFolder: (sessionId: string) => ipcRenderer.invoke('scopes:addFolder', sessionId) as Promise<SessionScope | null>,
    /** Programmatic add-by-path — no dialog. Idempotent. Used to auto-attach
     *  the active project's root to fresh sessions. */
    addFolderPath: (sessionId: string, rootPath: string) =>
      ipcRenderer.invoke('scopes:addFolderPath', sessionId, rootPath) as Promise<SessionScope | null>,
    addFile: (sessionId: string) => ipcRenderer.invoke('scopes:addFile', sessionId) as Promise<SessionScope[]>,
    remove: (scopeId: string) => ipcRenderer.invoke('scopes:remove', scopeId) as Promise<boolean>,
    // Rebuild a folder scope's RAG index. Returns chunk count.
    reindex: (scopeId: string) => ipcRenderer.invoke('scopes:reindex', scopeId) as Promise<number>,
  },

  // ── LLM / Models ────────────────────────────────────────────────────────
  llm: {
    listModels: () => ipcRenderer.invoke('llm:listModels'),
    getActiveModel: () => ipcRenderer.invoke('llm:getActiveModel'),
    detectHardware: () => ipcRenderer.invoke('llm:detectHardware'),
    checkOllama: () => ipcRenderer.invoke('llm:checkOllama') as Promise<boolean>,
    pullModel: (name: string) => ipcRenderer.invoke('llm:pullModel', name),
    pullModelStream: (name: string) => ipcRenderer.invoke('llm:pullModelStream', name) as Promise<boolean>,
    // Uninstall a local Ollama model — frees its on-disk blobs and drops its DB row.
    deleteModel: (name: string) =>
      ipcRenderer.invoke('llm:deleteModel', name) as Promise<{ ok: boolean; error?: string }>,
    onPullProgress: (cb: (p: { name: string; status: string; completed?: number; total?: number; percent?: number; error?: string }) => void) => {
      ipcRenderer.on('llm:pullProgress', (_e, p) => cb(p));
      return () => ipcRenderer.removeAllListeners('llm:pullProgress');
    },
    // Model-startup status: Artha auto-starts Ollama + pre-warms the active
    // model on launch. `getModelStatus` reads the current phase; `onModelStatus`
    // streams live updates; `ensureModel` re-triggers the flow (onboarding retry).
    getModelStatus: () => ipcRenderer.invoke('model:getStatus') as Promise<ModelStatus>,
    ensureModel: () => ipcRenderer.invoke('model:ensure') as Promise<ModelStatus>,
    onModelStatus: (cb: (s: ModelStatus) => void) => {
      ipcRenderer.on('model:status', (_e, s) => cb(s));
      return () => ipcRenderer.removeAllListeners('model:status');
    },
    setActiveModel: (modelName: string) =>
      ipcRenderer.invoke('llm:setActiveModel', modelName),
    // Cloud models (BYOK, opt-in). Keys are stored locally and only sent to the
    // provider the user configured; local Ollama remains the default.
    listConfigured: () => ipcRenderer.invoke('llm:listConfigured'),
    addCloudModel: (m: { provider: string; label: string; model: string; baseUrl: string; apiKey: string; activate?: boolean }) =>
      ipcRenderer.invoke('llm:addCloudModel', m),
    setActiveModelById: (modelId: string) =>
      ipcRenderer.invoke('llm:setActiveModelById', modelId),
    setContextWindow: (modelId: string, tokens: number) =>
      ipcRenderer.invoke('llm:setContextWindow', modelId, tokens),
    removeModel: (modelId: string) => ipcRenderer.invoke('llm:removeModel', modelId),
  },

  // ── Updates ───────────────────────────────────────────────────────────────
  updates: {
    /** Fires when the main process detects a newer GitHub release. */
    onAvailable: (cb: (info: { version: string }) => void) => {
      ipcRenderer.on('update:available', (_e, info) => cb(info));
      return () => ipcRenderer.removeAllListeners('update:available');
    },
    /** Open the public download page (artha.space) in the default browser. */
    openDownload: () => ipcRenderer.invoke('updates:openDownload'),
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
    // Install URIs of every installed MCP server — lets the Marketplace restore
    // the "Installed" badge from the DB instead of in-memory state.
    listInstalledIds: () => ipcRenderer.invoke('mcp:listInstalledIds') as Promise<string[]>,
  },

  // ── Skills ───────────────────────────────────────────────────────────────
  // Reusable agent playbooks. Invoked by typing "/slug" in chat or matched
  // automatically by description. CRUD here drives the Skills settings panel.
  skills: {
    list: () => ipcRenderer.invoke('skills:list'),
    listEnabled: () => ipcRenderer.invoke('skills:listEnabled'),
    metrics: () => ipcRenderer.invoke('skills:metrics') as Promise<SkillMetric[]>,
    modelStats: (skillId: string) => ipcRenderer.invoke('skills:modelStats', skillId) as Promise<SkillModelStats>,
    toolUsage: (skillId: string) => ipcRenderer.invoke('skills:toolUsage', skillId) as Promise<SkillToolUsage>,
    failures: (skillId: string, limit?: number) => ipcRenderer.invoke('skills:failures', skillId, limit) as Promise<SkillFailure[]>,
    pinModel: (skillId: string, model: string | null) => ipcRenderer.invoke('skills:pinModel', skillId, model) as Promise<boolean>,
    create: (input: unknown) => ipcRenderer.invoke('skills:create', input),
    update: (skillId: string, patch: unknown) =>
      ipcRenderer.invoke('skills:update', skillId, patch),
    toggle: (skillId: string, enabled: boolean) =>
      ipcRenderer.invoke('skills:toggle', skillId, enabled),
    remove: (skillId: string) => ipcRenderer.invoke('skills:remove', skillId),
    export: (skillId: string) => ipcRenderer.invoke('skills:export', skillId) as Promise<string | null>,
    import: () => ipcRenderer.invoke('skills:import') as Promise<{ count: number } | null>,
  },

  // ── RAG / Indexes ────────────────────────────────────────────────────────
  rag: {
    listIndexes: () => ipcRenderer.invoke('rag:listIndexes'),
    createIndex: (name: string, dirPath: string) =>
      ipcRenderer.invoke('rag:createIndex', name, dirPath),
    deleteIndex: (id: string) => ipcRenderer.invoke('rag:deleteIndex', id),
    rebuildIndex: (id: string) => ipcRenderer.invoke('rag:rebuildIndex', id),
    selectDirectory: () => ipcRenderer.invoke('dialog:selectDirectory') as Promise<string | null>,
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
    // Google OAuth client id (Desktop app) lives on the settings blob.
    getGoogleClientId: () => ipcRenderer.invoke('settings:getGoogleClientId') as Promise<string>,
    setGoogleClientId: (id: string) => ipcRenderer.invoke('settings:setGoogleClientId', id) as Promise<boolean>,
    // Desktop-control master switch (default off).
    getDesktopControl: () => ipcRenderer.invoke('settings:getDesktopControl') as Promise<boolean>,
    setDesktopControl: (enabled: boolean) => ipcRenderer.invoke('settings:setDesktopControl', enabled) as Promise<boolean>,
    // Sentry crash reporting (opt-out, default ON). `getSentry` also reports
    // whether the one-time first-launch disclosure has been acknowledged.
    getSentry: () => ipcRenderer.invoke('settings:getSentry') as Promise<{ enabled: boolean; disclosureAck: boolean }>,
    setSentry: (enabled: boolean) => ipcRenderer.invoke('settings:setSentry', enabled) as Promise<{ enabled: boolean }>,
    ackSentryDisclosure: () => ipcRenderer.invoke('settings:ackSentryDisclosure') as Promise<boolean>,
  },

  // ── Cloud OAuth (Google Workspace) ────────────────────────────────────────
  // Connect Gmail/Calendar/Drive via an installed-app OAuth (PKCE) flow.
  oauth: {
    startFlow: (provider: 'google') =>
      ipcRenderer.invoke('oauth:startFlow', { provider }) as Promise<{ success: boolean; error?: string }>,
    getStatus: () =>
      ipcRenderer.invoke('oauth:getStatus') as Promise<{ provider: string; expires_at: number }[]>,
    revoke: (provider: string) => ipcRenderer.invoke('oauth:revoke', provider) as Promise<boolean>,
  },

  // ── LAN collaboration server ──────────────────────────────────────────────
  // Exposes the agent over the local network (0.0.0.0:7842) for teammates.
  // `start` may return an error string when the current license tier does not
  // include the LAN server (Free → must upgrade).
  lan: {
    start: () => ipcRenderer.invoke('lan:start') as Promise<{ running: boolean; url: string | null; localIp: string | null; error?: string }>,
    stop: () => ipcRenderer.invoke('lan:stop') as Promise<{ running: boolean; url: string | null; localIp: string | null }>,
    getStatus: () => ipcRenderer.invoke('lan:getStatus') as Promise<{ running: boolean; url: string | null; localIp: string | null }>,
    setAutostart: (enabled: boolean) => ipcRenderer.invoke('lan:setAutostart', enabled) as Promise<boolean>,
    getAutostart: () => ipcRenderer.invoke('lan:getAutostart') as Promise<boolean>,
  },

  // ── License ──────────────────────────────────────────────────────────────
  // Offline Ed25519-signed keys gate Pro/Enterprise capabilities (LAN server,
  // shared memories, RBAC, seat counts). The raw key never leaves the main
  // process after `apply` — the renderer only sees derived entitlements.
  license: {
    get: () => ipcRenderer.invoke('license:get') as Promise<{
      entitlements: {
        tier: 'free' | 'pro' | 'enterprise';
        seats: number; lanServer: boolean; sharedMemory: boolean;
        orgHub: boolean; rbac: boolean; auditExport: boolean;
        org: string | null; expiresAt: number | null;
      };
      hasKey: boolean;
    }>,
    apply: (rawKey: string) => ipcRenderer.invoke('license:apply', rawKey) as Promise<
      | { ok: true; entitlements: { tier: 'free' | 'pro' | 'enterprise'; seats: number; lanServer: boolean; sharedMemory: boolean; orgHub: boolean; rbac: boolean; auditExport: boolean; org: string | null; expiresAt: number | null } }
      | { ok: false; error: string }
    >,
    clear: () => ipcRenderer.invoke('license:clear') as Promise<{
      ok: true;
      entitlements: { tier: 'free'; seats: number; lanServer: boolean; sharedMemory: boolean; orgHub: boolean; rbac: boolean; auditExport: boolean; org: null; expiresAt: null };
    }>,
  },

  // ── Desktop control ───────────────────────────────────────────────────────
  // Capture the screen (base64 PNG) — used by the Desktop panel's test button.
  desktop: {
    capture: () => ipcRenderer.invoke('desktop:capture') as Promise<string>,
  },

  // ── Bundles ──────────────────────────────────────────────────────────────
  // `.artha-bundle` = signed, portable record of an agent run + artifacts that
  // can be re-imported and inspected on another machine.
  bundles: {
    export: (runId: string, docId?: string) =>
      ipcRenderer.invoke('bundles:export', runId, docId),
    import: () => ipcRenderer.invoke('bundles:import'),
    openExtracted: (dir: string) => ipcRenderer.invoke('bundles:openExtracted', dir),
  },

  // ── Artifacts ────────────────────────────────────────────────────────────
  // Persistent log of every file the agent has generated. ArtifactsPanel reads
  // the list; docs generator and tools write via `log`; user can open or delete.
  artifacts: {
    list: () => ipcRenderer.invoke('artifacts:list') as Promise<{ artifact_id: string; session_id: string | null; name: string; file_path: string; file_type: string; size_bytes: number | null; created_at: number }[]>,
    log: (entry: { sessionId?: string; name: string; filePath: string; fileType: string; sizeBytes?: number }) =>
      ipcRenderer.invoke('artifacts:log', entry) as Promise<string | null>,
    delete: (artifactId: string) => ipcRenderer.invoke('artifacts:delete', artifactId) as Promise<boolean>,
    open: (filePath: string) => ipcRenderer.invoke('artifacts:open', filePath) as Promise<boolean>,
  },

  // ── Undo ───────────────────────────────────────────────────────────────────
  // Reverse a reversible filesystem action the agent performed. In-memory,
  // process-lifetime (see agent/undo.ts).
  undo: {
    list: () => ipcRenderer.invoke('undo:list') as Promise<{ id: string; kind: string; label: string; ts: number }[]>,
    revert: (id: string) => ipcRenderer.invoke('undo:revert', id) as Promise<{ ok: boolean; error?: string; label?: string }>,
  },

  // ── Global search ────────────────────────────────────────────────────────
  // One query across chats, memory, and artifacts (see search/global.ts).
  search: {
    global: (query: string, semantic?: boolean) =>
      ipcRenderer.invoke('search:global', query, semantic) as Promise<{
        type: 'chat' | 'memory' | 'artifact'; id: string; title: string; snippet: string; ts: number; filePath?: string;
      }[]>,
  },

  // ── Memory ───────────────────────────────────────────────────────────────
  // Long-term agent memory stored in SQLite memory_entities table. MemoryPanel
  // lists entries; user can delete individual rows or clear all.
  memory: {
    list: () => ipcRenderer.invoke('memory:list') as Promise<{
      entity_id: string; name: string; entity_type: string;
      content: string; tags_json: string; origin: string;
      created_at: number; updated_at: number;
    }[]>,
    delete: (entityId: string) => ipcRenderer.invoke('memory:delete', entityId) as Promise<boolean>,
    clear: () => ipcRenderer.invoke('memory:clear') as Promise<boolean>,
    // Bring-Your-Own-Memory: parse a paste from another AI (preview = no write),
    // optionally refine with the local model, then commit the reviewed entries.
    importPreview: (raw: string, provenanceTag?: string) =>
      ipcRenderer.invoke('memory:importPreview', raw, provenanceTag) as Promise<MemoryImportEntry[]>,
    importRefine: (raw: string, provenanceTag?: string) =>
      ipcRenderer.invoke('memory:importRefine', raw, provenanceTag) as Promise<MemoryImportEntry[]>,
    import: (entries: MemoryImportEntry[], origin?: string) =>
      ipcRenderer.invoke('memory:import', entries, origin) as Promise<{ created: number; skipped: number }>,
    export: () => ipcRenderer.invoke('memory:export') as Promise<string>,
  },

  // ── CRM ────────────────────────────────────────────────────────────────────
  // Local CRM the CRM Agent maintains. The panel reads/writes the same tables
  // the crm_* agent tools do; writes also project into the Knowledge Graph.
  crm: {
    listContacts: () => ipcRenderer.invoke('crm:listContacts') as Promise<{
      contact_id: string; name: string; email: string | null; company: string | null;
      title: string | null; last_interaction_at: number | null; created_at: number;
    }[]>,
    addContact: (input: { name: string; company?: string; email?: string; title?: string }) =>
      ipcRenderer.invoke('crm:addContact', input) as Promise<{ contact_id: string }>,
    listInteractions: (contactId: string) => ipcRenderer.invoke('crm:listInteractions', contactId) as Promise<{
      interaction_id: string; contact_id: string | null; kind: string; summary: string; occurred_at: number;
    }[]>,
    logInteraction: (input: { contactId: string; kind: string; summary: string }) =>
      ipcRenderer.invoke('crm:logInteraction', input) as Promise<{ interaction_id: string }>,
    deleteContact: (contactId: string) => ipcRenderer.invoke('crm:deleteContact', contactId) as Promise<boolean>,
  },

  // ── Knowledge Graph ────────────────────────────────────────────────────────
  // Read views over the general KG engine (entities + typed relations).
  kg: {
    listNodes: (filter?: { kind?: string }) => ipcRenderer.invoke('kg:listNodes', filter) as Promise<KgNodeDTO[]>,
    listEdges: (nodeId?: string) => ipcRenderer.invoke('kg:listEdges', nodeId) as Promise<KgEdgeDTO[]>,
    query: (q: string) => ipcRenderer.invoke('kg:query', q) as Promise<{ nodes: KgNodeDTO[]; edges: KgEdgeDTO[] }>,
  },

  // ── IDE Integration ───────────────────────────────────────────────────────
  // Generate MCP config files (.vscode/mcp.json or .cursor/mcp.json) so the
  // user can connect VS Code / Cursor to Artha's local tool server.
  ide: {
    generateMcpConfig: (opts: { projectPath: string; ide: 'vscode' | 'cursor'; port?: number }) =>
      ipcRenderer.invoke('ide:generateMcpConfig', opts) as Promise<string>,
    pickProjectAndGenerate: (ide: 'vscode' | 'cursor', port: number) =>
      ipcRenderer.invoke('ide:pickProjectAndGenerate', ide, port) as Promise<string | null>,
    // Local MCP HTTP bridge the generated editor configs point at. Start is
    // idempotent; both return the current running status + URL.
    startMcpServer: () =>
      ipcRenderer.invoke('ide:startMcpServer') as Promise<{ running: boolean; url: string }>,
    stopMcpServer: () =>
      ipcRenderer.invoke('ide:stopMcpServer') as Promise<{ running: boolean }>,
  },

  // ── System ───────────────────────────────────────────────────────────────
  // Native-dep probes + small shell shortcuts.
  system: {
    // PDF reading needs Poppler's `pdftoppm`; the chat composer checks this
    // before opening the PDF picker so it can show an install hint.
    checkPoppler: () =>
      ipcRenderer.invoke('system:checkPoppler') as Promise<{ installed: boolean; path?: string }>,
    /** Open Finder / Explorer at the given path. No-op on bad input. */
    revealInFolder: (p: string) => ipcRenderer.invoke('system:revealInFolder', p),
    /** App version + runtime versions, for the About panel. */
    getAppInfo: () =>
      ipcRenderer.invoke('system:appInfo') as Promise<{
        version: string; electron: string; node: string; chrome: string; platform: string;
      }>,
  },

  // ── Router ───────────────────────────────────────────────────────────────
  // Adaptive per-task-type model selection. `benchmark` probes every installed
  // Ollama model on the three canonical tasks (plan / tool_args / synthesis)
  // and records latency + a quality heuristic; `setOverride` lets the user pin
  // a specific model for a task type, bypassing auto-selection.
  router: {
    benchmark: () => ipcRenderer.invoke('router:benchmark'),
    listProfiles: () => ipcRenderer.invoke('router:listProfiles'),
    listOverrides: () => ipcRenderer.invoke('router:listOverrides'),
    setOverride: (taskType: string, ollamaName: string | null) =>
      ipcRenderer.invoke('router:setOverride', taskType, ollamaName),
    onBenchmarkProgress: (cb: (msg: string) => void) => {
      ipcRenderer.on('router:benchmarkProgress', (_e, m) => cb(m));
      return () => ipcRenderer.removeAllListeners('router:benchmarkProgress');
    },
  },

  // ── Provenance ───────────────────────────────────────────────────────────
  // For any generated document: list the per-anchor source records (which
  // RAG chunk / tool call / LLM completion produced each paragraph or cell)
  // and read the signed JSON receipt written alongside the artifact.
  provenance: {
    listDocs: () => ipcRenderer.invoke('provenance:listDocs'),
    listAnchors: (docId: string) => ipcRenderer.invoke('provenance:listAnchors', docId),
    getReceipt: (docId: string) => ipcRenderer.invoke('provenance:getReceipt', docId),
  },

  // ── Tool-call policies (governance for function calling) ──────────────────
  // Per-tool trust tiers (auto / confirm / dry_run / forbid) evaluated before
  // every function call. CRUD here drives the Tool Policies settings panel.
  policies: {
    list: () => ipcRenderer.invoke('policies:list') as Promise<{
      policy_id: string; pattern: string; tier: 'auto' | 'confirm' | 'dry_run' | 'forbid';
      scope: 'always' | 'outside_roots'; note: string; is_enabled: number; created_at: number;
    }[]>,
    create: (input: { pattern: string; tier: string; scope?: string; note?: string; isEnabled?: boolean }) =>
      ipcRenderer.invoke('policies:create', input),
    update: (policyId: string, patch: { pattern?: string; tier?: string; scope?: string; note?: string; isEnabled?: boolean }) =>
      ipcRenderer.invoke('policies:update', policyId, patch),
    delete: (policyId: string) => ipcRenderer.invoke('policies:delete', policyId) as Promise<boolean>,
  },

  // ── Verified tool receipts (provenance for function calls) ────────────────
  // Read-only audit trail: every tool call (incl. blocked / dry-run) with a
  // plain-English effect, a content hash, and the governing policy tier.
  receipts: {
    listRuns: (limit?: number) => ipcRenderer.invoke('receipts:listRuns', limit) as Promise<{
      run_id: string; goal: string; session_id: string; calls: number; mutations: number; ts: number;
    }[]>,
    listByRun: (runId: string) => ipcRenderer.invoke('receipts:listByRun', runId) as Promise<{
      receipt_id: string; run_id: string | null; tool_name: string; args_json: string;
      effect: string; result_hash: string; status: 'ok' | 'error' | 'blocked' | 'skipped';
      tier: 'auto' | 'confirm' | 'dry_run' | 'forbid'; is_mutation: number; duration_ms: number; ts: number;
    }[]>,
  },

  // ── Runs (Activity hub) ───────────────────────────────────────────────────
  // Recent agent runs across all sessions (Chat / Delegate / Scheduled / forked)
  // with status + receipt counts. Drives the Workflows ▸ Runs activity list.
  runs: {
    listRecent: (limit?: number) => ipcRenderer.invoke('runs:listRecent', limit) as Promise<{
      run_id: string; session_id: string; workflow_id: string; goal: string;
      status: 'running' | 'completed' | 'failed' | 'cancelled'; model: string;
      parent_run_id: string | null; created_at: number;
      session_title: string; session_origin: string; calls: number; mutations: number;
    }[]>,
  },

  // ── Time travel ──────────────────────────────────────────────────────────
  // Every step of every agent run is snapshotted in `agent_steps`. `fork`
  // rehydrates the messages from a chosen step and resumes the ReAct loop
  // from that exact context — optionally with a different model.
  timetravel: {
    listRuns: (sessionId?: string) => ipcRenderer.invoke('timetravel:listRuns', sessionId),
    getSteps: (runId: string) => ipcRenderer.invoke('timetravel:getSteps', runId),
    fork: (stepId: string, modelOverride?: string) =>
      ipcRenderer.invoke('timetravel:fork', stepId, modelOverride),
  },

  // ── Web tools (built-in) ─────────────────────────────────────────────────
  // Backed by SearXNG + Mozilla Readability. Surface for managing the on-disk
  // fetch cache shown in the Web settings panel.
  web: {
    clearCache: () => ipcRenderer.invoke('web:clearCache') as Promise<number>,
    getCacheStats: () => ipcRenderer.invoke('web:getCacheStats') as Promise<{ count: number; bytes: number }>,
  },

  // ── Scheduler ────────────────────────────────────────────────────────────
  // Cron-based and one-shot task scheduling. Each task fires the agent
  // orchestrator with its stored prompt in an isolated session.
  scheduler: {
    list: () => ipcRenderer.invoke('scheduler:list'),
    create: (input: { name: string; prompt: string; cron?: string; fire_at?: number }) =>
      ipcRenderer.invoke('scheduler:create', input),
    update: (taskId: string, patch: { name?: string; prompt?: string; cron?: string; fire_at?: number }) =>
      ipcRenderer.invoke('scheduler:update', taskId, patch),
    toggle: (taskId: string, enabled: boolean) =>
      ipcRenderer.invoke('scheduler:toggle', taskId, enabled),
    remove: (taskId: string) => ipcRenderer.invoke('scheduler:remove', taskId),
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
    recover: () => ipcRenderer.invoke('browser:recover'),
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

  // ── Team members ─────────────────────────────────────────────────────────
  // Local roster of team members shown in TeamPanel. No cloud sync — purely
  // metadata for the admin UI. Remote access is gated by LAN API keys below.
  team: {
    listMembers: () => ipcRenderer.invoke('team:listMembers') as Promise<{
      member_id: string; display_name: string; email: string | null;
      role: 'admin' | 'member'; joined_at: number;
    }[]>,
    addMember: (m: { displayName: string; email?: string; role?: 'admin' | 'member' }) =>
      ipcRenderer.invoke('team:addMember', m) as Promise<{ member_id: string }>,
    updateMember: (memberId: string, patch: { displayName?: string; email?: string; role?: 'admin' | 'member' }) =>
      ipcRenderer.invoke('team:updateMember', memberId, patch) as Promise<boolean>,
    removeMember: (memberId: string) =>
      ipcRenderer.invoke('team:removeMember', memberId) as Promise<boolean>,
  },

  // ── LAN API keys ──────────────────────────────────────────────────────────
  // Bearer tokens for the LAN collaboration server. The plaintext key is
  // returned once from `create` and never stored; the DB only keeps the hash.
  apikeys: {
    list: () => ipcRenderer.invoke('apikeys:list') as Promise<{
      key_id: string; name: string; created_at: number;
      last_used_at: number | null; is_enabled: number;
    }[]>,
    // Two call shapes for back-compat: a plain name (legacy) or an object that
    // binds the key to a teammate. Bound keys carry identity into LAN auth.
    create: (args: string | { name: string; memberId?: string }) =>
      ipcRenderer.invoke('apikeys:create', args) as Promise<{ key_id: string; plaintext: string }>,
    toggle: (keyId: string, enabled: boolean) =>
      ipcRenderer.invoke('apikeys:toggle', keyId, enabled) as Promise<boolean>,
    revoke: (keyId: string) =>
      ipcRenderer.invoke('apikeys:revoke', keyId) as Promise<boolean>,
  },

  // ── Shared memories ───────────────────────────────────────────────────────
  // When is_shared=1, a memory entity is also injected into LAN server
  // sessions so remote teammates get the same persistent context.
  sharedMemory: {
    setShared: (entityId: string, shared: boolean) =>
      ipcRenderer.invoke('memory:setShared', entityId, shared) as Promise<boolean>,
    listShared: () => ipcRenderer.invoke('memory:listShared') as Promise<{
      entity_id: string; name: string; entity_type: string;
      content: string; tags_json: string; is_shared: number;
      created_at: number; updated_at: number;
    }[]>,
  },
};

contextBridge.exposeInMainWorld('artha', api);
