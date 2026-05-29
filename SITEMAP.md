# Artha — Workspace Sitemap

> Last updated: 2026-05-28 (added licensing / tier entitlements, forked onboarding, org-hub packaging)

## Root

| Path | Purpose |
|------|---------|
| `package.json` | Root monorepo manifest — workspaces, electron-builder config, dev scripts |
| `package-lock.json` | Lockfile |
| `REQUIREMENTS.md` | Living product spec / implementation log |
| `SITEMAP.md` | This file |
| `README.md` | Public-facing overview (install, usage, contributing) |
| `Dockerfile.hub` | Interim container build for the org hub — wraps the Electron app in `xvfb` so the LAN server runs headlessly until the Phase 2 native-headless service ships |
| `assets/` | App icons — `icon.icns` (macOS), `icon.ico` (Windows), `icon.png` (Linux) |
| `scripts/sign-license.mjs` | Offline seller-side CLI — `--genkeys` mints the Ed25519 keypair once; `--tier/--seats/--org/--days` issues a signed license token. Private key stays in `~/.artha-license-key.pem` (gitignored) and never ships |
| `.github/workflows/ci.yml` | CI: typecheck + lint + test on push/PR |
| `.github/workflows/release.yml` | Release: build DMG/EXE/DEB and publish to GitHub Releases on tag push |
| `docs/deploy/org-hub.md` | Runbook for standing up the Enterprise org hub — dedicated-host (Option A, recommended) + interim Docker (Option B), sizing, network, updates, backups, license issuance, member quick-connect |
| `docs/gtm/onboarding/single-client.md` | SOP for B2C / single-customer onboarding — persona=Individual, optional Pro license, upgrade triggers |
| `docs/gtm/onboarding/institution.md` | SOP for B2B / large-institution onboarding — mint org license, customer-operated hub deploy, seat provisioning, renewals |
| `docs/roadmap/phase-2-deferred.md` | The four items Phase 1 deliberately deferred — headless server extraction, SQLite→Postgres, SSO/SAML/OIDC + SCIM, in-app thin-client mode. For each: why deferred, what unblocks it, Phase 2 scope, and which Phase 1 decisions already align so no rework is needed |

---

## `packages/app` — Electron main process

| Path | Purpose |
|------|---------|
| `src/main.ts` | Entry point — BrowserWindow creation, IPC setup, auto-updater, tray |
| `src/preload.ts` | Context bridge — exposes `window.artha.*` API to renderer (zero Node access in renderer) |
| `src/notify.ts` | `sendNotification()` — Electron native notifications with focus-on-click |
| `tsconfig.json` | TypeScript config for main process (CommonJS, Node 20 types) |
| **db/** | |
| `src/db/schema.ts` | SQLite schema + `getDb()` singleton — all `CREATE TABLE` + additive `ALTER TABLE` migrations; opens/migrates the DB on first call |
| `src/db/scopes.ts` | Per-chat scope helpers — `getSessionScopes`/`getSessionAllowedRoots`/`getSessionPrimaryFolder`/`recomputePrimaryProject`; backs the folder/file sandbox + context |
| **agent/** | |
| `src/agent/orchestrator.ts` | `AgentOrchestrator` — ReAct loop, clarification flow, memory + live-environment context injection (date/time/timezone/OS/user), tool dispatch |
| `src/agent/folderTree.ts` | `buildShallowTree()` — renders a shallow, noise-filtered directory tree for the working-scope context block |
| **skills/** | |
| `src/skills/registry.ts` | `SkillRegistry` singleton — loads/creates/toggles YAML skill files, resolves `/slug` + auto-match, filters tool schemas per skill |
| `src/skills/util.ts` | Pure skill helpers — slug normalisation, `/slug` parsing, import parsing, tool-allowlist filtering (unit-tested) |
| **bundles/** | |
| `src/bundles/bundle.ts` | Skill-bundle import/export — HMAC-signed manifest, golden-content hashing, `ENV:` secret stripping |
| **router/** | |
| `src/router/benchmark.ts` | Model capability probes (plan / tool-args / …) that score local Ollama models for the model router |
| **ipc/** | |
| `src/ipc/handlers.ts` | All `ipcMain.handle(...)` registrations (chat, llm, mcp, memory, artifacts, scheduler, ide, lan, cloud, …) |
| **llm/** | |
| `src/llm/client.ts` | `getActiveLLMClient()` — returns an OpenAI-compat client for the active model; respects context_window |
| `src/llm/streamMerge.ts` | Merges streamed tool-call deltas (id+name on first chunk, args appended after) into complete tool calls |
| **mcp/** | |
| `src/mcp/registry.ts` | `MCPRegistry` — manages MCP server processes, tool schemas, invocations |
| `src/mcp/registry-catalog.ts` | 22 curated MCP marketplace entries (filesystem, web, productivity, …) |
| **tools/** | |
| `src/tools/filesystem.ts` | Built-in fs tools (list/search/read/move/copy/delete) — hard sandbox confines reads/writes to the chat's attached scopes when present |
| `src/tools/web.ts` | `webSearchImpl` — three-tier search chain (Brave → SearXNG → DuckDuckGo) + citation collection |
| `src/tools/brave.ts` | Brave Search API client (free-tier tier of the search chain) |
| `src/tools/searxng.ts` | SearXNG JSON search client (self-hosted / public-instance tier) |
| `src/tools/duckduckgo.ts` | DuckDuckGo HTML scraper (zero-config fallback tier) |
| `src/tools/readability.ts` | Mozilla Readability wrapper — strips boilerplate, returns clean markdown |
| `src/tools/docs.ts` | `DOCS_TOOL_SCHEMAS` + `invokeDocsTool` — the `docs_generate` tool; resolves output path + gathers context, then delegates to the generator |
| `src/tools/docPath.ts` | `resolveDocOutPath()` — picks a safe output path for generated docs (blocks system dirs, defaults to the chat's primary folder) |
| `src/tools/memory.ts` | `MEMORY_TOOL_SCHEMAS` + `invokeMemoryTool` + `getMemoryContext` — SQLite entity graph |
| `src/tools/rag.ts` | `rag_search` / `rag_list_indexes` — vector search over local docs; confined to the chat's folder indexes when scoped (else all) |
| `src/tools/ragFormat.ts` | Formats `rag_search` hits + index lists into model-readable text (with snippet truncation) |
| `src/tools/browser.ts` | `BROWSER_TOOL_SCHEMAS` + `invokeBrowserTool` — exposes the embedded browser controller as agent tools |
| `src/tools/desktop.ts` | `DESKTOP_TOOL_SCHEMAS` + `invokeDesktopTool` — mouse/keyboard/screenshot via nut-js + desktopCapturer (opt-in) |
| **browser/** | |
| `src/browser/controller.ts` | `BrowserController` singleton — owns the embedded WebContentsView; attach/detach/bounds + agent⇄user driving handoff |
| `src/browser/actions.ts` | Low-level browser action primitives (navigate/click/type/readDom/screenshot/back/forward/reload/getUrl/waitForSelector) |
| `src/browser/recovery.ts` | Crash/hang recovery policy — decides auto-reload vs crash-loop overlay |
| **rag/** | |
| `src/rag/indexer.ts` | `RagIndexer` — walks a folder, extracts + chunks + embeds files, persists the index |
| `src/rag/extract.ts` | Text extraction from files (txt, pdf via pdf-parse, docx via mammoth) for indexing |
| `src/rag/chunk.ts` | Splits document text into overlapping chunks with stable ids for embedding |
| `src/rag/indexFormat.ts` | `Chunk` type + on-disk index (v2) read/write helpers |
| **docs/** | |
| `src/docs/generator.ts` | `generateDocument()` — renders DOCX (`docx`), PPTX (`pptxgenjs`), XLSX (`xlsx`), PDF (`pdf-lib`) from a spec |
| **scheduler/** | |
| `src/scheduler/scheduler.ts` | `SchedulerService` — cron / one-shot task runner via `node-schedule` |
| **types/** | |
| `src/types/nut-js.d.ts` | Ambient module shim for the lazily-loaded `@nut-tree-fork/nut-js` optional native dep |
| `src/types/rag-extractors.d.ts` | Ambient shims for the pdf-parse internal entry + mammoth (avoids debug-mode fixture read / missing types) |
| **license/** | |
| `src/license/entitlements.ts` | `Tier` (`free` \| `pro` \| `enterprise`), `Entitlements`, `TIER_ENTITLEMENTS` matrix, `FREE_ENTITLEMENTS` fallback. Single source of truth for what each SKU unlocks |
| `src/license/verify.ts` | Ed25519 verification + cached `getEntitlements()` — parses the signed token, rejects tampered/expired, falls back to Free on any failure. Uses Node built-in `crypto`; no network call |
| `src/license/public-key.ts` | Bundled PEM public verification key. Placeholder shipped; rotated via `scripts/sign-license.mjs --genkeys` |
| `src/license/verify.test.ts` | Vitest suite — mints a keypair in-process and tests valid/tampered/expired/wrong-key/garbage paths + entitlement derivation |
| **scripts/** (app-scoped) | |
| `scripts/hub-entrypoint.sh` | Container entrypoint for `Dockerfile.hub` — boots `xvfb` and seeds the license token from `ARTHA_LICENSE_KEY` on first run |

---

## `packages/renderer` — React frontend (Vite + Tailwind)

| Path | Purpose |
|------|---------|
| `src/index.tsx` | React entry point |
| `src/App.tsx` | Root component — view router, IPC event wiring (clarify, update-available) |
| **stores/** | |
| `src/stores/chat.ts` | Zustand store — `ActiveView` union, messages, pending attachments, clarify state, per-chat `scopes` |
| `src/stores/browser.ts` | Zustand store for the embedded browser pane — URL, driving mode (agent/user), handoff state |
| **lib/** | |
| `src/lib/qrcode.ts` | Dependency-free QR encoder (byte mode + Reed-Solomon, v1–10) — `generateQrMatrix` / `qrToSvg` |
| **components/Chat/** | |
| `ChatWindow.tsx` | Composer with send, attach image/PDF, voice mic, per-chat scope chips (add folder/file); message bubble list |
| `ClarificationModal.tsx` | Pre-flight Q&A modal (pauses the agent until user answers or skips) |
| `PlanApproval.tsx` | Approval UI for the ReAct plan before execution |
| `ToolCallInline.tsx` | Inline, collapsible tool-call + result display within the chat stream |
| `Citations.tsx` | Source citations rendered under an agent message |
| **components/Browser/** | |
| `BrowserPane.tsx` | Host for the embedded browser viewport + close control |
| `BrowserToolbar.tsx` | URL bar + nav controls + agent/user driving toggle |
| `HandoffBanner.tsx` | Banner shown when the agent hands the browser to the user (resume / cancel) |
| **components/ExecutionLog/** | |
| `ExecutionLog.tsx` | Live step-by-step view of the ReAct loop's actions |
| **components/Onboarding/** | |
| `Onboarding.tsx` | First-run setup — persona picker (Individual vs Organization admin), then Ollama+model flow for individuals with optional Pro-license paste; routes organization admins to `OrgSetup` |
| `OrgSetup.tsx` | Three-step admin sub-flow — paste org license, start the LAN/hub server, provision seats (mints a `team_members` row + bound API key per teammate, renders copyable connection cards) |
| **components/Sidebar/** | |
| `Sidebar.tsx` | Flat chat-session list + New Chat; nav icons — Chat, Models, MCP, Skills, Web, RAG, Provenance, Artifacts, Marketplace, Memory, IDE, Cloud, LAN Server, Desktop, Team, Settings (folders are attached per chat in the composer) |
| **components/Settings/** | |
| `ModelsPanel.tsx` | Configure LLM models — API key, base URL, context window slider |
| `MCPToolsPanel.tsx` | MCP servers + tool schemas + tool-audit-log tabs; add / remove servers |
| `SkillsPanel.tsx` | Create / edit / delete agent skill files |
| `WebPanel.tsx` | Web search config — Brave key, SearXNG instances, provider status |
| `RAGPanel.tsx` | Index local documents for RAG retrieval |
| `SchedulerPanel.tsx` | Create / edit / toggle / delete scheduled tasks |
| `ArtifactsPanel.tsx` | Browse generated artifacts — open, delete |
| `MarketplacePanel.tsx` | MCP plugin marketplace — search, category filter, install |
| `MemoryPanel.tsx` | Browse agent memory entities — type badges, delete, clear-all |
| `IDEIntegrationPanel.tsx` | Generate `.vscode/mcp.json` or `.cursor/mcp.json` for a project folder |
| `CloudIntegrationsPanel.tsx` | Connect Google Workspace (Gmail/Calendar/Drive) via OAuth — client-id setup, connect/disconnect |
| `LANServerPanel.tsx` | Start/stop the LAN collaboration server — copyable URL, inline QR, curl/fetch examples, autostart |
| `DesktopControlPanel.tsx` | Toggle desktop control (mouse/keyboard/screenshot), test-screenshot preview, tool list |
| `TeamPanel.tsx` | Team mode — members, LAN API keys, shared memories |
| `LicensePanel.tsx` | Apply / replace / clear the offline-signed license key; renders current tier, seats, org, expiry. Surfaces under Workspace Settings → Team → License |
| `SettingsPanel.tsx` | App settings — notifications toggle |
| `ProvenancePanel.tsx` | Source attribution for agent answers (`.artha-receipt.json` sidecar) |
| `TimeTravelPanel.tsx` | Session replay / history — fork a run from any past step |
| `RouterPanel.tsx` | Model router config — benchmark + manual overrides |
| `BundlesPanel.tsx` | Skill bundle management — HMAC-signed export / import |
| `vite.config.ts` | Vite config — React plugin, build output to `dist/` |
| `tailwind.config.js` | Tailwind config — artha colour palette |
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
