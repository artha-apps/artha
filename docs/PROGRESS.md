# Artha — Session Progress & Resume Log

**Last updated:** 2026-06-01
**Branch:** `main` — clean working tree. Last merges: **#19** (auto-publish CI) + **#20** ("Artha is in control" indicators).
**Tests:** 86 passing (`npm test`) · **Typecheck:** clean (`npm run typecheck`)
**Repo:** https://github.com/artha-apps/artha (**PUBLIC**; migrated from `Noopurtrivedi/artha` to the **`artha-apps`** org)
**Current version:** `0.1.16` — tagged `v0.1.16`, release building. `main` at `0d34577`.

> ✅ **Releases now auto-publish** (PR #19): `release.yml` builds the 3 platforms to a draft, then a `publish-release` job flips it to Latest once all succeed — no manual click. (Pre-#19, drafts had to be published by hand; v0.1.14 got stuck that way. v0.1.15 was published manually + the 0.1.14 draft deleted.)

> Resume point for the next session. Read this first to know exactly where we left off.

---

## ⏳ Open reminders / TODOs

- **Windows code signing — revisit when total installer downloads > ~100.** The
  Windows `.exe` is currently UNSIGNED (SmartScreen "unknown publisher" warning;
  still installable). Needs its own **Authenticode** cert — Apple's Developer ID
  does not apply. Recommended: **Azure Trusted Signing** (~$10/mo, CI-native).
  Wire-up point + download-count check are documented in
  `.github/workflows/release.yml` (search `TODO(windows-signing)`).
  Check downloads: `gh release view <tag> --repo artha-apps/artha --json assets --jq '[.assets[].downloadCount] | add'`.
- **Linux:** ready — `.deb` builds on `ubuntu-latest` and publishes; no signing needed.
- **macOS:** signed + notarized via one Developer ID cert (covers both arm64 + Intel x64).

---

## 2026-06-01 — v0.1.16: "Artha is in control" indicators + auto-publish CI

- **#20 control indicators** — `controlOverlay.ts`: full-screen, click-through, always-on-top overlay (glowing border + pill) while desktop control drives the real cursor/keyboard (shown from the orchestrator before each desktop tool, debounced auto-hide). `WorkingIndicator`: window glow + "Artha is working…" pill on `isStreaming` (`z-[90]`, visible over modals). `BrowserPane`: "Artha is browsing this page" ring/label while the agent drives. Verified live (overlay window + in-app pill screenshots).
- **#19 auto-publish CI** — release workflow now flips the draft → Latest automatically after all 3 platform builds succeed (see banner above). v0.1.16 is the first to use it.
- Typecheck + 86 tests + build clean.

---

## 2026-06-01 — v0.1.15: faster local turns + auto-start model + inline model picker

Merged three PRs in order and cut `v0.1.15` (build running).

- **#15 perf** — local turns were 200-400s: aux phases (`plan`/`tool_args`) now route to the smallest installed model; `complete()` uses the native Ollama path so num_ctx matches the ReAct path (no model reload churn between phases); `<think>` skipped for trivial goals. (Companion config applied to the user's profile: active model 72B→7B @ 16K.)
- **#16 auto-start** — `ollamaRuntime.ts`: on launch, start Ollama if down + pre-warm the active model at matching num_ctx (no cold first-message); `model:status` → `ModelStatusBanner`. Free the model on quit (`keep_alive 0`); "Fully stop Ollama when I quit" setting (off) only stops a server WE started. Onboarding no longer says "run `ollama serve`".
- **#18 model picker** — the top-bar chip is now an inline searchable dropdown over all installed + configured models; select upserts+activates any model and pre-warms it. (#17 was the stacked PR; superseded by #18 after rebasing onto main.)
- All verified live (CDP/inspector). 86 tests pass.
- **Release**: `v0.1.15` tagged; **publish the draft** (see banner above) — and the 0.1.14 draft should be deleted as superseded.

---

## 2026-05-31 — v0.1.14 release: working crash reporting + readable onboarding

Cut `v0.1.14` (tag → release.yml builds/signs/publishes) to actually ship the session's work — until this release, the active DSN + fixes lived only on `main` and reached no users.

- **PR #13 (merged)** — made the Sentry opt-out real now that the DSN is live: registered the missing `settings:{getSentry,setSentry,ackSentryDisclosure}` IPC handlers (first-run disclosure + Settings toggle were dead), enforced the runtime kill-switch in `beforeSend`, wired the two dead tag-updaters, extracted `scrubEvent`→`sentryScrub.ts` with tests. **Live-verified** end-to-end (disclosure → toggle → event reached the `artha` project).
- **Init-ordering fix (in #13)** — `@sentry/electron` must init before the `ready` event; moved init to `initTelemetryBeforeReady()` (pre-`whenReady`), made `initDatabase()` idempotent. Without this, Sentry never initialised at all.
- **PR #14 (merged)** — onboarding/org-setup used hardcoded `text-white` on the light theme → invisible headings + blank model rows. Swapped to `text-artha-text`. Live-verified.
- **Housekeeping** — closed stale PR #3 (obsolete 0.2.0 bump); deleted the two Sentry test events (`ARTHA-LIVE-VERIFY*`, ingest test) from the prod project.
- **Sentry project**: org `noopur-trivedi`, project `artha`, US region. DSN committed in `sentry.ts`.

---

## 2026-05-31 — Sentry crash reporting activated (PR #12, merged to `main`)

Stood up the live Sentry project and flipped the integration from dormant to active.

- **Sentry org + project created** (via browser): org **Noopur Trivedi** (`noopur-trivedi.sentry.io`, **US** region — both permanent); project **`artha`**, platform **Electron** (matches `@sentry/electron/main`), team `#noopur-trivedi`, default high-priority alerting.
- **DSN wired** into `packages/app/src/sentry.ts` → `DEFAULT_SENTRY_DSN` now points at the project. Shipped builds report crashes **by default**, still **user opt-out** (one-time disclosure + Settings), still only scrubbed **non-PII** operational data. `ARTHA_SENTRY_DSN` env still overrides; set DSN back to `''` to ship dormant again. The DSN is a public, write-only ingest key — safe to commit.
- **Verified ingest end-to-end**: posted a test envelope to the project endpoint → **HTTP 200**, event accepted (no full Electron build needed). Real crashes from `main` builds now land in the `artha` project.
- **Dependabot**: the push-time "2 moderate" warning was **stale** — API shows **0 open** alerts (all 16 ever-raised are `fixed`, resolved 2026-05-30 by a dep update already on `main`). No action needed.
- PR #12 squash-merged (CI: TypeScript/ESLint/Unit tests/Vercel all green); branch deleted.

---

## 2026-05-30 — v0.1.2 security release (on `chore/security-bumps`, PR #6)

Dependency/security sweep, version bumped `0.1.1` → `0.1.2`, tagged and released.

- **Security bumps** (`551fd11`, `5d2…`-series on 05-26): killed the HIGH `tmp` finding; landing upgraded **Next.js 14 → 16** + React 19 (`2c08ee6`); `postcss` override; `vitest 2 → 3` (vite 7, esbuild 0.27); `electron-builder 24 → 26`; `xlsx` pinned to patched SheetJS CDN build 0.20.3; swapped the dead `@nut-tree/nut-js` for the maintained `@nut-tree-fork/nut-js` (`5d62d1e`).
- **Residual audit findings** are documented as **won't-fix-upstream** in `docs/known-issues/upstream-deps.md` (nut-js → jimp → file-type chain; not reachable in Artha's screenshot-only desktop path).
- **Release**: `v0.1.2` tagged at the bump commit; CI built macOS/Windows/Linux installers; the GitHub release was **published** (was previously a Draft) so the artifacts are publicly downloadable. `0.1.1` was the prior "Latest".
- **Lockfile**: `package-lock.json` version synced to `0.1.2` (committed with this doc update).

**Still open:** PR #6 has not yet merged to `main`. There are parallel branches in flight — `chore/release-0.2.0` (its own PROGRESS restart summary), `feat/ia-tabs-projects-at`, `feat/license-tiers-onboarding`, `docs/planning-docs` (org migration + download-proxy fix).

---

## 2026-05-26 — feature wave 2 (on `main`)

A large batch of capabilities landed after the launch-polish work, all typecheck-clean:

- **Cloud app integrations** (`ca4303a`): Google Workspace OAuth (installed-app PKCE flow, `oauth_tokens` table) for Gmail/Calendar/Drive — `CloudIntegrationsPanel`.
- **LAN collaboration server** (`ca4303a`): `lan:start/stop` on `0.0.0.0:7842` (NDJSON `/chat`, `/skills`, `/health`); `LANServerPanel` with copyable URL + inline QR (dependency-free QR encoder). Distinct from the IDE bridge on `3847`.
- **Parallel subagents** (`ca4303a`): `orchestrator.runParallel` — child session per sub-task, concurrency capped at 4, combined summary; sub-task badge row in `ChatWindow`.
- **Desktop control** (`ca4303a`, opt-in): `tools/desktop.ts` — screenshot/click/type/key/move via `@nut-tree-fork/nut-js`, gated behind `desktop_control_enabled`.
- **Project folders** (`14bae4c`): scoped sessions + project context injection. **Project auto-RAG + cross-session project memory** (`a88daf9`, phases 2-3).
- **Team mode** (`a0abd86`): `team_members` + `api_keys` tables (SHA-256 key hashing), LAN Bearer-token auth (fail-closed when keys exist), `is_shared` memories; `TeamPanel` (Members / API Keys / Shared Memory).
- **70B models** (`aaff5c2`): `qwen2.5:72b`, `llama3.3:70b` added to the catalog.
- **Per-chat folder/file scopes** (`3885dbe`): hard sandbox + folder-scoped RAG; `bbe4c73` seeds folder structure into context + reports real index status.
- **IDE MCP server, persisted marketplace state, Poppler & GPU detection** (`decdfdb`); **Models Browse & Install catalog** + Ollama detection fixes (`1b89b4c`, `b898d17`, `80df139`); **DB engine restore** — pin Electron 41 + better-sqlite3 12 (`d03d78e`).
- **`SITEMAP.md` and `REQUIREMENTS.md` kept current** through this wave (last refreshed `3885dbe`).

---

## 2026-05-24 — feature wave 1 (on `main`)

- **Step 1** (`32a5962`): scheduled tasks, clarification UI, context-window config, search quality.
- **Step 2** (`2ed8126`): multimodal, PDF vision, artifacts panel, plugin marketplace, CI.
- **Step 3** (`adb76b1`): voice input, agent memory, native notifications, IDE integration.
- **Step 4** (`f5f4966`): landing page, SITEMAP, Phase 1 acceptance criteria.

---

## 2026-05-21 (later) — post-launch polish (unreleased, on `main`)

Three follow-ups done after v0.1.0; **not yet tagged** — candidates for a `v0.1.1`:

- **Branded app icons** (`a2133a0`): diya-lamp mark for mac/win/linux, generated by a dependency-free `scripts/gen-icon.js` (supersampled vector render + hand-rolled PNG encoder; sips/iconutil derive icns/ico/png). Build config icon refs restored; local pack confirms the `.app` embeds it (no more default-Electron-icon warning). Regenerate with `node scripts/gen-icon.js`.
- **Crash-recovery hardening + tests** (`3ce9eca`): extracted the crashloop-guard + target-selection into pure `browser/recovery.ts` (7 unit tests); `main.ts` now logs update-available / up-to-date outcomes, not just errors.
- **RAG polish** (`a2cd443`): boundary-aware chunking (`rag/chunk.ts`, 7 tests) — breaks on sentence/word boundaries instead of fixed 512-char slices; ChatWindow shows a `📚 N indexes · M chunks — type /ask` badge near the composer.

**Tests now 51 passing; typecheck clean.** Auto-update was verified to the extent automatable: feeds (`latest*.yml`) valid + reachable, `app-update.yml` correct, wiring sound — but the live runtime log line couldn't be captured (macOS detaches a packaged GUI app's stdout). **Crash-recovery overlay still needs one manual confirmation**: in a dev build, load `chrome://crash` in the browser pane and confirm the reload→overlay path.

---

## 2026-05-21 session — v0.1.0 SHIPPED 🚀

The first public release is live and the launch loose ends are closed:

- **`v0.1.0` released** → https://github.com/Noopurtrivedi/artha/releases/tag/v0.1.0 — macOS dmg (arm64 + x64), Windows nsis `.exe`, Linux `.deb`, plus auto-update `latest*.yml`. Verified anonymously: `releases/latest` 200, `.dmg` 200.
- **Release CI fix** (`96a1427`): first tag failed on all 3 OSes — root `package.json` had no `main` field so electron-builder looked for `index.js`. Added `"main": "packages/app/dist/main.js"` + `author`; dropped `mac/win/linux` icon refs (empty `assets/` → default Electron icon). Verified locally with a real `--dir` pack before re-tagging.
- **BrowserView crash recovery** (`797a890`): `render-process-gone` → one silent reload of last URL → recovery overlay + `browser:recover` IPC if it recrashes within 10s. (Resolves the §1/§10 open item in `docs/requirement.md`.)
- **Smoke test passed** on real hardware (Ollama, `qwen2.5:7b` chosen as the agent default — best tool-calling/streaming of the installed models). Boots clean, DB seeds the 5 built-in skills, streaming/skills/RAG confirmed good by owner.
- **Landing page deployed** → https://artha-zeta-five.vercel.app (Vercel project `artha`; bare `artha.vercel.app` was taken). Download button points at `releases/latest` (now live).
- **Repo made public** after a clean secret scan (working tree + full history: no keys, no committed `.env`). Enabled secret scanning + push protection + Dependabot alerts.

### Decisions made this session
- **GitHub org**: owner chose **stay personal** (`Noopurtrivedi/artha`) for v0.1.0 — §8's deferred org migration is now explicitly punted past launch (note the auto-update-URL caveat if migrating after installs exist).

### Follow-ups (not blocking)
- **Branded app icons**: `assets/` is empty; v0.1.0 ships the default Electron icon. Add `icon.icns/.ico/.png` and restore the icon refs in `package.json` build config before a polished release.
- **Crash recovery is unverified live**: implemented + typechecks, but never exercised against a real renderer crash. Restart the dev app (main process needs reload) and force a page crash to confirm the overlay + reload path.
- macOS/Windows builds are **unsigned** (CI logged skipped code signing) — Gatekeeper/SmartScreen warnings on install until signing is set up (Phase 2 per §8).

---

## TL;DR — where we are

A productive session shipped **production launch infra + a Skills system + a complete local-RAG feature + agent UX upgrades**, all committed and pushed in 7 feature commits. Everything is verified by **typecheck + unit tests**, but **NOT by a live UI run** (the Electron app needs Ollama running locally, which couldn't be exercised in this environment). The single most valuable thing to do on resume is a **manual smoke test on real hardware**.

---

## What shipped this session (newest first)

| Commit | What |
|---|---|
| `5f17816` | **Skill import/export** — share skills as portable `.artha-skill.json`; collision-safe import (unique-slug). |
| `14a0b73` | **Incremental RAG indexing** — per-file MD5 manifest; rebuild only re-embeds changed files. |
| `f7df443` | **Streaming token output** — ReAct loop streams text live via `streamComplete`; `agent:streamReset` suppresses tool-step preamble & verified-summary swaps. |
| `0cdbda1` | **Real text extraction for RAG** — pdf-parse / mammoth / xlsx instead of raw UTF-8 (fixes garbage embeddings for PDF/DOCX). |
| `94c0d62` | **RAG Index panel** — create/rebuild/delete indexes from the UI (native folder picker). |
| `0bb47f7` | **`rag_search` agent tool** — query & cite indexed files in any chat + `/ask` built-in skill. |
| `a6cc9eb` | **Skills system + 4 levers + launch infra** (the big one — see breakdown below). |

### Breakdown of `a6cc9eb` (the foundational commit)
- **Skills system** (Claude-style): `skills` table + `SkillRegistry`; resolve per message via explicit `/slug` or LLM auto-match; instructions injected into plan + execute prompts; optional tool allowlist (prefix-aware). Built-ins: `research`, `organize`, `summarize`, `report` (+ `ask` added later). UI: `SkillsPanel`, chat `/` slash-menu, active-skill badge.
- **Lever 1 — `docs_generate` agent tool**: produce DOCX/PPTX/XLSX/PDF mid-workflow via the provenance engine; `use_rag` grounds reports in indexed files (cited by filename).
- **Lever 2 — BYOK cloud fallback**: cloud models as `llm_models` rows (OpenAI / Anthropic / custom OpenAI-compatible); opt-in, local Ollama stays default; keys stored locally. UI in Models panel.
- **Lever 3 — first-run onboarding**: detect Ollama, recommend+pull a model by RAM with live progress, or pick installed model (`Onboarding.tsx`).
- **Lever 4 — test harness**: Vitest + pure extracted helpers (`skills/util.ts`, `tools/docPath.ts`).
- **Launch infra**: `electron-builder` GitHub publish config + `.github/workflows/release.yml`; `electron-updater` (notification-only) in `main.ts`; Next.js landing page in `landing/`; `REQUIREMENTS.md`.

---

## The RAG feature is now complete end-to-end
A user can: pull `nomic-embed-text` → **index a folder** (RAG panel) → **`/ask`** questions about their files → or generate a **`/report`** grounded in them, with filename citations throughout. Indexing handles real PDF/DOCX/XLSX text and rebuilds incrementally.

---

## Key files added this session
- `packages/app/src/skills/registry.ts`, `skills/util.ts` (+ `.test.ts`)
- `packages/app/src/tools/docs.ts`, `tools/docPath.ts`, `tools/rag.ts`, `tools/ragFormat.ts` (+ tests)
- `packages/app/src/rag/extract.ts`, `rag/indexFormat.ts` (+ tests); `rag/indexer.ts` extended
- `packages/app/src/llm/streamMerge.ts` (+ test); `llm/client.ts` `streamComplete`
- `packages/renderer/src/components/Settings/SkillsPanel.tsx`, `RAGPanel.tsx`; `Onboarding/Onboarding.tsx`
- `REQUIREMENTS.md`, `landing/`, `.github/workflows/release.yml`, `vitest.config.ts`
- `packages/app/src/types/rag-extractors.d.ts`

Full annotated map: workspace `SITEMAP.md` (lives in the parent `Projects/` dir, **outside this repo**, so its updates are on disk but not git-tracked here).

---

## ⚠️ Resume checklist — DO THESE FIRST

1. **Smoke test on real hardware** (`npm run dev`, Ollama running):
   - Onboarding overlay appears on first launch; pulling a model shows live progress.
   - **Streaming**: plain Q&A streams token-by-token. **Watch for flicker** on tool-heavy runs — the `agent:streamReset` path clears preamble when a turn becomes a tool call; on a real local model that emits text-before-tool-call, this could flash. This is the #1 thing to validate.
   - Skills: `/` slash-menu lists skills; `/report ...` and `/ask ...` work; active-skill badge shows.
   - RAG: pull `nomic-embed-text`, index a folder of real PDFs/Word docs, then `/ask` about them — confirm citations point to real filenames.
2. The DB schema gained tables/seeds (`skills`, cloud `llm_models`, etc.) — first launch after this code runs the idempotent migrations/seeds automatically.

## Open decisions / loose ends (not blocking)
- **GitHub org**: deferred decision (see `REQUIREMENTS.md` §8). Must be made **before tagging the first public release `v0.1.0`**, else shipped installers' auto-update URL points at a personal account. Not urgent until release.
- **Release not yet cut**: launch infra exists but no `v*.*.*` tag has been pushed. Repo is public-ready (secret scan passed earlier).
- **`docs/requirement.md`**: shows as modified in the working tree but is a pre-existing change NOT authored this session — intentionally left uncommitted.
- **Local cleanup**: streaming added `agent:streamReset`; if flicker is bad on real models, consider buffering the first N content deltas before emitting (noted as a possible refinement).

## Candidate next tasks (pick on resume)
1. Verify/refine streaming on real hardware (see checklist #1).
2. Cut the first preview release (decide GitHub org first; tag `v0.1.0`; CI builds installers).
3. Deploy the `landing/` page to Vercel (Root Directory = `landing`).
4. RAG polish: chunk on token boundaries / better PDF layout handling; surface index status in chat.
5. Crash recovery for the BrowserView (`render-process-gone`) — flagged in `docs/requirement.md` as unhandled.

---

## How to run / verify
```bash
npm install            # root (workspaces)
npm run typecheck      # tsc -b for app + renderer  → must be clean
npm test               # vitest → 37 passing
npm run dev            # launch Electron app (needs Ollama: `ollama serve`)
# landing page:
cd landing && npm install && npm run dev
```
