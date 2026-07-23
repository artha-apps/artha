# Delegate & Scheduler evidence audit (Phase A.5)

**Question this document answers:** *What evidence does Artha actually possess today, and what completion claims can that evidence legitimately support?*

**Method:** direct source trace of the execution path (this section), plus two independent forensic audits of the scheduler path and the Delegate UI/status mapping. Branch `phase-a5/delegate-trust`. No behaviour changed by this document.

---

## 1. Root cause of false completion

**`agent_runs.status = 'completed'` is written from control flow, never from evidence.**

`packages/app/src/agent/orchestrator.ts:1722`

```js
recordStep(stepIdx++, 'final', { content: finalText });
db.prepare(`UPDATE agent_runs SET status='completed' WHERE run_id=?`).run(args.runId);
```

This executes on exactly one condition: **the model returned assistant text without tool calls**, so the ReAct loop breaks. Nothing else is consulted. Specifically, the write does *not* read:

| Available signal | Where it lives | Consulted before marking completed? |
|---|---|---|
| `toolCallErrors` / `toolCallsTotal` | `orchestrator.ts:1563` | **No** |
| `mutations[].success` | `orchestrator.ts:1569` | **No** |
| Artifact / file existence | not captured at all | **No** |
| Unresolved plan steps | plan exists, not reconciled | **No** |
| Pending approvals | `agent_states.status` | **No** |
| Acceptance criteria | do not exist | **No** |

The model never calls a "declare done" tool — it does not have to. **Its decision to stop calling tools *is* the completion signal.** That is the mechanism behind the founder-observed failure: a run in which every tool call failed, or in which no tool was ever called, still reaches line 1722 and is recorded as `completed`.

### Why the existing safeguards did not prevent it

Two anti-hallucination mechanisms already exist, and both are **text-only** — neither touches the status field that Delegate, the scheduler, and any future validator consume:

1. **Verified summary** (`orchestrator.ts:1664-1666` → `generateVerifiedSummary:1892`). When filesystem mutations occurred, the user-facing prose is regenerated from ground truth (`N ok, M failed`) instead of the model's narration. Good machinery — but scoped to `MUTATION_TOOLS` (filesystem only, `orchestrator.ts:159`), and it changes **text**, not status.
2. **All-tools-failed caution** (`orchestrator.ts:1689`):
   ```js
   if (mutations.length === 0 && toolCallsTotal > 0 && toolCallErrors === toolCallsTotal) {
     finalText = `${finalText}\n\n⚠️ Heads up: every tool call in this run failed …`;
   }
   ```
   Fires only when **every** call failed. A run where 3 of 4 tool calls failed gets no caution, no status change. A run with **zero** tool calls that simply asserts success gets neither.

So the honest conclusion is not "nothing was built" — it is that **the existing honesty work stops at the prose layer, while every consumer of truth reads the status column.**

---

## 2. What evidence Artha actually possesses today

Genuinely present and reusable — this is a stronger base than the symptom suggests:

| Evidence | Location | Fidelity |
|---|---|---|
| Every tool call + result | `agent_steps` (`kind='tool_call'` / `'tool_result'`) | Persisted per run, ordered by `idx` |
| Per-call success/failure tally | `toolCallsTotal` / `toolCallErrors` (in-memory) | Accurate, **discarded at run end** |
| Filesystem mutation outcomes | `TrackedMutation[]` (in-memory) | success flag is strict (`receiptStatus==='ok' && toolStatus==='ok' && !result.startsWith('Error:')`), **discarded at run end** |
| Hashed action receipts | `bodhi/receipts.ts`, `tool_receipts` | auto / confirmed / blocked / dry-run distinction survives |
| Tool audit log | `tool_audit_log` | per-invocation, with actor |
| Step trace API | `bodhi/tasks.ts:getTaskSteps` | already the intended verification surface |
| Run lineage | `agent_runs.parent_run_id`, `forked_from_step` | supports sub-tasks/forks |

**Missing entirely:** acceptance criteria, artifact identity/verification, external-action identifiers (message ids, commit shas), remaining-work list, retry counts, timeout/cancellation distinction at run level, and any verification dimension.

### What these facts can legitimately support today

- ✅ *"The executor ran and stopped without throwing."*
- ✅ *"N tool calls were made; M failed."*
- ✅ *"These filesystem mutations succeeded/failed."*
- ⚠️ *"The requested file exists"* — only if a mutation tool reported it; never re-checked on disk.
- ❌ *"Your objective was achieved."* — **no evidence class in the system supports this claim.**

---

## 3. Evidence-loss map (core path)

| # | Location | What is lost | Class |
|---|---|---|---|
| E1 | `orchestrator.ts:1722` | Completion asserted with no evidence input | **Optimistically marked successful** |
| E2 | `orchestrator.ts:1563` | `toolCallsTotal`/`toolCallErrors` never persisted | **Computed, then dropped** |
| E3 | `orchestrator.ts:1569` | `mutations[]` never persisted | **Computed, then dropped** |
| E4 | `orchestrator.ts:1689` | Failure signal lands in prose only | **Persisted but not surfaced as state** |
| E5 | `orchestrator.ts:1730-1739` | Stall (3 empty responses) and `max_iterations` both collapse to `failed` — indistinguishable from a real error, and from a *partial* result | **Flattened** |
| E6 | tool dispatch | `toolResult` is a **string**; failure detected via `startsWith('Error:')` | **Structured → string** |
| E7 | `MUTATION_TOOLS` (`:159`) | Only filesystem tools tracked; browser, docs, MCP, web, memory mutations invisible to verification | **Not captured** |
| E8 | run end | No timeout/interrupted/cancelled-mid-flight distinction; app quit leaves `status='running'` forever | **Lost on restart** |

---

## 4. Schema blocker (founder stop-condition — decision required)

`packages/app/src/db/schema.ts`:

```sql
status TEXT NOT NULL DEFAULT 'running'
  CHECK(status IN ('running','completed','failed','cancelled'))
```

The approved model needs three dimensions (task lifecycle ~11 states, run status 7, verification 7). The current column cannot hold them, and **SQLite cannot ALTER a CHECK constraint** — it requires a table rebuild.

**Hazard:** `agent_steps.run_id REFERENCES agent_runs(run_id) ON DELETE CASCADE`. With `foreign_keys=ON` (which Artha sets), `DROP TABLE agent_runs` performs an implicit delete that **cascades and destroys the entire step history** — i.e. the evidence this phase exists to protect. Any rebuild must run under `PRAGMA foreign_keys=OFF` inside a transaction, with a verified backup.

**Recommended alternative — fully additive, no rebuild, no destruction:**

1. Keep `agent_runs.status` as the **run** dimension. Its four values map cleanly (`completed` → *succeeded*), so all existing rows and readers stay valid.
2. Add new **nullable columns without CHECK constraints** for the dimensions it cannot express: `run_outcome` (adds `timed_out`, `interrupted`, `queued`), `task_status` (lifecycle), `verification_status`, `verified_at`.
3. Add new tables for the rest: `task_acceptance_criteria`, `task_evidence`, `external_actions`.
4. Legacy rows read as `task_status = NULL` → projected as *unknown (pre-A.5)* rather than silently re-labelled `completed`.

This satisfies the state model with **additive migrations only**, so no founder review of a destructive migration is required. Recommendation: take this path; treat the rebuild as unnecessary risk.

---

## 5. Scheduler findings

**The scheduler's success signal is a boolean derived from the absence of an exception in a code path engineered never to throw one.**

`scheduler.ts:284-286`:
```js
await this.runTask!(prompt);
db.prepare(`UPDATE scheduled_tasks SET last_status='ok' WHERE task_id=?`).run(taskId);
sendNotification('Artha — scheduled task complete', taskRow?.name ?? prompt.slice(0, 60));
```
`runTask` returns `Promise<void>` (`scheduler.ts:63`) — the scheduler never learns the run's identity **or** its outcome. Every orchestrator failure path (`LLM error 1419`, `cancelled 1373`, `stall 1727`, `max_iterations 1737`, all-tools-failed `1689`) ends in `break`, not `throw`. So `last_status='ok'` is written for runs that ended `failed` and `cancelled`.

### 5.1 Three ways a scheduled run reports `ok` having done nothing

| # | Path | What happens |
|---|---|---|
| S1 | **Approval dead-end** (`orchestrator.ts:354-358`) | `plan.requiresApproval` (decided by the planner LLM) makes `handleMessage` **return normally before any `agent_runs` row exists**. Scheduler writes `ok`, bumps `run_count`, fires "scheduled task complete". *Nothing ran, and there is no run to inspect.* `getRunContext()` is consulted for clarification and tool tiers but **never for plan approval**. Worse: `agent:planReady` is wired to the renderer, so a 3 AM task injects an approval card into whatever chat is open; approving later runs **outside** `runWithContext`, losing `actor='scheduler'` and `unattended`, and `scheduled_tasks` is never updated again. |
| S2 | **Intent misroute** (`orchestrator.ts:422-424`) | A question-shaped prompt routes to `handleConversational` — **no tools at all**. The model answers from weights, `agent_runs` is set `completed` (`:560`), scheduler writes `ok`. Zero tool calls, zero receipts, nothing marks the answer ungrounded. |
| S3 | **Conversational LLM failure** (`orchestrator.ts:546-560`) | The error is caught **into the answer text** and `UPDATE agent_runs SET status='completed'` at `:560` runs **unconditionally, outside the try**. Both the run row and the scheduler row lie. |

### 5.2 Two notifications, both hardcoded to claim completion
`scheduler.ts:286` ("Artha — scheduled task complete") and `orchestrator.ts:1749-1752` ("Artha — task complete", fired for any run >10 s **after and outside every status branch**). Bodies are user-authored (good — no model text), but the titles assert completion for runs that failed, were cancelled, stalled, hit the iteration cap, had every tool call error, had every consequential tool policy-blocked as unattended, hallucinated via S2, or **executed nothing** via S1. `focusOnClick` only focuses the window — **no deep link** to the run.

### 5.3 No link from task to run
`scheduled_tasks` has **no `last_run_id`, no `last_session_id`**. `main.ts:165` mints the sessionId as a local variable and never persists the association. The only available join is a string-prefix heuristic (`ActivityPanel.tsx:31`: `session_title.startsWith('Scheduled:')`), which cannot identify *which* task. Related: `main.ts:166` never sets `origin`, so scheduled sessions default to `'chat'` and **appear in the user's normal chat sidebar** — and the comment at `handlers.ts:1031` claiming otherwise is factually wrong.

### 5.4 Time, restart and concurrency
- **No timeouts anywhere in the inference path.** `MAX_ITERATIONS=60` and `emptyCount>=3` are iteration counts, not wall-clock. `streamComplete` has no request timeout; a scheduled run's `shouldAbort` closes over a workflowId **no UI can ever reach**, so a hung Ollama stream holds the task in `'running'` for the life of the process.
- **No in-flight lock.** An hourly cron whose run exceeds an hour starts a second concurrent run; `run_count` double-counts and the two `last_status` writes race — one run's `error` can be overwritten by the other's `ok`.
- **App quit** leaves `scheduled_tasks.last_status='running'` and `agent_runs.status='running'` **permanently**; there is no startup reconciliation. "Crashed mid-run" and "still running" are indistinguishable.
- **Missed cron fires are silently skipped** — no row, no log, no counter. **One-shots whose `fire_at` passed while closed stay `is_enabled=1` forever**, re-skipped on every launch, displayed as enabled-but-never-run.
- `makeRunner` is declared `(): () => void` but returns an async function, so throws **outside** the try (`:279-280`, `:294-298`) become unhandled rejections with no status write and no log.

### 5.5 What the scheduler legitimately possesses
Exactly four self-generated facts: a fire timestamp, an attempt counter (both written *before* the work), a three-valued string, and `is_enabled`. **No run_id, session_id, tool result, exit code, artifact path, step count, duration, error message, or outcome.** The rich audit trail exists in five other tables with no key back to the task.

**Honest phrasing of today's notification:** *"Artha attempted a scheduled task."*

## 6. Delegate UI / status-mapping findings

Independent forensic audit. **The renderer manufactures more false confidence than the backend does.** The backend at least *computes* honest facts and then discards them; the UI actively fabricates facts it never had.

### 6.1 Seven manufacturing sites (ordered by severity)

| # | Site | What is fabricated |
|---|---|---|
| U1 | `delegateService.ts:336` | On completion, **every** plan step is force-stamped `done` — `for (let i = cursor; i < steps.length; i++) hooks.onStep(steps[i].index, 'done')`. Those steps were never sent to the backend, so no execution fact about any of them exists. Renders a green check per step. |
| U2 | `delegateService.ts:356-362` | **Wall-clock progress**: one step turns green every 1.2 s of elapsed time, independent of what the agent is doing. A 4-step plan shows 3 green checks within ~3.6 s. |
| U3 | `delegateService.ts:341` | `summary: st.output?.trim() \|\| 'Task completed.'` — when the agent produced **no** final message, the renderer authors the completion claim itself. |
| U4 | `orchestrator.ts:1722` + `operator.ts:31` | The playbook explicitly permits emitting prose **when blocked**; prose ⇒ `completed`. "I was blocked at the login wall" and "I sent the emails" traverse identical code to an identical green result panel. |
| U5 | `DelegateProgressTimeline.tsx:48-53` | On `completed` **all six** stages turn green including "Reviewing output" (which was a 400 ms `wait()`); on `failed` `activeStageIndex` returns `-1`, so **every** stage renders `pending` — erasing the visible record of how far the run actually got. |
| U6 | `delegateService.ts:343-347` | Three **hardcoded** "next actions" rendered in the same typography as model output — one of them ("Refine the result with a follow-up") describes a capability the UI does not have. |
| U7 | `delegate.ts:56,128-131,150-160` | No run-generation guard: an abandoned run's `set({result, status:'completed'})` can **resurrect a green Result panel above an empty goal banner and a null plan** — a completion claim attached to no task. |

### 6.2 Stage vocabulary is largely fiction
`understanding` / `retrieving_context` / `planning` are hardcoded `wait(700|700|900)` calls (`delegateService.ts:252-257`); `reviewing` is `wait(400)` between "run reported done" and "tell the user done" (`:337-339`). The IPC engine reuses the **mock** planner verbatim (`:307`), so the plan the user approves is regex-derived, not model-derived.

### 6.3 Structural defects
- **The approved plan is not the executed plan.** Only `plan.goal` crosses IPC (`delegateService.ts:311`); the reviewed steps/tools/agents are discarded, and the backend runs the operator skill with `allowedTools: []` = unrestricted (`operator.ts:48`). The user approves a bounded 4-step plan; an unbounded-tool operator loop executes.
- **`runId` is discarded** (`delegateService.ts:311`), so Delegate *cannot* link to the evidence surfaces that already exist and are good (`RunInspector` with per-tool `ok|error|blocked|dry-run` receipts, content hashes, step trace, reversible changes). `window.artha.delegate.steps` is exposed in preload and **never called anywhere in the renderer**.
- **`cancelled` is flattened to `failed`** (`handlers.ts:805-806`); a missing run row reads as `'running'` and polls for 15 minutes.
- **Renderer-only 15-min timeout**: the UI reports `failed` while the backend run continues writing files.
- **In-flight tasks are unrestorable** (`delegate.ts:56`): on relaunch a live full-tool-access run vanishes into the idle hero screen, with no reattach and no way to stop it.
- **No message box, and `reset()` destroys the task** (`delegate.ts:128-131`) — goal, plan, result and error are nulled in memory *and* localStorage. Persistence is `artha.delegate.current.v1`: **one** task, no history, no archive. The backing `chat_sessions` row is hidden from the sidebar (`origin='delegate'`), so the conversation is unreachable.

### 6.4 The structural root
A six-stage, per-step, per-file progress model is rendered on top of a backend contract returning four fields — `{status, output, files, stepCount}` (`handlers.ts:821`) — of which the UI reads three and displays two. **The resolution gap is filled with timers, loop cursors and string literals, and every fill resolves toward success.**
