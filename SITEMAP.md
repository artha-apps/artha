# Artha — Workspace Sitemap

> Last updated: 2026-05-26 (per-chat folder/file scopes + filesystem sandbox)

## Root

| Path | Purpose |
|------|---------|
| `package.json` | Root monorepo manifest — workspaces, electron-builder config, dev scripts |
| `package-lock.json` | Lockfile |
| `REQUIREMENTS.md` | Living product spec / implementation log |
| `SITEMAP.md` | This file |
| `README.md` | Public-facing overview (install, usage, contributing) |
| `assets/` | App icons (mandala अ mark) — `icon.icns` (macOS), `icon.ico` (Windows), `icon.png` (Linux); `entitlements.mac.plist` — hardened-runtime entitlements for macOS signing/notarization |
| `.github/workflows/ci.yml` | CI: typecheck + lint + test on push/PR |
| `.github/workflows/release.yml` | Release: build DMG/EXE/DEB, code-sign + notarize macOS (via `CSC_*`/`APPLE_*` secrets), and publish to `artha-apps/artha` GitHub Releases on tag push |

---

## `packages/app` — Electron main process

| Path | Purpose |
|------|---------|
| `src/main.ts` | Entry point — BrowserWindow creation, IPC setup, auto-updater, tray |
| `src/preload.ts` | Context bridge — exposes `window.artha.*` API to renderer (zero Node access in renderer) |
| `src/db/schema.ts` | SQLite schema — all `CREATE TABLE` + `ALTER TABLE` migrations (incl. `session_scopes`) |
| `src/db/db.ts` | `getDb()` singleton — opens / migrates the database on first call |
| `src/db/scopes.ts` | Per-chat scope helpers — `getSessionScopes`/`getSessionAllowedRoots`/`getSessionPrimaryFolder`/`recomputePrimaryProject`; backs the folder/file sandbox + context |
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
| `src/tools/filesystem.ts` | Built-in fs tools (list/search/read/move/copy/delete) — hard sandbox confines reads/writes to the chat's attached scopes when present |
| `src/tools/brave.ts` | Brave Search API client (free tier fallback) |
| `src/tools/duckduckgo.ts` | DuckDuckGo HTML scraper (zero-config fallback) |
| `src/tools/web.ts` | `webSearchImpl` — three-tier search chain (Brave → SearXNG → DuckDuckGo) |
| `src/tools/readability.ts` | Mozilla Readability wrapper — strips boilerplate, returns clean markdown |
| `src/tools/docs.ts` | Document generation (DOCX via `docx`, PPTX via `pptxgenjs`, XLSX via `xlsx`, PDF via `pdf-lib`) |
| `src/tools/memory.ts` | `MEMORY_TOOL_SCHEMAS` + `invokeMemoryTool` + `getMemoryContext` — SQLite entity graph |
| `src/tools/rag.ts` | `rag_search` / `rag_list_indexes` — vector search over local docs; confined to the chat's folder indexes when scoped (else all) |
| `src/tools/desktop.ts` | `DESKTOP_TOOL_SCHEMAS` + `invokeDesktopTool` — mouse/keyboard/screenshot via nut-js + desktopCapturer (opt-in) |
| `src/types/nut-js.d.ts` | Ambient module shim for the lazily-loaded `@nut-tree-fork/nut-js` optional native dep |
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
| `src/stores/chat.ts` | Zustand store — `ActiveView` union, messages, pending attachments, clarify state, per-chat `scopes` |
| **lib/** | |
| `src/lib/qrcode.ts` | Dependency-free QR encoder (byte mode + Reed-Solomon, v1–10) — `generateQrMatrix` / `qrToSvg` |
| **components/Chat/** | |
| `ChatWindow.tsx` | Composer with send, attach image/PDF, voice mic, per-chat scope chips (add folder/file); message bubble list |
| `ClarificationModal.tsx` | Pre-flight Q&A modal (pauses the agent until user answers or skips) |
| `PlanApproval.tsx` | Approval UI for the ReAct plan before execution |
| `ThinkingBubble.tsx` | Live streaming "thinking…" indicator |
| **components/Sidebar/** | |
| `Sidebar.tsx` | Flat chat-session list + New Chat; nav icons — Chat, Models, MCP, Skills, Web, RAG, Provenance, Artifacts, Marketplace, Memory, IDE, Cloud, LAN Server, Desktop, Settings (folders are now attached per chat in the composer) |
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
| `CloudIntegrationsPanel.tsx` | Connect Google Workspace (Gmail/Calendar/Drive) via OAuth — client-id setup, connect/disconnect |
| `LANServerPanel.tsx` | Start/stop the LAN collaboration server — copyable URL, inline QR, curl/fetch examples, autostart |
| `DesktopControlPanel.tsx` | Toggle desktop control (mouse/keyboard/screenshot), test-screenshot preview, tool list |
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
| `public/logo-mark.png`, `logo-mark-512.png` | Mandala अ brand mark (used by landing header/footer via `next/image`) |
| `public/logo-wordmark.png`, `logo-wordmark-72.png`, `logo-full.png` | ARTHA wordmark / full lockup |
| `public/favicon-16.png`, `favicon-32.png`, `favicon-256.png`, `apple-touch-icon.png` | PNG favicons + Apple touch icon |
| `public/og-image.png` | Open Graph / Twitter card image |
| `app/api/stripe/checkout/route.ts` | (live `landing/`) POST — creates a Stripe Checkout session for the one-time Pro purchase, returns the session URL |
| `app/api/stripe/webhook/route.ts` | (live `landing/`) POST — verifies Stripe signature on `checkout.session.completed`, generates a signed Pro license key, emails it via Resend |
| `app/api/stripe/price/route.ts` | (live `landing/`) GET — returns the authoritative Pro price (and test/live mode) from the Stripe Price so the pricing card never hardcodes an amount |
| `app/success/page.tsx` | (live `landing/`) post-checkout thank-you page with license-key delivery instructions |
| `lib/license-gen.ts` | (live `landing/`) server-side Ed25519 license-key signer (uses `ARTHA_LICENSE_PRIVATE_KEY`); matches the app's `packages/app/src/license/verify.ts` |

---

## Key external dependencies

| Package | Used in | Purpose |
|---------|---------|---------|
| `electron` (41.x) | app | Desktop runtime — pinned to 41.x: it is the newest Electron whose V8 the SQLite driver compiles against (42 is not yet supported by better-sqlite3) |
| `better-sqlite3` (12.x) | app | Synchronous SQLite driver (native module — rebuilt against Electron's ABI via the root `postinstall` hook) |
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
