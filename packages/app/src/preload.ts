/**
 * Preload script — exposes a typed, safe bridge between the renderer (React)
 * and the Electron main process (Node.js). Never expose raw ipcRenderer.
 */
import { contextBridge, ipcRenderer } from 'electron';

export type ArthaAPI = typeof api;

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
    onStreamReset: (cb: () => void) => {
      ipcRenderer.on('agent:streamReset', () => cb());
      return () => ipcRenderer.removeAllListeners('agent:streamReset');
    },
    onWorkflowStart: (cb: (workflowId: string) => void) => {
      ipcRenderer.on('agent:workflowStart', (_e, id) => cb(id));
      return () => ipcRenderer.removeAllListeners('agent:workflowStart');
    },
    onCitations: (cb: (payload: { citations: { url: string; title: string; fetched_at: number }[] }) => void) => {
      ipcRenderer.on('agent:citations', (_e, p) => cb(p));
      return () => ipcRenderer.removeAllListeners('agent:citations');
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

  // ── Sessions & History ───────────────────────────────────────────────────
  sessions: {
    list: () => ipcRenderer.invoke('sessions:list'),
    create: (projectId?: string | null) => ipcRenderer.invoke('sessions:create', projectId),
    delete: (id: string) => ipcRenderer.invoke('sessions:delete', id),
    getMessages: (sessionId: string) =>
      ipcRenderer.invoke('sessions:getMessages', sessionId),
    onTitleUpdated: (cb: (payload: { sessionId: string; title: string }) => void) => {
      ipcRenderer.on('session:titleUpdated', (_e, p) => cb(p));
      return () => ipcRenderer.removeAllListeners('session:titleUpdated');
    },
  },

  // ── Projects ───────────────────────────────────────────────────────────────
  // A project scopes chat sessions to a working folder and gives the agent
  // durable context (root path + optional ARTHA.md). `create` opens a folder
  // picker; sessions created with a projectId belong to that project.
  projects: {
    list: () => ipcRenderer.invoke('projects:list') as Promise<{ project_id: string; name: string; root_path: string; created_at: number }[]>,
    create: () => ipcRenderer.invoke('projects:create') as Promise<{ project_id: string; name: string; root_path: string } | null>,
    delete: (id: string) => ipcRenderer.invoke('projects:delete', id) as Promise<boolean>,
    // Rebuild the project's RAG index over its folder. Returns chunk count.
    reindex: (id: string) => ipcRenderer.invoke('projects:reindex', id) as Promise<number>,
  },

  // ── LLM / Models ────────────────────────────────────────────────────────
  llm: {
    listModels: () => ipcRenderer.invoke('llm:listModels'),
    getActiveModel: () => ipcRenderer.invoke('llm:getActiveModel'),
    detectHardware: () => ipcRenderer.invoke('llm:detectHardware'),
    checkOllama: () => ipcRenderer.invoke('llm:checkOllama') as Promise<boolean>,
    pullModel: (name: string) => ipcRenderer.invoke('llm:pullModel', name),
    pullModelStream: (name: string) => ipcRenderer.invoke('llm:pullModelStream', name) as Promise<boolean>,
    onPullProgress: (cb: (p: { name: string; status: string; completed?: number; total?: number; percent?: number; error?: string }) => void) => {
      ipcRenderer.on('llm:pullProgress', (_e, p) => cb(p));
      return () => ipcRenderer.removeAllListeners('llm:pullProgress');
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
  lan: {
    start: () => ipcRenderer.invoke('lan:start') as Promise<{ running: boolean; url: string | null; localIp: string | null }>,
    stop: () => ipcRenderer.invoke('lan:stop') as Promise<{ running: boolean; url: string | null; localIp: string | null }>,
    getStatus: () => ipcRenderer.invoke('lan:getStatus') as Promise<{ running: boolean; url: string | null; localIp: string | null }>,
    setAutostart: (enabled: boolean) => ipcRenderer.invoke('lan:setAutostart', enabled) as Promise<boolean>,
    getAutostart: () => ipcRenderer.invoke('lan:getAutostart') as Promise<boolean>,
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

  // ── Memory ───────────────────────────────────────────────────────────────
  // Long-term agent memory stored in SQLite memory_entities table. MemoryPanel
  // lists entries; user can delete individual rows or clear all.
  memory: {
    list: () => ipcRenderer.invoke('memory:list') as Promise<{
      entity_id: string; name: string; entity_type: string;
      content: string; tags_json: string; created_at: number; updated_at: number;
    }[]>,
    delete: (entityId: string) => ipcRenderer.invoke('memory:delete', entityId) as Promise<boolean>,
    clear: () => ipcRenderer.invoke('memory:clear') as Promise<boolean>,
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
  // Probes for optional native dependencies the app shells out to.
  system: {
    // PDF reading needs Poppler's `pdftoppm`; the chat composer checks this
    // before opening the PDF picker so it can show an install hint.
    checkPoppler: () =>
      ipcRenderer.invoke('system:checkPoppler') as Promise<{ installed: boolean; path?: string }>,
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
};

contextBridge.exposeInMainWorld('artha', api);
