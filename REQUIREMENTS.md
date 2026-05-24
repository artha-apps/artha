# Artha — Production Launch Requirements

**Status:** Draft v2
**Owner:** Noopur Trivedi
**Target Phase 1 launch:** Within 2 weeks of approval
**Last updated:** 2026-05-24

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

- [ ] `git tag v0.1.0 && git push --tags` produces three installers attached to a public GitHub Release with no manual build step.
- [ ] `artha.vercel.app` (or chosen domain) loads under 1s and shows OS-detected download button linking to the correct asset.
- [ ] Installing the macOS DMG on a clean machine opens Artha and the app connects to local Ollama.
- [ ] Releasing v0.1.1 causes an installed v0.1.0 instance to display an update notification within the first launch.
- [ ] Total monthly recurring cost ≤ $1.

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

---

## 10. Approval

Approval of this document authorizes Phase 1 deliverables D1–D6. Phase 2 and Phase 3 require separate approval before any spend is incurred.

| Role | Name | Decision | Date |
|---|---|---|---|
| Owner | Noopur Trivedi | ⬜ Approve / ⬜ Revise | |
