# Getting Started (Developers)

How to run, build, and work on Artha locally. For the product pitch see the
root [`README.md`](../README.md); for how the pieces fit together see
[`architecture.md`](./architecture.md) and [`feature-deep-dive.md`](./feature-deep-dive.md).

> Artha is a **local-first Electron desktop app** (monorepo with npm workspaces).
> There is no backend to run — all compute (LLM, RAG, docs, SQLite) is on-device.

## Prerequisites

- **Node.js 22+**
- **[Ollama](https://ollama.ai)** running (`ollama serve`) with at least:
  - a chat/tool model — default agent model is `qwen2.5:7b` (best tool-calling of the tested local models)
  - **`nomic-embed-text`** for RAG embeddings → `ollama pull nomic-embed-text`
    - Without it, semantic `rag_search` returns nothing; scoped chats fall back to reading files directly.
- **macOS / Windows / Linux.** Native modules are compiled against Electron's ABI on install.
- *(optional)* Docker Desktop — for sandboxed tool execution.
- *(optional)* Poppler (`brew install poppler`) — enables PDF page rendering for vision attachments.

## Install & run

```bash
git clone https://github.com/Noopurtrivedi/artha.git
cd artha
npm install            # installs all workspaces + rebuilds native modules (see below)
npm run dev            # renderer (Vite) + main (tsc watch) + Electron, concurrently
```

First launch runs an **onboarding** flow that detects Ollama and helps pull a model.

## Common commands (run from repo root)

| Command | What |
|---|---|
| `npm run dev` | Start the full app in dev (kills stale Electron/port first) |
| `npm run build` | Type-build renderer + main to `dist/` |
| `npm run typecheck` | `tsc -b` across app + renderer |
| `npm run lint` | ESLint over `packages/*/src` |
| `npm test` | Vitest (unit tests; pure helpers, no Electron) |
| `npm run dist` | Build production installers via electron-builder |

## Native modules (important)

`npm install` runs `scripts/rebuild-native.js` (root `postinstall`), which rebuilds:

- **`better-sqlite3`** against Electron's ABI — required, or the DB won't open at runtime.
- **`@nut-tree-fork/nut-js`** (optional, desktop control) — only if installed; non-fatal.

If a rebuild fails, the install still completes; rerun manually:

```bash
npx electron-rebuild -f -w better-sqlite3
npx electron-rebuild -f -w @nut-tree-fork/nut-js   # only if you use desktop control
```

> **Electron is pinned to 41.x** — it's the newest Electron whose V8 `better-sqlite3` compiles against. Do **not** `npm install electron@latest`.

## Where runtime data lives (macOS)

| Data | Path |
|---|---|
| SQLite database | `~/Library/Application Support/Artha/artha.db` |
| RAG vector indexes | `~/Library/Application Support/Artha/rag-indexes/` |
| Skill YAML files | `~/Library/Application Support/Artha/skills/` |
| Generated artifacts | `~/Library/Application Support/Artha/artifacts/` |
| Logs | `~/Library/Logs/Artha/` |

## Releasing

Version bumps + notes live in [`../CHANGELOG.md`](../CHANGELOG.md). A release is
cut by pushing a tag, which triggers `.github/workflows/release.yml` to build and
publish installers:

```bash
git tag vX.Y.Z && git push --tags
```

## Project layout

See the file-level map in [`../SITEMAP.md`](../SITEMAP.md). High level:

```
packages/app/       Electron main process (agent, llm, mcp, tools, rag, db, ipc, scheduler)
packages/renderer/  React 19 UI (Vite + Tailwind; Zustand store; chat/sidebar/panels)
packages/landing/   Next.js marketing site (static export)
docs/               Planning + architecture docs (start at site-map.md)
scripts/            Dev helpers (native rebuild, icon gen)
```
