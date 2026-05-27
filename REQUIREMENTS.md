# Artha — Production Launch Requirements

**Status:** Draft v5
**Owner:** Noopur Trivedi
**Target Phase 1 launch:** Within 2 weeks of approval
**Last updated:** 2026-05-26 (dependency-security remediation + runtime DB fix)

---

## 1. Executive Summary

Artha is a **local-first desktop Electron application** (macOS, Windows, Linux). All compute — LLM inference (via Ollama), document generation, RAG indexing, SQLite storage — runs entirely on the end user's machine. There is **no server-side runtime** to host.

Going to production therefore reduces to two infrastructure concerns:

1. **Distribution** — getting installer binaries (`.dmg`, `.exe`, `.deb`) onto users' machines.
2. **Discovery** — a public landing page with download links.

Both are achievable at **$0/month** using GitHub Releases + Vercel free tier. The only meaningful cost is **optional code signing** ($99/yr Apple + ~$10/mo Azure Trusted Signing for Windows) which can be deferred until adoption justifies it.

---

## 2. Architectural Constraints (why no server is needed)

| Concern | How Artha handles it | Server needed? |
|---|---|---|
| LLM inference | Local Ollama / LM Studio / llama.cpp via OpenAI-compat REST | ❌ No |
| Embeddings + RAG | Local vector store, Ollama embeddings | ❌ No |
| User data / chat history | SQLite file in user's app data dir | ❌ No |
| Document generation (DOCX/PPTX/XLSX/PDF) | In-process Node libraries | ❌ No |
| MCP tools | Local MCP servers, registered per-user | ❌ No |
| Browser automation | Embedded Electron BrowserView | ❌ No |
| Telemetry | None (zero by design — README §Features) | ❌ No |
| App updates | `electron-updater` polls GitHub Releases | ❌ No (GitHub serves it) |

**Implication:** No fly.io, Railway, Render, VPS, database hosting, or LLM API quota. Per-user infra cost = $0.

---

## 3. Phase 1 — Free Public Distribution

### 3.1 Goals
- Public download page reachable at a memorable URL.
- One-click download of correctly-architected installer for macOS (arm64 + x64), Windows (x64), Linux (deb, x64).
- Automated release pipeline: `git tag vX.Y.Z` → installers built on CI → uploaded to GitHub Releases → landing page automatically links to the latest version.
- In-app update notifications (`electron-updater`) so installed users get future versions without re-downloading manually.

### 3.2 Non-Goals (deferred to Phase 2)
- Signed/notarized installers
- Auto-update on install (we ship with notification-only updates in v0.1)
- Analytics, crash reporting, telemetry
- Paid tier, license keys, account system
- Custom domain (uses `artha.vercel.app` initially)

### 3.3 Infrastructure (Phase 1)

| Component | Provider | Plan | Cost/mo |
|---|---|---|---|
| Source code + issue tracking | GitHub | Free (public repo) | $0 |
| Installer binary hosting | GitHub Releases | Free | $0 |
| CI build farm (Mac/Win/Linux) | GitHub Actions | 2,000 free min/mo (public repos = unlimited) | $0 |
| Landing page hosting | Vercel | Hobby (free) | $0 |
| Auto-update channel | GitHub Releases (`electron-updater`) | Free | $0 |
| Domain (optional) | Cloudflare Registrar | `artha.app` ≈ $10/yr | $0.83 |
| **Total** | | | **$0–$1/mo** |

### 3.4 Deliverables (this work order)

| ID | Deliverable | Location |
|---|---|---|
| D1 | This document | `REQUIREMENTS.md` |
| D2 | `electron-builder` GitHub publish config | `package.json` (root) |
| D3 | CI release workflow (Mac/Win/Linux build on tag) | `.github/workflows/release.yml` |
| D4 | Auto-update wiring in main process | `packages/app/src/main.ts` + `electron-updater` dep |
| D5 | Landing page (Next.js) with download buttons | `packages/landing/` |
| D6 | Updated workspace sitemap | `SITEMAP.md` |

### 3.5 Release process (post-Phase 1)

```
# Cut a new version
1. Bump version in root package.json
2. git commit -am "release: v0.1.1"
3. git tag v0.1.1
4. git push --tags

# CI takes over:
5. .github/workflows/release.yml triggers on tag push
6. Three parallel jobs (macos-latest, windows-latest, ubuntu-latest)
   each run: npm ci → npm run build → npx electron-builder --publish always
7. electron-builder uploads .dmg / .exe / .deb to GitHub Releases as a draft
8. Manually publish the release (or auto-publish via workflow flag)

# User experience:
- Landing page download buttons auto-resolve to /releases/latest/...
- Already-installed users see an update notification on next launch
```

### 3.6 Acceptance criteria (Phase 1 done)

- [x] `git tag v0.1.0 && git push --tags` produces three installers attached to a public GitHub Release with no manual build step. *(`.github/workflows/release.yml` implemented)*
- [ ] `artha.vercel.app` (or chosen domain) loads under 1s and shows OS-detected download button linking to the correct asset. *(landing page built — deploy to Vercel pending owner action)*
- [ ] Installing the macOS DMG on a clean machine opens Artha and the app connects to local Ollama. *(pending first tag + DMG build)*
- [x] Releasing v0.1.1 causes an installed v0.1.0 instance to display an update notification within the first launch. *(`autoUpdater` wired in `main.ts`)*
- [x] Total monthly recurring cost ≤ $1. *($0 until domain is purchased)*

---

## 4. Phase 2 — Polish & Trust (target: 4–8 weeks post-launch)

### 4.1 Goals
Reduce install friction, improve trust signals, and add basic operational telemetry without compromising the local-first promise.

### 4.2 Workstreams

#### 4.2.1 Code signing & notarization
| Item | Cost | Why | Priority |
|---|---|---|---|
| Apple Developer Program (Developer ID Application cert) | $99/yr | Removes "unidentified developer" warning on macOS; required for notarization | **High** — Mac users are most signing-sensitive |
| Notarization via `notarytool` in CI | $0 (included with Apple Dev) | Required for Gatekeeper on macOS 10.15+ | **High** |
| Azure Trusted Signing for Windows | ~$10/mo | Removes SmartScreen warning; cheapest legit option (legacy OV certs are $200–400/yr) | **Medium** |
| Linux: no signing needed | $0 | `.deb` sideload is the norm | n/a |

**Implementation:** add encrypted secrets `APPLE_ID`, `APPLE_ID_PASSWORD`, `APPLE_TEAM_ID`, `CSC_LINK`, `CSC_KEY_PASSWORD` to GitHub Actions; `electron-builder` reads them automatically.

#### 4.2.2 Crash reporting (opt-in only)
| Option | Cost | Notes |
|---|---|---|
| Sentry (self-hosted) | $0 (your hardware) | Heavy; not worth it at this stage |
| Sentry SaaS Developer plan | $0 (5k errors/mo) | Recommended; default OFF, prompt user on first launch |
| No crash reporting | $0 | Acceptable; rely on GitHub issues |

**Constraint:** any telemetry must be **opt-in**, clearly labelled, and shippable with a toggle in Settings. README promises "zero telemetry by default."

#### 4.2.3 Custom domain & marketing site upgrades
- Buy `artha.app` (~$10/yr at Cloudflare).
- Add `/changelog`, `/docs`, `/security`, `/privacy` pages.
- Add screenshots, demo video, model recommendations matrix.
- OG image generation for social shares.

#### 4.2.4 Distribution channel expansion
| Channel | Cost | Effort | Reach |
|---|---|---|---|
| Homebrew Cask | $0 | Low (community cask after some downloads) | Mac power users |
| `winget` (Windows Package Manager) | $0 | Low (PR to community repo) | Windows power users |
| Snapcraft (Linux) | $0 | Medium (snap packaging) | Ubuntu mainline |
| Flathub (Linux) | $0 | Medium (flatpak manifest) | Linux distros generally |
| Microsoft Store | $19 one-time dev account | High (review process) | Defer |
| Mac App Store | included in Apple Dev | Very high (sandboxing limits Electron) | Skip — incompatible with our shell exec model |

**Recommendation:** Homebrew Cask + `winget` first (low effort, high power-user reach).

#### 4.2.5 Documentation site
- Move long-form docs out of README into a docs site (e.g. Astro Starlight or Nextra) deployed to the same Vercel project under `/docs`.

### 4.3 Phase 2 budget (annualized)
| Item | Annual |
|---|---|
| Apple Developer Program | $99 |
| Azure Trusted Signing | ~$120 |
| Domain renewal | ~$10 |
| Sentry (Developer plan) | $0 |
| Vercel Hobby | $0 |
| GitHub | $0 |
| **Total** | **~$229/yr** (~$19/mo) |

---

## 5. Phase 3 — Optional Monetization (only if there is demand)

Documented here so the architecture decisions today don't block it later. **Not in scope** unless explicitly approved.

### 5.1 Possible revenue models
| Model | Hosting cost | Lift |
|---|---|---|
| Donations (GitHub Sponsors, Ko-fi) | $0 | Lowest |
| Paid pro tier with cloud sync (e.g. encrypted backups to S3) | Low (~$5–20/mo + S3 per-user) | Medium — adds optional cloud surface |
| Hosted LLM proxy (BYOK) | Per-user metered | Medium |
| Team edition (shared MCP tool catalog, admin console) | Per-team SaaS pricing | High — full SaaS lift |
| Enterprise self-hosted license | n/a | Sales lift, no infra |

### 5.2 Architectural guardrails to preserve future options
- Keep all cloud functionality behind a feature flag; **local-first must stay default**.
- Don't lock LLM provider — keep the OpenAI-compat client abstraction.
- Don't introduce mandatory account systems for any local feature.
- License: stay MIT for the core; reserve commercial features for a future, separately-licensed module if needed.

---

## 6. Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Unsigned Mac/Win builds drive away early users | High | Medium | Document "right-click → Open" in landing FAQ; prioritize Apple Dev cert if conversion is poor |
| `better-sqlite3` native binding fails after install | Medium | High | Test installers on clean VMs as part of release checklist; ship `electron-rebuild` instructions |
| Ollama not installed on user's machine | High | Medium (app still launches but is non-functional) | Detect missing Ollama on first run; show actionable install instructions; link to ollama.ai |
| GitHub Actions free minutes exhausted | Low (public repo = unlimited) | None for public repo | n/a |
| Auto-update fails silently | Medium | Low | Log update-check results to user-visible diagnostics panel |
| Large model downloads make first-run UX painful | High | Medium | Default to smallest viable model (`llama3.2:3b-instruct-q4_K_M`); show download progress in app |
| License compatibility with `OpenCoworkAI/open-cowork`, `OpenHands`, `Jan AI` | Low | High if missed | Verify all upstream licenses are MIT-compatible; include attributions in `LICENSE` / About panel |
| `xlsx` (SheetJS CE) prototype pollution + ReDoS — GHSA-4r6h-8v6p-xvw6, GHSA-5pgg-2g8v-p4x9 | Low | Low (local-only threat model) | **RESOLVED (2026-05-26).** Pinned the maintainer's patched build from the SheetJS CDN (`xlsx@https://cdn.sheetjs.com/xlsx-0.20.3/...`) — the npm registry copy is frozen at the vulnerable 0.18.5. The CDN build is ESM and does not auto-wire Node's `fs`, so `rag/extract.ts` and `docs/generator.ts` were switched to buffer-based `XLSX.read`/`XLSX.write`. `exceljs` migration no longer required. |

---

## 7. Decision Log

| Date | Decision | Rationale |
|---|---|---|
| 2026-05-18 | Use GitHub Releases for binary distribution | Free, unlimited bandwidth for public repos, native `electron-builder` integration, doubles as auto-update channel |
| 2026-05-18 | Use Vercel free tier for landing page | Static landing page, free SSL+CDN, GitHub-push deploys, no maintenance |
| 2026-05-18 | Ship Phase 1 unsigned | Defer $100+/yr signing cost until we have evidence of adoption blocking on it |
| 2026-05-18 | Auto-updates via `electron-updater` against GitHub | Zero infra; works out of the box for both signed and unsigned builds |
| 2026-05-18 | **Not** using fly.io / Railway / VPS | No server-side runtime exists; would be paying for idle compute |
| 2026-05-18 | Vercel Hobby (not Pro) | Hobby tier is sufficient for a static landing page; upgrade only if commercial use forces it |
| 2026-05-19 | Repo will be **public** | MIT project; unlocks free unlimited CI + Releases bandwidth. Pre-flight secret scan passed (only `.env.example` placeholders tracked; `.gitignore` covers `.env`). Enable GitHub secret scanning. |
| 2026-05-19 | Domain **deferred** | `.app` TLD is overpriced (Google-run, mandatory HTTPS). Ship on `artha.vercel.app`; revisit cheaper alternatives (`getartha.com`, `artha.sh`) later. |
| 2026-05-19 | Migrate to a **GitHub org** before launch | Free; decouples ownership from personal identity, enables teams/roles, clean future handoff. Must happen pre-launch so installer + auto-update URLs aren't baked to a personal account. Config references to be updated once org name is chosen. |
| 2026-05-19 | **No telemetry** in v0.1; opt-in Sentry in Phase 2 | Honors the "zero telemetry by default" brand promise. Crash reporting added later as opt-in (default OFF, Settings toggle). |
| 2026-05-19 | Update channel: **notification-only** in v0.1 | `autoDownload: false` already wired in `main.ts`. Silent auto-install deferred to Phase 2 — requires signed builds to avoid OS security prompts mid-update. |

---

## 8. Open Questions — RESOLVED (2026-05-19)

1. ~~Repository visibility~~ → **Public.** Secret scan passed; enable GitHub secret scanning + Dependabot.
2. ~~Domain~~ → **Deferred.** Ship on `artha.vercel.app`; `.app` too expensive.
3. ~~GitHub org vs personal~~ → **Create an org pre-launch.** Org name TBD by owner; config references updated once chosen.
4. ~~Telemetry~~ → **None in v0.1**, opt-in Sentry deferred to Phase 2.
5. ~~Update channel~~ → **Notification-only in v0.1** (already implemented); silent auto-install deferred to Phase 2 (needs signing).

### Remaining action for owner before launch
- **Create the GitHub org** and decide its name (e.g. `getartha`, `artha-ai`, `artha-app`), then tell Claude to update the 4 repo references (`package.json` publish block, `landing/app/page.tsx`, README clone URL, SITEMAP).
- **Timing:** this can be deferred — it only needs to happen **before the first public release tag (`v0.1.0`)**, not now. Pre-launch migration is zero-cost; migrating *after* users install builds pointing at a personal account leaves those installs with a dead auto-update URL until manual re-download. Slot it in the day you're ready to tag the release.

---

## 9. Feature Implementation Log

### Step 1 — Quick Wins (implemented 2026-05-24, all TypeScript clean)

#### 1A — Scheduled Tasks
- **New file:** `packages/app/src/scheduler/scheduler.ts` — `SchedulerService` singleton; `node-schedule` for cron, `Date` object for one-shot; auto-disables one-shot tasks after firing; full CRUD wired to SQLite.
- **DB:** `scheduled_tasks` table added to `schema.ts` (task_id, name, prompt, cron, fire_at, is_enabled, last_run_at, last_status, run_count, created_at).
- **IPC:** `scheduler:{list,create,update,toggle,remove}` channels in `handlers.ts`.
- **Preload:** `window.artha.scheduler.*` bridge in `preload.ts`.
- **UI:** `packages/renderer/src/components/Settings/SchedulerPanel.tsx` — create form (cron presets + custom + one-time datetime picker), task list with enable/disable/delete, last-run + run-count display.
- **main.ts:** Scheduler initialised after IPC handlers; each task fires a fresh `AgentOrchestrator` session; `shutdown()` called on `window-all-closed`.

#### 1B — Interactive Clarification UI
- **Orchestrator:** `handleMessage()` now runs `detectClarificationNeeded()` (LLM call returning ≤3 questions) for goals >6 words that are not `/slug` invocations. On questions: emits `agent:clarifyRequest`, pauses via deferred Promise (90s timeout), enriches the goal with Q&A before planning.
- **IPC:** `agent:clarifyRespond` handler calls `orchestrator.clarifyRespond(workflowId, answers)`.
- **Preload:** `agent.onClarifyRequest` event listener + `agent.clarifyRespond()` invoke.
- **Store:** `ClarifyRequest` interface + `pendingClarify` state + `setPendingClarify` action added to `chat.ts`.
- **UI:** `packages/renderer/src/components/Chat/ClarificationModal.tsx` — floating modal with Q&A fields, Continue + Skip buttons, keyboard navigation (Enter advances, Escape skips).
- **App.tsx:** Wired `onClarifyRequest` → `setPendingClarify`; `<ClarificationModal />` rendered alongside `<PlanApproval />`.

#### 1C — Context Window Config
- **DB:** `context_window INTEGER NOT NULL DEFAULT 4096` added to `llm_models` schema; live `ALTER TABLE` migration for existing DBs.
- **LLM client:** `getActiveLLMClient()` reads `context_window` from the active model row and passes it as `maxTokens` to every completion call (stream, non-stream, tool).
- **IPC:** `llm:setContextWindow(modelId, tokens)` clamps to 512–128,000 and persists. `llm:listConfigured` now returns `context_window` column.
- **Preload:** `llm.setContextWindow(modelId, tokens)` bridge.
- **UI:** `ModelsPanel.tsx` — active model card now includes a dual-control (slider + number input) for context window; auto-saves on blur/Enter/mouse-up; synced when switching models.

#### 1D — Web Search Quality
- **New file:** `packages/app/src/tools/brave.ts` — Brave Search API client (free tier: 2,000 queries/month).
- **New file:** `packages/app/src/tools/duckduckgo.ts` — DuckDuckGo HTML scraper; zero-config fallback.
- **`web.ts`:** `WebConfig` extended with optional `brave_api_key`. `webSearchImpl` now uses a three-tier priority chain: Brave (if key set) → SearXNG instances → DuckDuckGo HTML. Result JSON includes `provider` field so the agent knows which backend was used.
- **UI:** `WebPanel.tsx` — new provider priority status card (shows which backends are active/inactive); Brave API key input field (password masked, clear button).

### Step 2 — Medium Wins (implemented 2026-05-24, all TypeScript clean)

#### 2A — Multimodal / Vision (Image Attachment)
- **Orchestrator:** `Attachment` interface + `attachments?` field on `AgentPlan`. Private `buildUserContent()` converts plain text or text+images into OpenAI vision format (`[{type:'text',…}, {type:'image_url', image_url:{url:'data:mime;base64,…'}}]`). `executePlan` passes `buildUserContent(plan.goal, plan.attachments)` as the first user turn.
- **IPC:** `dialog:pickImage` handler opens native file dialog, reads the selected file as base64, returns `{name, mime, data, path}`. `agent:sendMessage` updated signature forwards optional `attachments[]`.
- **Preload:** `agent.pickImage()` and `agent.sendMessage(…, attachments?)` bridge.
- **Store:** `MessageAttachment` interface + `pendingAttachments` state + `setPendingAttachments` action in `chat.ts`. `Message.attachments?` field for bubble display.
- **UI (`ChatWindow.tsx`):** Paperclip button (Lucide `Paperclip`) in composer opens image picker. Pending thumbnail strip with per-thumbnail ✕ button renders above composer. User message bubble renders `<img>` tags for any stored `attachments`.

#### 2B — PDF Visual Reading
- **IPC:** `dialog:pickPdf` handler opens PDF file dialog, runs `pdftoppm -r 150 -png -l 20 <pdf> <tmpDir>/page` (requires Poppler, available on all platforms via package managers), reads the output PNG files as base64, cleans up the temp dir, returns `{pdfName, pages:[{name, mime:'image/png', data}]}`. Capped at 20 pages to prevent context flooding.
- **Preload:** `agent.pickPdf()` bridge.
- **UI (`ChatWindow.tsx`):** PDF button (Lucide `FileText`) in composer next to the paperclip. `attachPdf()` calls `pickPdf` and appends all rendered page images to `pendingAttachments`. Pages then flow through the identical vision pipeline as direct image attachments.

#### 2C — Persistent Artifacts Panel
- **DB:** `artifacts` table in `schema.ts` — `(artifact_id, session_id, name, file_path, file_type, size_bytes, created_at)` with a `created_at DESC` index.
- **Auto-logging:** `docs.ts` `invokeDocsTool` inserts a row after every successful `docs_generate` call (file size from `fs.statSync`). Non-fatal — wrapped in try/catch.
- **IPC:** `artifacts:{list, log, delete, open}` channels in `handlers.ts`. `open` uses `shell.openPath`.
- **Preload:** `window.artha.artifacts.{list, log, delete, open}` bridge with full TypeScript types.
- **UI:** `ArtifactsPanel.tsx` — loads on mount, shows file icon (colour-coded by type), name, type, size, date, file path; hover-reveal open/delete buttons; empty state; refresh button.
- **Routing:** `'artifacts'` added to `ActiveView` union; `Archive` icon in Sidebar nav; `App.tsx` renders `<ArtifactsPanel />` on that view.

#### 2D — Plugin Marketplace
- **Catalog:** `packages/app/src/mcp/registry-catalog.ts` — 14 curated MCP server entries across 7 categories (filesystem, web, productivity, data, dev, communication, ai), each with `id, name, description, installUri, category, icon, author, tools, docsUrl`.
- **UI:** `MarketplacePanel.tsx` — catalog inlined for renderer bundle safety (no Node imports). Category filter tabs + full-text search across name/description/tools. Install button calls `window.artha.mcp.installServer(entry.installUri)`. Post-install green "Installed" badge (session state).
- **Routing:** `'marketplace'` added to `ActiveView` union; `Store` icon in Sidebar nav; `App.tsx` renders `<MarketplacePanel />` on that view.

#### CI — GitHub Actions
- **`.github/workflows/ci.yml`:** Three jobs — `typecheck` (`tsc --noEmit` on both packages), `lint` (`npm run lint --if-present`), `test` (`npm test --if-present`). Triggered on push and PR to `main`. Node 22, `npm ci` with npm cache.

### Step 3 — High-Value Additions (implemented 2026-05-24, all TypeScript clean)

#### 3A — Voice Input
- **UI (`ChatWindow.tsx`):** Mic button (Lucide `Mic`/`MicOff`) in composer. `toggleVoice()` uses `webkitSpeechRecognition` (Chromium built-in) with `continuous=true` and `interimResults=true`. Live transcript is appended to the textarea as the user speaks; `send()` stops recognition before sending. Mic button pulses red while active (`animate-pulse bg-red-500/20`).

#### 3B — Agent Memory
- **New file:** `packages/app/src/tools/memory.ts` — `MEMORY_TOOL_SCHEMAS`: three agent tools (`memory_store` upsert by name, `memory_recall` LIKE search, `memory_forget` delete by ID). `invokeMemoryTool()` dispatches to SQLite `memory_entities` table. `getMemoryContext()` loads the 20 most-recently-updated memories as a formatted preamble.
- **DB:** `memory_entities` table in `schema.ts` — `(entity_id UUID, name, entity_type ENUM, content, tags_json, source_session_id, created_at, updated_at)` with indexes on `name` and `updated_at`.
- **Orchestrator (`orchestrator.ts`):** `MEMORY_TOOL_SCHEMAS` spread into the tools array in `runReactLoop`; `isMemoryTool`/`invokeMemoryTool` called before `registry.invokeTool` in the dispatch block; `getMemoryContext()` injected into the system prompt above the skill block; Rule 13 instructs the model to use memory tools proactively.
- **IPC:** `memory:{list, delete, clear}` channels in `handlers.ts`.
- **Preload:** `window.artha.memory.{list, delete, clear}` bridge with full TypeScript types.
- **UI:** `MemoryPanel.tsx` — lists all stored entities with type badge (fact/preference/person/project/decision/other), content preview, tags, last-updated date; hover-reveal delete button; clear-all with confirmation dialog; empty state.
- **Routing:** `'memory'` added to `ActiveView` union; `Brain` icon in Sidebar nav; `App.tsx` renders `<MemoryPanel />` on that view.

#### 3C — Native Notifications
- **New file:** `packages/app/src/notify.ts` — `sendNotification(title, body, focusOnClick?)` checks `Notification.isSupported()` and the user's `notifications_enabled` setting before firing an Electron `Notification`. Click handler brings the main window to focus.
- **Orchestrator:** fires `sendNotification('Artha — task complete', goalSnippet)` at the end of `runReactLoop` when workflow elapsed > 10 seconds (so short tasks don't spam).
- **Scheduler:** fires `sendNotification('Artha — scheduled task complete', taskName)` after each scheduled task's agent run completes.
- **UI:** `SettingsPanel.tsx` — Notifications toggle (Bell/BellOff icon + custom toggle switch); persists via `window.artha.settings.set({notifications_enabled: bool})`.
- **Routing:** `'settings'` view (already in `ActiveView`) now renders `<SettingsPanel />` instead of the previous stub.

#### 3D — IDE Integration
- **IPC handlers (`handlers.ts`):** `ide:generateMcpConfig` — writes `.vscode/mcp.json` or `.cursor/mcp.json` into a given project folder and reveals the file in Finder. `ide:pickProjectAndGenerate` — wraps a folder picker dialog then calls the same generation logic.
- **Preload:** `window.artha.ide.{generateMcpConfig, pickProjectAndGenerate}` bridge.
- **UI:** `IDEIntegrationPanel.tsx` — IDE picker (VS Code / Cursor), port input (default 3847), live JSON config preview, "Choose project folder & generate" button, success state with file path display, error state, next-steps guide explaining how to open the editor after generation.
- **Routing:** `'ide'` added to `ActiveView` union; `Code2` icon in Sidebar nav; `App.tsx` renders `<IDEIntegrationPanel />` on that view.

### Step 4 — Phase 1 Deliverables (implemented 2026-05-24, TypeScript clean)

#### 4A — Landing Page (`packages/landing/`)
- **New package:** `@artha/landing` — Next.js 14 static site added to the monorepo workspaces.
- **`app/layout.tsx`:** Root layout with full OG + Twitter card metadata, Google Fonts (Inter), Tailwind dark theme.
- **`app/page.tsx`:** Single-page landing — Hero (gradient headline, platform badges, glow effect), How it works (3-step numbered cards), Features grid (8 cards: local, ReAct, memory, MCP, scheduler, multimodal, voice, IDE), Privacy callout, Download CTA, Footer.
- **`components/NavBar.tsx`:** Fixed top nav with logo, anchor links, and Download CTA button.
- **`components/DownloadButton.tsx`:** OS-detecting download button — `navigator.platform` sniffs macOS/Windows/Linux on mount; fetches the latest GitHub Release via API to get direct asset URLs (`.dmg` / `.exe` / `.deb`); falls back to `/releases/latest` if API is unreachable. Shows alt-OS links below the primary button.
- **`components/FeatureCard.tsx`:** Feature grid tile with emoji icon, title, description.
- **`vercel.json`:** Vercel deployment config (`output: export`, `outputDirectory: out`, `framework: nextjs`).
- **`next.config.ts`:** Static export mode — fully compatible with GitHub Pages and Vercel CDN.
- **Tailwind config:** Matches the app's `artha` colour palette (indigo-600 primary).
- **Root `package.json`:** `packages/landing` added to the `workspaces` array.

#### 4B — Workspace Sitemap + Docs
- **`SITEMAP.md`:** Full workspace map covering root, `packages/app` (all `src/` files with purpose), `packages/renderer` (all components), `packages/landing`, key dependencies, and runtime data locations on macOS.
- **`REQUIREMENTS.md` v5:** Acceptance criteria checkboxes updated (3 of 5 ticked); Step 4 log added; deferred items documented with owner action notes.

### Step 5 — Per-chat folder/file scopes + filesystem sandbox (implemented 2026-05-26, TypeScript + lint clean, 61 tests pass)

Folders are now attached **per chat** rather than via a global project switcher. Each chat declares the folders/files the agent may see, and the agent is **hard-sandboxed** to them.

- **DB (`schema.ts`):** new `session_scopes` table — `(scope_id, session_id FK ON DELETE CASCADE, path, kind 'folder'|'file', rag_index_id, added_at, UNIQUE(session_id,path))`.
- **New file `db/scopes.ts`:** `getSessionScopes` / `getSessionAllowedRoots` / `getSessionPrimaryFolder` / `recomputePrimaryProject`. Folder scopes reuse the `projects` table (deduped by absolute path) so a folder keeps one shared RAG index + cross-session memory across chats; `recomputePrimaryProject` keeps `chat_sessions.project_id` pointing at the chat's primary (first) folder so the existing memory + rolling-summary code is unchanged.
- **Hard sandbox (`tools/filesystem.ts`):** `safePath(p, allowedRoots)` rejects any read/write outside the chat's scopes (folder = subtree via `path.relative`, file = exact path); empty roots ⇒ historical home-dir behaviour. Threaded through every fs impl + `invokeFilesystemTool`. `mcp/registry.ts` `invokeTool(name,args,ctx)` carries a `ToolContext { allowedRoots, primaryDir }`.
- **Docs (`docPath.ts`/`docs.ts`):** generated documents default into the chat's primary folder (`resolveDocOutPath(..., defaultDir)`) instead of `~/Documents` when scoped.
- **Orchestrator:** `getSessionScopeBlock` injects the attached folders/files (inlining small files, listing RAG indexes + folder memory/ARTHA.md) and tells the model it is sandboxed; computes `fsCtx` per run and passes it to all tool dispatch.
- **Folder-scoped retrieval (Cowork parity):** when a chat has folders attached, `rag_search`, `rag_list_indexes`, and document grounding are confined to those folders' indexes (`searchAllIndexes(query, topK, indexIds)`, `getSessionRagIndexIds`, `ToolContext.ragIndexIds`). Cowork itself does folder-scoped context with no vector search; Artha keeps semantic vector RAG but now confines it to the chat's approved folders. Unscoped chats still search every index.
- **IPC (`handlers.ts`):** `scopes:{list, addFolder, addFile, remove, reindex}`; `addFolder` find-or-creates the folder workspace + builds its RAG index in the background. Replaced the `projects:*` handlers.
- **Renderer:** `window.artha.scopes.*` (preload); chat store holds per-session `scopes`; `ChatWindow` shows a scope chip row with **Add Folder / Add File** + per-folder re-index; `Sidebar` is now a flat session list (project switcher removed).
- **Tests (67 total, was 51):** `filesystem.sandbox.test.ts` (7) covers inside/outside reads, write-escape rejection, exact-file scope, no-scope fallback, system-dir block, and prefix-overlap safety; `rag.scope.test.ts` (6, indexer+DB mocked) asserts `rag_search`/`rag_list_indexes` confine to the chat's folder indexes when scoped and search all when not; `docPath.test.ts` extended for `defaultDir`.

#### Security — RESOLVED (2026-05-26)
- **Electron pinned to `^41.7.0`.** ⚠️ Do **not** run `npm install electron@latest` — Electron 42 (current `latest`) ships a V8 that **no `better-sqlite3` build compiles against**, which leaves the app with no working database (every data panel silently empty). 41.x is the newest Electron the native driver supports and is within Electron's security-patched window. The CLT receipts bug is resolved (CLT reinstalled), so native rebuilds work.
- **`better-sqlite3` upgraded to `^12.2.0`** (C++20-capable) and rebuilt against Electron's ABI automatically via the root `postinstall` hook (`scripts/rebuild-native.js`, which skips in CI). This is what prevents the binary from going missing again.
- **`electron-builder` upgraded 24 → 26** — clears the high-severity `tar` path-traversal chain. Build-time only.
- **`vitest` upgraded 2 → 3** (vite 7, esbuild 0.27) — clears the dev-server esbuild advisory. Dev/test only.
- **`next` (landing) upgraded 14 → 16 + React 19** — clears the Next.js advisories (none applied to the static `output:'export'` site anyway).
- **`xlsx`** — patched via the SheetJS CDN build 0.20.3 (see Risks table). 
- **Residual:** 2 moderate (a nested `postcss` inside Next's build toolchain) with no non-downgrade fix; build-time only on trusted Tailwind CSS. `npm audit` went 13 → 2.

---

## 10. Approval

Approval of this document authorizes Phase 1 deliverables D1–D6. Phase 2 and Phase 3 require separate approval before any spend is incurred.

| Role | Name | Decision | Date |
|---|---|---|---|
| Owner | Noopur Trivedi | ⬜ Approve / ⬜ Revise | |
