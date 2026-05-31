# Extended reasoning, deeper context awareness, and Sentry resilience

This document describes three capabilities added to the Artha desktop app
(`packages/app` main process + `packages/renderer`):

1. **Extended chain-of-thought reasoning** — an explicit `<think>` planning
   phase before the agent acts, persisted and surfaced in the UI.
2. **Deeper context awareness** — a local "context gather" step that assembles
   the most relevant memories, recent conversation, and active scopes into a
   structured `<context>` block before reasoning.
3. **Sentry operational resilience** — incident response, disaster recovery, and
   business-continuity coverage, fully PII-scrubbed and opt-out.

Everything except Sentry stays 100% local. Sentry is opt-out and transmits only
non-PII error/operational signals (see the privacy section).

---

## 1. Extended chain-of-thought reasoning

### What happens
At the start of every (non-parallel) agent run, before the first tool call, the
orchestrator runs a dedicated **`<think>` phase**:

- `AgentOrchestrator.runThinkPhase()` (`packages/app/src/agent/orchestrator.ts`)
  makes a separate LLM call (task type `plan`) that reuses the run's system
  prompt — so it sees the injected `<context>` block, long-term memory, and live
  environment — but is asked **only** for a plain-English plan: what the user
  wants, what's needed, which tools to call in what order, and how to verify.
- No tools are offered on this call, so it can only return text.
- The resulting trace is:
  - **fed back** to the model as a private `system` message ("Your private plan …
    do NOT repeat it to the user") so it guides tool use without leaking into the
    final answer;
  - **recorded** as an `agent_steps` row (kind `assistant`, phase `think`);
  - **accumulated** into a `reasoningSteps: ReasoningStep[]` array.

### Persistence
`messages` gained a new **`reasoning_steps`** column (migration v8→v9 in
`packages/app/src/db/schema.ts`). When the final assistant message is persisted,
the reasoning array is written there as JSON. `sessions:getMessages`
(`ipc/handlers.ts`) parses it back into a `reasoning` field on each message.

Each `ReasoningStep` is:
```ts
{ phase: 'context' | 'think'; content: string; context_score: number }
```

### UI
`packages/renderer/src/components/Chat/ChatWindow.tsx` adds a
`ReasoningDisclosure` component — a collapsible "Thinking…/Reasoning" block
styled to match the existing inline thinking + plan-approval cards. It renders:
- **live** (open, with a spinner) while the agent works, driven by the
  `agent:reasoning` IPC event → `useChatStore.setLiveReasoning`;
- **persisted** (collapsed) on finished assistant messages that carry
  `msg.reasoning`.

Each step shows its phase and, when present, the context influence as
`context NN%`.

### Settings toggle
`show_reasoning` (boolean, default **true**) lives on the user settings blob.
When **off**, the `<think>` phase still runs and is still persisted — only the
disclosure is hidden. The orchestrator reads it via
`AgentOrchestrator.showReasoningEnabled()` and sends the flag with the
`agent:reasoning` event (`showReasoning`); the renderer hides the disclosure
when false. Toggle it from Settings → see §4 wiring.

---

## 2. Deeper context awareness

A new module, `packages/app/src/agent/contextGather.ts`, runs **before** the
`<think>` phase:

- **Top-5 memories by semantic similarity** to the current goal. Candidate
  memories (global + the session's project bucket) are embedded with the same
  local Ollama `nomic-embed-text` endpoint the RAG pipeline uses, then ranked by
  cosine similarity. If embeddings are unavailable (Ollama down / model not
  pulled) it falls back to keyword overlap + recency, so it never throws.
- **Last 3 turns** of conversation, trimmed to a short recap.
- **Active folder/file scopes** for the chat.

These are rendered into a structured `<context>…</context>` block and injected
at the **top** of the system prompt, above the existing memory preamble
(`messages[0].content = block + "\n\n" + messages[0].content`).

`gatherContext()` returns a **`contextScore`** (mean similarity of the surfaced
memories, 0–1). It is recorded on the `context` and `think` reasoning steps as
`context_score`, so you can see how strongly assembled context influenced each
decision (shown in the UI as `context NN%`).

**Locality:** the only network call is to `localhost:11434` (Ollama embeddings),
identical to existing RAG behaviour. No new external/cloud calls.

---

## 3. Sentry operational resilience

Added dependency: **`@sentry/electron`** (`packages/app/package.json`). Run
`npm install` in `packages/app` (or repo root) before building. All Sentry code
lives in `packages/app/src/sentry.ts`.

The DSN is read from `process.env.ARTHA_SENTRY_DSN`. When unset, Sentry
initialises in a no-op mode and **nothing is transmitted** — safe for forks/CI.

### 3a. Incident response
`initSentry({ ollamaConnected, mcpServerCount })` is called from `main.ts`
**after** the DB opens (so the opt-out setting is readable) but before the
window loads. It sets:
- `release` = `process.env.npm_package_version` (falls back to `app.getVersion()`),
- `environment` = `production` | `development`,
- tag `artha.ollama_connected` (boolean, probed on session start),
- tag `artha.mcp_server_count` (number, counted from the `tools` table).

`setOllamaConnectedTag()` / `setMcpServerCountTag()` update these later.
Renderer crashes (`render-process-gone`) are captured with reason + exit code
only.

**`beforeSend` is the privacy backstop:** it strips absolute file paths to
basenames in messages + stack frames, deletes `abs_path` and local `vars` from
frames, removes `user`/`request`/`server_name`/device context, and drops any
breadcrumb that isn't in the `artha.*` namespace. `beforeBreadcrumb` likewise
drops non-`artha.*` (e.g. console) breadcrumbs that could capture prompts.

### 3b. Disaster recovery
- **Migrations as a transaction:** `initDatabase()` was split so the additive
  `ALTER TABLE` migrations are now an exported `runMigrations()`. `main.ts`
  calls it inside `withTransaction('db.migrations', 'db.migrate', …)` so a slow
  or failing migration is tracked as a performance transaction (and the error
  captured), not silently thrown.
- **DB health checkpoint:** new table **`db_health`** (single row, column
  `checkpointed_at`). `packages/app/src/db/health.ts` writes a heartbeat +
  `artha.db_health` breadcrumb every **30 minutes** (and once immediately on
  start). On a crash report, the most recent `checkpointed_at` shows exactly how
  long since the last healthy checkpoint. Started in `main.ts`, stopped on quit.

### 3c. Business continuity
`SchedulerService` (`packages/app/src/scheduler/scheduler.ts`) registers a
daily job at **03:00 local** (`0 3 * * *`) → `runHealthCheck()`, which:
1. probes Ollama reachability (`localhost:11434`, short timeout),
2. runs SQLite `PRAGMA integrity_check`,
3. measures free disk space on the userData volume (`fs.statfs`),

then sends a Sentry **monitor check-in** (cron monitoring) via
`startCheckIn`/`finishCheckIn` (slug `artha-daily-health`, schedule `0 3 * * *`).
A non-PII `artha.health_check` breadcrumb records the three results. The check-in
is `error` when integrity fails or free disk < 1 GB, else `ok` — giving a
per-install heartbeat that flags a silently-broken release.

### 3d. Opt-out + first-launch disclosure
- Enabled by default; toggle in Settings (`sentry_enabled`, default true).
  `settings:setSentry` persists it **and** flips a runtime kill-switch
  (`setSentryRuntimeEnabled`) so disabling stops transmission immediately.
- One-time disclosure on first launch:
  *"Artha sends anonymous crash reports to help fix bugs. No files or
  conversations are included. You can disable this in Settings."*
  Acknowledgement is stored as `sentry_disclosure_ack` via
  `settings:ackSentryDisclosure`; `settings:getSentry` returns
  `{ enabled, disclosureAck }`.

### Privacy guarantee
Sentry receives ONLY: exception types/messages/stack traces (paths scrubbed to
basenames), the release/environment, the `artha.ollama_connected` and
`artha.mcp_server_count` tags, our `artha.*` breadcrumbs (timestamps + the
health booleans/numbers above), and the daily check-in. It never receives user
messages, file contents, memory values, folder paths, prompts, or tool
args/results.

---

## 4. IPC surface added

Main → renderer event:
- `agent:reasoning` → `{ steps: ReasoningStep[]; showReasoning: boolean }`
  (preload: `window.artha.agent.onReasoning`).

Renderer → main handlers (preload `window.artha.settings.*`):
- `settings:getSentry` → `{ enabled, disclosureAck }`
- `settings:setSentry(enabled)` → `{ enabled }`
- `settings:ackSentryDisclosure()` → `true`
- `show_reasoning` uses the generic `settings.get` / `settings.set`.

`sessions:getMessages` now returns a `reasoning` field per message.

---

## 5. Remaining renderer wiring (Settings panel + history loader)

The data layer, IPC, store, and chat surface are complete. Two small renderer
hookups depend on files that should be confirmed against the current tree:

**(a) Settings toggles + first-launch disclosure** — in
`packages/renderer/src/components/Settings/SettingsPanel.tsx`, add two switches:

```tsx
// Reasoning visibility (generic settings blob)
const [showReasoning, setShowReasoning] = useState(true);
const [sentry, setSentry] = useState({ enabled: true, disclosureAck: true });
useEffect(() => {
  window.artha.settings.get().then((s: { show_reasoning?: boolean }) =>
    setShowReasoning(s.show_reasoning !== false));
  window.artha.settings.getSentry().then(setSentry);
}, []);

// "Show agent reasoning" toggle:
<Toggle checked={showReasoning} onChange={(v) => {
  setShowReasoning(v);
  window.artha.settings.set({ show_reasoning: v });
}} label="Show agent reasoning" />

// "Send anonymous crash reports" toggle:
<Toggle checked={sentry.enabled} onChange={(v) => {
  setSentry((p) => ({ ...p, enabled: v }));
  window.artha.settings.setSentry(v);
}} label="Send anonymous crash reports (no files or conversations)" />
```

First-launch disclosure (e.g. in `App.tsx` next to the existing
`settings.get().then(onboardingComplete…)` effect):

```tsx
useEffect(() => {
  window.artha.settings.getSentry().then(({ disclosureAck }) => {
    if (!disclosureAck) {
      // show a one-time banner/modal with the text in §3d, then:
      window.artha.settings.ackSentryDisclosure();
    }
  });
}, []);
```

**(b) Persisted reasoning after reload** — wherever the renderer loads a
session's history (`window.artha.sessions.getMessages(...)` → `setMessages`),
map the new `reasoning` field onto each `Message` (the IPC already returns it;
the `Message` type already has the optional `reasoning` field, so a pass-through
map needs no change — only confirm the mapper copies unknown fields or add
`reasoning: r.reasoning`).
