# Changelog

All notable changes to Artha are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-05-26

First feature release since the v0.1.0 launch. Headline: chats can now be
scoped to specific folders/files, with the agent confined to them.

### Added
- **Per-chat folder & file scopes** — attach any number of folders and
  individual files to a single chat from the composer. The agent is made aware
  of them (folder structure + small files are injected into context) and
  resolves relative paths inside them.
- **Hard filesystem sandbox** — when a chat has scopes, the built-in file tools
  reject any read/write outside the attached folders/files (folder = subtree,
  file = exact path). Unscoped chats keep home-directory-wide access.
- **Folder-scoped retrieval** — `rag_search`, `rag_list_indexes`, and document
  grounding are confined to the chat's folder indexes when scoped, and search
  every index otherwise. Folders are auto-indexed in the background.
- **Team mode** — team members, LAN server API-key auth, and org-shared memories.
- **Cloud integrations** — connect Google Workspace (Gmail, Calendar, Drive)
  via OAuth.
- **LAN collaboration server** — NDJSON server with copyable URL, inline QR, and
  autostart.
- **Parallel sub-agents** — fan out independent sub-tasks concurrently.
- **Desktop control** (opt-in) — mouse/keyboard/screenshot tools for driving
  native apps.
- **70B models** in the catalog (`qwen2.5:72b`, `llama3.3:70b`).
- **IDE integration** — generate `.vscode/mcp.json` / `.cursor/mcp.json`; MCP
  marketplace with persisted state.

### Changed
- Folders are now attached **per chat** instead of via a global project
  switcher; the sidebar is a flat session list.
- The agent is steered to answer "what is this folder/app?" by reading key files
  directly (README, manifests) using the injected folder tree, with semantic
  `rag_search` as an aid — so answers work even before an index finishes building.

### Fixed
- **Broken install / CI** — `@nut-tree/nut-js` was removed from the public npm
  registry (404), breaking `npm install` / `npm ci`. Swapped to the maintained,
  API-compatible fork `@nut-tree-fork/nut-js` as an **optional** dependency, with
  a guarded non-fatal native rebuild.
- **Dependency security** — landing upgraded to Next.js 16 + React 19;
  `electron-builder` 24 → 26; `vitest` 2 → 3; `xlsx` pinned to the patched
  SheetJS CDN build (0.20.3).
- **Database engine** — pinned Electron 41 + `better-sqlite3` 12 so the native
  driver compiles against Electron's ABI and the DB opens at runtime.

## [0.1.1] - 2026-05-21

### Added
- Branded app icons for macOS / Windows / Linux.

### Changed
- RAG chunking is now sentence/word-boundary aware (was fixed 512-char slices).

### Fixed
- Crash-recovery hardening for the browser pane (extracted + unit-tested
  crashloop guard and target selection).

## [0.1.0] - 2026-05-21

First public release — a local-first desktop AI agent (macOS, Windows, Linux).

### Added
- ReAct agent loop with planning mode + plan approval, clarification flow, and a
  per-run audit trail.
- Skills system, local RAG over user files, MCP tool support, and document
  generation (DOCX / PPTX / XLSX / PDF) with provenance receipts.
- Web search + embedded browser pane, task scheduler, multimodal input + PDF
  vision, voice input, agent memory, and IDE integration.
- Cross-platform installers (`.dmg` / `.exe` / `.deb`) with auto-update via
  GitHub Releases, plus a marketing landing page.

[0.2.0]: https://github.com/Noopurtrivedi/artha/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/Noopurtrivedi/artha/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/Noopurtrivedi/artha/releases/tag/v0.1.0
