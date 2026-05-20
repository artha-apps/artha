# Artha — Architecture Guide

## Stack Overview

Artha is a TypeScript-first Electron application. The deliberate choice to use a single runtime (Node.js/TypeScript) across both the main process and the build pipeline eliminates the cross-language IPC complexity of alternative designs (Rust + Python + ZeroMQ).

## Module Responsibility Map

| Module | Location | Responsibility |
|---|---|---|
| Electron shell | `packages/app/src/main.ts` | Window management, app lifecycle |
| IPC bridge | `packages/app/src/preload.ts` | Typed, sandboxed renderer↔main bridge |
| IPC handlers | `packages/app/src/ipc/handlers.ts` | Routes IPC calls to backend modules |
| Agent Orchestrator | `packages/app/src/agent/orchestrator.ts` | ReAct loop, planning mode, self-correction |
| LLM Client | `packages/app/src/llm/client.ts` | Single OpenAI-compat REST adapter |
| MCP Registry | `packages/app/src/mcp/registry.ts` | MCP server connections, tool schemas, invocation |
| Skill Registry | `packages/app/src/skills/registry.ts` | Named playbooks: CRUD, intent-match, tool scoping |
| Web Tools | `packages/app/src/tools/web.ts` | `web_fetch` / `web_search`, robots.txt, cache, citations |
| Readability | `packages/app/src/tools/readability.ts` | HTML → clean markdown (Mozilla Readability + jsdom) |
| SearXNG client | `packages/app/src/tools/searxng.ts` | Privacy-respecting metasearch with instance fallback |
| Browser Tools | `packages/app/src/tools/browser.ts` | `browser_*` verbs + handoff (`browser_request_user`) |
| Browser Controller | `packages/app/src/browser/controller.ts` | BrowserView lifecycle, driving-mode latch, handoff promise |
| Browser Actions | `packages/app/src/browser/actions.ts` | Selector-based click/type/read/wait + screenshot |
| RAG Indexer | `packages/app/src/rag/indexer.ts` | File indexing, vector similarity search |
| Document Generator | `packages/app/src/docs/generator.ts` | DOCX / PPTX / XLSX / PDF generation |
| Database | `packages/app/src/db/schema.ts` | SQLite schema, migrations |
| React UI | `packages/renderer/src/` | Chat, Sidebar, Execution Log, Plan Approval, Browser pane |
| Browser Store | `packages/renderer/src/stores/browser.ts` | Zustand — mirrors BrowserController state into the pane |
| Chat Store | `packages/renderer/src/stores/chat.ts` | Zustand — messages, streaming, execution log, citations |

## LLM Interface Design

The LLM Client uses a single OpenAI-compatible REST client (`openai` npm package). All supported backends expose this API:

| Backend | Default URL | Notes |
|---|---|---|
| Ollama | `http://localhost:11434/v1` | Primary target |
| LM Studio | `http://localhost:1234/v1` | Drop-in compatible |
| llama.cpp server | `http://localhost:8080/v1` | Drop-in compatible |
| OpenAI | `https://api.openai.com/v1` | Cloud fallback (opt-in) |

No per-backend code is required. Switching providers is a config change, not a code change.

## Agent Orchestration (ReAct Loop)

```
User message
    │
    ▼
[Generate Plan]  ──── LLM call with system prompt + tool list
    │
    ▼
requiresApproval? ──yes──▶ Emit planReady → UI shows PlanApproval modal
    │                                              │
    │no                                     user approves/cancels
    ▼                                              │
[Execute Loop] ◀────────────────────────────────────
    │
    ├─▶ LLM decides: respond in text OR call a tool
    │       │
    │   tool call ──▶ MCPRegistry.invokeTool() ──▶ result ──▶ back to LLM
    │       │
    │   text ──▶ stream tokens to renderer ──▶ finalise message
    │
    ├─▶ failure? ──▶ self-correct (retry up to 3x, replan if needed)
    │
    └─▶ all steps done ──▶ mark workflow completed
```

## MCP Tool System

MCP (Model Context Protocol) is the first-class tool protocol. The `MCPRegistry` class:
1. Loads all enabled MCP servers from SQLite on startup
2. Connects via `StdioClientTransport` (spawns the server process)
3. Fetches tool schemas and converts them to OpenAI function definitions
4. Routes tool invocations to the correct server by tool name

Adding a new tool = installing a new MCP server. No custom code.

### Built-in tool tiers

The registry exposes three tiers of built-in tools *before* any MCP server, and dispatches by name prefix in `invokeTool()`. Built-ins are matched first so a buggy or malicious MCP server cannot shadow them by re-using a name:

| Prefix | Module | Tools |
|---|---|---|
| `fs_` | `tools/filesystem.ts` | list / search / move / copy / read / info / delete / mkdir |
| `web_` | `tools/web.ts` | `web_fetch`, `web_search` |
| `browser_` | `tools/browser.ts` | navigate / click / type / wait_for / read_dom / screenshot / get_url / back / forward / reload / request_user |

`getToolSchemas()` returns them in the order `[filesystem, web, browser, …mcp]`.

## Skills (named agent playbooks)

A **Skill** is a reusable playbook — a description + instructions + an optional
tool allowlist — modelled on Claude Skills. The `SkillRegistry` (singleton)
owns CRUD over the `skills` table and resolves which skill, if any, applies to
each user message:

```
user message
   │
   ▼
SkillRegistry.resolve(message)
   ├─ starts with "/slug"? ──▶ explicit: load that skill, strip the prefix
   └─ else ──▶ autoMatch(): cheap LLM picks one enabled skill by description, or none
   │
   ▼
ActiveSkill { slug, name, icon, instructions, allowedTools }
   │
   ├─▶ instructions injected into BOTH the planning prompt and the ReAct system prompt
   ├─▶ allowedTools filters getToolSchemas() (entry ending "_" = name prefix; empty = all)
   └─▶ emit agent:skillActive ──▶ renderer shows a "Skill: …" badge in the composer
```

Design choices:
- **Two invocation paths.** Explicit `/slug` is deterministic; auto-match keeps
  the agent helpful without the user memorising slugs. Auto-match failures
  (timeout, malformed JSON) degrade safely to "no skill".
- **Tool scoping.** A skill can constrain the agent to a subset of tools so a
  "File Organizer" can't wander onto the web. Prefix entries (`fs_`) keep the
  allowlist short.
- **Built-ins are protected.** Three skills ship seeded (`research`,
  `organize`, `summarize`) with `is_builtin=1`; users can edit or disable them
  but not delete them, and their slug is locked so `/slug` stays stable.
- **Skill survives plan approval.** The `ActiveSkill` is stored on `AgentPlan`,
  so a skill chosen pre-approval still drives execution after the user approves.
- Managed in **Settings → Skills** (`SkillsPanel.tsx`); invoked from the chat
  composer's `/` slash-menu.

## Web Tools (built-in, no API keys)

The agent has first-class web access without any user-installed MCP server.

```
web_search(query)                      web_fetch(url)
    │  SearXNG JSON API                    │  fetch() with honest UA
    │  (instance fallback list)            │  robots.txt gate (per-host override)
    ▼                                      ▼
[{title,url,snippet}]              content-type allowlist + size cap
    │                                      │
    └──────────────┬───────────────────────┘
                   ▼
       record citation {url,title,fetched_at}
                   │
        web_fetch only: Mozilla Readability → markdown
                   │   cache in `web_cache` (TTL, default 1h)
                   ▼
        JSON result returned to the ReAct loop
```

Design choices:
- **SearXNG default** keeps search local-first and key-free; users can point at a self-hosted instance for zero cloud. Instances are tried in order until one responds.
- **Readability** (the Firefox Reader-View engine) strips nav/ads/boilerplate so the model consumes compact markdown, not raw HTML.
- **Caching** in SQLite (`web_cache`) makes repeated reads free within the TTL and doubles as an at-rest log of what the agent read.
- **Politeness/safety**: robots.txt respected by default (per-host override allowlist), content-type allowlist, size cap, request timeout, and an identifiable User-Agent (`Artha/0.1 (+local-agent; respects robots.txt)`).
- All settings live under the `web` key of `users.settings_json` and are edited in **Settings → Web** (`WebPanel.tsx`).

## Browser Co-Pilot (the differentiator)

For pages that need *interaction* (logins, SPAs, dynamic content, form submission) the agent drives Electron's own Chromium via a `BrowserView` attached to the main window — not a headless/Playwright instance. The user sees the **real** page and shares one `webContents` with the agent, which makes "hand me the wheel" a literal click rather than a screenshot stream or session transfer.

```
[ React BrowserPane ]  ── measures its rect (ResizeObserver) ──▶ browser:setBounds
        │                                                              │
        │  overlays exactly                                            ▼
        └───────────────────────────────────▶ [ BrowserView (main process) ]
                                                      ▲        │
                              browser_* tool calls ───┘        │ did-navigate / loading / title
                                                               ▼
                                                    browser:state ──▶ toolbar / URL bar
```

**Driving-mode latch.** `BrowserController` holds `drivingMode: 'agent' | 'user'`. Every `browser_*` tool (except the handoff request) calls `assertAgentMayAct()` first, which throws while the user holds the wheel — so the agent can't fight the user for control.

**Action layer.** `browser/actions.ts` implements selector primitives via `webContents.executeJavaScript` (an injected `__arthaResolve` supports CSS *or* `text=Label` matching) plus `capturePage()` for screenshots. This replicates the useful 90% of Playwright in ~200 lines with zero extra install — Playwright remains a future option for *headless background* workflows.

**Handoff protocol (`browser_request_user`).** The standout capability:

```
agent hits a login wall
   │
   ▼
browser_request_user({reason})         ── tool returns a Promise that does NOT resolve yet
   │   controller.drivingMode = 'user'
   │   emits browser:handoffRequested  ── HandoffBanner appears over the pane
   ▼
USER acts directly on the live page (types password, clicks submit, solves captcha)
   │
   ▼
USER clicks "Resume"                   ── browser:resumeAgent → controller resolves the Promise('resumed')
   │
   ▼
the awaited invokeTool() returns       ── ReAct loop continues, now with the user's cookies/session
```

Because agent and user share one `webContents`, whatever session the user establishes (cookies, auth) is immediately available to the agent's next action. The Stop button also calls `cancelHandoff()` so a pending handoff can never deadlock the orchestrator's tool-await.

**Web pages as citations.** Browser navigations/reads feed the same per-workflow citation collector as `web_fetch`/`web_search` (via `recordCitation` exported from `tools/web.ts`), so pages the agent visits show up as source chips in chat.

## Document Generation Pipeline

```
Natural language prompt
    │
    ▼
LLMClient.complete()  ──▶  structured JSON (title, sections, tables, bullets)
    │
    ▼
Format renderer:
  docx  ──▶  docx npm (Packer.toBuffer → .docx file)
  pptx  ──▶  pptxgenjs (.pptx file)
  xlsx  ──▶  xlsx npm (XLSX.writeFile → .xlsx file)
  pdf   ──▶  pdf-lib (PDFDocument.save → .pdf file)
    │
    ▼
File written to user's chosen output path
    │
    ▼
shell.openPath() — opens file in native app
```

Document generation is exposed **two ways**: the Settings UI button (`docs:generate`
IPC) *and* as a first-class agent tool (`docs_generate`, in `tools/docs.ts`,
registered in the MCP tool tiers). The agent path is what makes "research X and
write me a report.docx" work end-to-end — pair it with the built-in `report`
skill. Output paths are resolved by the pure, unit-tested `tools/docPath.ts`
(defaults to ~/Documents, forces the extension, blocks system dirs).

`docs_generate` can also **ground reports in the user's own files**: with
`use_rag: true` it calls `searchAllIndexes()` (rag/indexer.ts) across every
configured RAG index and passes the top passages as `SourceChunk`s carrying the
originating filename, so each cited section's provenance points at a real local
document. IPC and the docs tool share one `getDefaultRagIndexer()` instance.

## Cloud Models (BYOK, opt-in)

Local Ollama is the default and the privacy promise. Because `LLMClient` is
OpenAI-compatible and `getActiveLLMClient()` reads `base_url`/`api_key` from the
active `llm_models` row, a cloud provider (OpenAI, Anthropic's OpenAI-compat
endpoint, or any custom OpenAI-compatible URL) is just another row. Keys are
stored in local SQLite and sent only to the provider the user selects. Managed
in **Settings → Models → Cloud Models (BYOK)**; nothing cloud runs unless the
user explicitly activates it.

## First-run Onboarding

`Onboarding.tsx` (gated on `settings.onboardingComplete`) removes the biggest
drop-off: detects the Ollama runtime (`llm:checkOllama`), recommends a starter
model sized to RAM (`llm:detectHardware` → `recommendedModel`), and pulls it
with live progress streamed over `llm:pullProgress` (NDJSON from Ollama's
`/api/pull`) — or lets the user pick an already-installed model.

## Testing

Vitest (`npm test`) covers the pure, security-relevant logic that doesn't need
Electron/DB/Ollama: skill slug parsing + tool-allowlist scoping (`skills/util.ts`)
and document output-path resolution incl. system-dir blocking (`tools/docPath.ts`).
Side-effecting modules delegate to these pure helpers so the hot paths stay
testable.

## Database

SQLite via `better-sqlite3`. WAL mode enabled. All writes are synchronous (intentional — avoids async complexity in main process).

See `packages/app/src/db/schema.ts` for the full table definitions matching PRD v2.0.

## v2 Rust Core (Future)

Once v1 is shipped and product-market fit established, the `agent/orchestrator.ts` and `mcp/registry.ts` hot paths can be rewritten in Rust using:
- **Rig** — modular LLM abstractions
- **AutoAgents** — multi-agent orchestration (actor model via Ractor)

The TypeScript layer becomes a thin IPC/UI shell. This is a performance optimisation, not a v1 requirement.
