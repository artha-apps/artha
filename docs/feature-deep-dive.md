# Feature Deep Dive

How Artha's major features work and where the code lives. This is the narrative
companion to the file-level [`../SITEMAP.md`](../SITEMAP.md) and the
[`architecture.md`](./architecture.md) guide (which has the deeper diagrams).
For status/scope see [`idea-inbox-mvp-roadmap.md`](./idea-inbox-mvp-roadmap.md).

---

## Agent orchestration — the ReAct loop
**What:** describe a task in plain English; the agent plans, calls tools,
observes results, and self-corrects until done. **How:** `AgentOrchestrator`
(`packages/app/src/agent/orchestrator.ts`) runs the loop (≤60 iterations, stall
detection), injects memory + active skill + per-chat scope context into the
system prompt, dispatches tool calls, and produces a verified final answer from
tracked mutations rather than raw model prose. Planning mode + plan approval and
a clarification step gate risky work. See `architecture.md` → *Agent Orchestration*.

## Skills (named playbooks)
**What:** reusable instructions (`/slug`) that steer the agent and can restrict
which tools it may use. **How:** `SkillRegistry` (`agent/skills.ts`) loads YAML
skills; resolved per message via explicit `/slug` or an LLM auto-matcher; injected
into both the planning and execution prompts. Managed in the Skills panel.

## Per-chat folder/file scopes + hard sandbox  *(new in 0.2.0)*
**What:** attach folders and individual files to a single chat; the agent is made
aware of them and **confined** to them. **How:**
- `session_scopes` table + helpers in `db/scopes.ts` (allowed roots, primary folder, rag index ids).
- **Sandbox:** `tools/filesystem.ts` `safePath()` rejects reads/writes outside the chat's scopes (folder = subtree, file = exact path); unscoped chats keep home-dir access.
- **Context:** the orchestrator injects a shallow **folder tree** (`agent/folderTree.ts`) + small files + folder memory, so the agent answers "what is this?" by reading key files directly — even before the index builds.
- Folder workspaces reuse the `projects` table (deduped by path) to share one RAG index + cross-session memory. UI: scope chips in the composer (`ChatWindow.tsx`).

## Local RAG (retrieval over your files)
**What:** semantic search + citation over indexed local docs. **How:**
`rag/indexer.ts` chunks (boundary-aware) and embeds files via Ollama
`nomic-embed-text`, storing JSON vector indexes; incremental re-index via MD5.
The `rag_search` / `rag_list_indexes` tools (`tools/rag.ts`) query it — **confined
to the chat's folder indexes when scoped**, all indexes otherwise. Requires
`nomic-embed-text`; without it the index is empty and the agent reads files directly.

## MCP tool system
**What:** any [Model Context Protocol](https://modelcontextprotocol.io) server
becomes agent capabilities with no custom code. **How:** `mcp/registry.ts` spawns
servers over stdio, imports their tool schemas, and dispatches calls — built-in
tools (`fs_`/`web_`/`browser_`/`docs_`/`rag_`) take priority so MCP servers can't
shadow them. Curated marketplace in `mcp/registry-catalog.ts`.

## Document generation
**What:** "write me a report.docx" → a polished, sourced file. **How:**
`tools/docs.ts` + the provenance engine produce DOCX/PPTX/XLSX/PDF from an
LLM-planned outline; `use_rag` grounds content in indexed files (cited by
filename); output defaults into the chat's scoped folder. Files open in their
native app and are logged to the artifacts table. See `architecture.md` →
*Document Generation Pipeline*.

## Web tools + browser co-pilot
**What:** search + fetch without API keys, plus a watchable embedded browser.
**How:** `tools/web.ts` (Brave → SearXNG → DuckDuckGo fallback chain) + Readability
extraction with citations; the browser pane exposes `browser_*` tools (navigate,
click, type, screenshot, hand-off-to-human for login/2FA).

## Memory
**What:** the agent remembers useful facts across sessions. **How:** `tools/memory.ts`
(`memory_store`/`recall`/`forget`) over a SQLite entity graph; `getMemoryContext()`
injects recent memories, scoped to the chat's primary folder when present.

## Scheduler, Team/LAN, Cloud, Desktop control
- **Scheduler** (`scheduler/scheduler.ts`): cron / one-shot agent runs with notifications.
- **Team + LAN server**: members, API-key auth, org-shared memories; NDJSON server with QR.
- **Cloud integrations** (opt-in): Google Workspace (Gmail/Calendar/Drive) via OAuth.
- **Desktop control** (opt-in, dangerous): mouse/keyboard/screenshot via the optional
  `@nut-tree-fork/nut-js` native dep (lazy-loaded; app boots fine without it).

## Models
Ollama-first (auto-detect/pull/switch), with **opt-in BYOK cloud** models as
`llm_models` rows. A `ModelRouter` can pick a model per task complexity. Single
OpenAI-compatible client (`llm/client.ts`) with streaming.
