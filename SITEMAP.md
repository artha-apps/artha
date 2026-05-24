# Artha — Workspace Sitemap

> Last updated: 2026-05-24 (Step 4 complete)

## Root

| Path | Purpose |
|------|---------|
| `package.json` | Root monorepo manifest — workspaces, electron-builder config, dev scripts |
| `package-lock.json` | Lockfile |
| `REQUIREMENTS.md` | Living product spec / implementation log |
| `SITEMAP.md` | This file |
| `README.md` | Public-facing overview (install, usage, contributing) |
| `assets/` | App icons — `icon.icns` (macOS), `icon.ico` (Windows), `icon.png` (Linux) |
| `.github/workflows/ci.yml` | CI: typecheck + lint + test on push/PR |
| `.github/workflows/release.yml` | Release: build DMG/EXE/DEB and publish to GitHub Releases on tag push |

---

## `packages/app` — Electron main process

| Path | Purpose |
|------|---------|
| `src/main.ts` | Entry point — BrowserWindow creation, IPC setup, auto-updater, tray |
| `src/preload.ts` | Context bridge — exposes `window.artha.*` API to renderer (zero Node access in renderer) |
| `src/db/schema.ts` | SQLite schema — all `CREATE TABLE` + `ALTER TABLE` migrations |
| `src/db/db.ts` | `getDb()` singleton — opens / migrates the database on first call |
| **agent/** | |
| `src/agent/orchestrator.ts` | `AgentOrchestrator` — ReAct loop, clarification flow, memory injection, tool dispatch |
| `src/agent/skills.ts` | `SkillsService` — loads YAML skill files, filters tool schemas per skill |
| `src/agent/planner.ts` | `Planner` — converts goal → `AgentPlan` with sub-tasks |
| `src/agent/router.ts` | `ModelRouter` — picks model based on goal complexity / cost preference |
| **ipc/** | |
| `src/ipc/handlers.ts` | All `ipcMain.handle(...)` registrations (chat, llm, mcp, memory, artifacts, scheduler, ide, …) |
| **llm/** | |
| `src/llm/client.ts` | `getActiveLLMClient()` — returns an OpenAI-compat client for the active model; respects context_window |
| **mcp/** | |
| `src/mcp/registry.ts` | `McpRegistry` — manages MCP server processes, tool schemas, invocations |
| `src/mcp/registry-catalog.ts` | 14 curated MCP marketplace entries (filesystem, web, productivity, …) |
| **tools/** | |
| `src/tools/brave.ts` | Brave Search API client (free tier fallback) |
| `src/tools/duckduckgo.ts` | DuckDuckGo HTML scraper (zero-config fallback) |
| `src/tools/web.ts` | `webSearchImpl` — three-tier search chain (Brave → SearXNG → DuckDuckGo) |
| `src/tools/readability.ts` | Mozilla Readability wrapper — strips boilerplate, returns clean markdown |
| `src/tools/docs.ts` | Document generation (DOCX via `docx`, PPTX via `pptxgenjs`, XLSX via `xlsx`, PDF via `pdf-lib`) |
| `src/tools/memory.ts` | `MEMORY_TOOL_SCHEMAS` + `invokeMemoryTool` + `getMemoryContext` — SQLite entity graph |
| `src/tools/rag.ts` | Retrieval-augmented generation — chunk, embed, vector search over local docs |
| **scheduler/** | |
| `src/scheduler/scheduler.ts` | `SchedulerService` — cron / one-shot task runner via `node-schedule` |
| **notify.ts** | `sendNotification()` — Electron native notifications with focus-on-click |
| `tsconfig.json` | TypeScript config for main process (CommonJS, Node 20 types) |

---

## `packages/renderer` — React frontend (Vite + Tailwind)

| Path | Purpose |
|------|---------|
| `src/main.tsx` | React entry point |
| `src/App.tsx` | Root component — view router, IPC event wiring (clarify, update-available) |
| **stores/** | |
| `src/stores/chat.ts` | Zustand store — `ActiveView` union, messages, pending attachments, clarify state |
| **components/Chat/** | |
| `ChatWindow.tsx` | Composer with send, attach image, attach PDF, voice mic; message bubble list |
| `ClarificationModal.tsx` | Pre-flight Q&A modal (pauses the agent until user answers or skips) |
| `PlanApproval.tsx` | Approval UI for the ReAct plan before execution |
| `ThinkingBubble.tsx` | Live streaming "thinking…" indicator |
| **components/Sidebar/** | |
| `Sidebar.tsx` | Nav icons — Chat, Models, MCP, Skills, Web, RAG, Provenance, Artifacts, Marketplace, Memory, IDE, Settings |
| **components/Settings/** | |
| `ModelsPanel.tsx` | Configure LLM models — API key, base URL, context window slider |
| `McpPanel.tsx` | Add / remove MCP servers; view tool schemas |
| `SkillsPanel.tsx` | Create / edit / delete agent skill files |
| `WebPanel.tsx` | Web search config — Brave key, SearXNG instances, provider status |
| `RagPanel.tsx` | Index local documents for RAG retrieval |
| `SchedulerPanel.tsx` | Create / edit / toggle / delete scheduled tasks |
| `ArtifactsPanel.tsx` | Browse generated artifacts — open, delete |
| `MarketplacePanel.tsx` | MCP plugin marketplace — search, category filter, install |
| `MemoryPanel.tsx` | Browse agent memory entities — type badges, delete, clear-all |
| `IDEIntegrationPanel.tsx` | Generate `.vscode/mcp.json` or `.cursor/mcp.json` for a project folder |
| `SettingsPanel.tsx` | App settings — notifications toggle |
| `ProvenancePanel.tsx` | Source attribution for agent answers |
| `TimeTravelPanel.tsx` | Session replay / history |
| `RouterPanel.tsx` | Model router config |
| `BundlesPanel.tsx` | Skill bundle management |
| `vite.config.ts` | Vite config — React plugin, build output to `dist/` |
| `tailwind.config.ts` | Tailwind config — artha colour palette |
| `tsconfig.json` | TypeScript config for renderer (ESNext, bundler resolution) |

---

## `packages/landing` — Marketing site (Next.js 14 + Tailwind)

| Path | Purpose |
|------|---------|
| `app/layout.tsx` | Root layout — metadata (OG, Twitter), Google Fonts (Inter) |
| `app/page.tsx` | Home page — Hero, How it works, Features grid, Privacy callout, Download CTA, Footer |
| `app/globals.css` | Tailwind base + custom utilities (`gradient-text`, `glow`) |
| `components/NavBar.tsx` | Fixed nav — logo, section links, Download CTA |
| `components/DownloadButton.tsx` | OS-detecting download button — fetches latest release assets from GitHub API; shows platform-specific links |
| `components/FeatureCard.tsx` | Feature grid card |
| `vercel.json` | Vercel deployment config (`output: export`, `outputDirectory: out`) |
| `next.config.ts` | Next.js config — static export, trailing slash, unoptimized images |
| `tailwind.config.ts` | Tailwind config — artha colour palette matching app |
| `tsconfig.json` | TypeScript config for Next.js |
| `public/favicon.svg` | SVG favicon |

---

## Key external dependencies

| Package | Used in | Purpose |
|---------|---------|---------|
| `electron` (29.x) | app | Desktop runtime |
| `better-sqlite3` | app | Synchronous SQLite driver (native module) |
| `@modelcontextprotocol/sdk` | app | MCP client/server protocol |
| `openai` | app | OpenAI-compatible LLM client |
| `node-schedule` | app | Cron + one-shot scheduling |
| `electron-updater` | app | Auto-update via GitHub Releases |
| `docx` / `pptxgenjs` / `xlsx` / `pdf-lib` | app | Document generation |
| `@mozilla/readability` + `jsdom` | app | Web page content extraction |
| `react` + `react-dom` | renderer | UI framework |
| `zustand` | renderer | State management |
| `tailwindcss` | renderer, landing | Utility CSS |
| `react-markdown` | renderer | Markdown rendering in chat bubbles |
| `lucide-react` | renderer | Icon library |
| `next` (14.x) | landing | Marketing site framework |
| `vite` (8.x) | renderer | Dev server + bundler |

---

## Data locations (runtime, macOS)

| Data | Path |
|------|------|
| SQLite database | `~/Library/Application Support/Artha/artha.db` |
| Skill YAML files | `~/Library/Application Support/Artha/skills/` |
| MCP server configs | `~/Library/Application Support/Artha/mcp.json` |
| Generated artifacts | `~/Library/Application Support/Artha/artifacts/` |
| App logs | `~/Library/Logs/Artha/` |
