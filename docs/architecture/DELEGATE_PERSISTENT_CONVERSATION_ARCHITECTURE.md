# Delegate — Persistent Conversation Architecture

**Status:** design + commit plan (Phase A.5, final element)
**Gate:** founder directive requires this document *before* building the full
Cowork-style workspace.
**Written:** after the trust model shipped (v0.4.0 → v0.4.9), so it describes
what actually exists rather than what was assumed.

---

## 1. Why this document exists

The founder-critical defect was a **one-shot, closed run**: Delegate produced a
final message, declared completion, and the task was over. There was no way to
say *"that's not right, continue"* — and no evidence to challenge.

The trust half of that problem is now solved and verified:

| Shipped | What it guarantees |
|---|---|
| `bodhi/taskModel.ts` | Three separate dimensions (run / verification / task). Only `deriveTaskStatus` may conclude `completed`. |
| `bodhi/runFacts.ts` | Tool + mutation tallies persisted as evidence instead of discarded. |
| `bodhi/delegateOutcome.ts` (v0.4.8) | The **UI renders from evidence**, never from `agent_runs.status`. |
| `bodhi/criteria.ts` (v0.4.9) | "Verified" is **earned** — claimed file paths are checked against the real filesystem. |
| `external_actions` write-ahead log | Consequential actions (send) can't double-fire and can't be claimed without confirmation. |

What remains is the **interaction** half: the task as a durable, reopenable,
challengeable object.

---

## 2. What already exists (reuse map — do NOT rebuild)

Substantially more is built than the roadmap assumed. The remaining work is
mostly **surfacing** it.

### Backend (`ipc/handlers.ts`)
| Handler | Does | State |
|---|---|---|
| `delegate:start` | Creates session (`origin='delegate'`) + run, operator skill | ✅ |
| `delegate:status` | **Evidence-derived** outcome (label/message/isComplete) | ✅ v0.4.8 |
| `delegate:continue` | Continues the task **in the same session** — the task does not close | ✅ |
| `delegate:thread` | Full message history for the task | ✅ |
| `delegate:list` | Every delegate task, newest first | ⚠️ **built, never called by the UI** |
| `delegate:cancel` | Stops a running task | ✅ |

### Renderer
| Piece | State |
|---|---|
| `stores/delegate.ts` — `continueTask`, `loadThread`, `thread` | ✅ |
| `stores/delegate.ts` — `openTask(sessionId, runId)` | ⚠️ **exists, nothing calls it** |
| `DelegateTab` — thread render + follow-up composer | ✅ |
| Task list / history surface | ❌ **missing** |

### The gap this creates (a real regression)
v0.4.6 stopped terminal tasks from auto-restoring on launch (they were showing a
stale error every time). Correct on its own — but with **no task list**, a
finished task is now **unreachable**. The data is all there (`delegate:list`,
`openTask`); there is simply no door.

**This is the single highest-value fix and it is small.**

---

## 3. Design principles (carried from the trust work)

1. **The task is the durable object, not the run.** `agent_tasks` anchors N runs
   (`agent_runs.task_id`, wired in v0.4.9). A follow-up is a *new run on the same
   task*, not a new task.
2. **A final message never closes anything.** Terminal ≠ closed. Every terminal
   state keeps the composer available.
3. **Never re-fire consequential actions on resume.** `external_actions`
   fingerprint dedupe already enforces this — resume must not bypass it.
4. **Honest status everywhere.** Any new surface renders from
   `deriveDelegateOutcome`, never from raw `agent_runs.status`.
5. **Model-independent.** No new behaviour may depend on which model is loaded.

---

## 4. Target interaction model

```
Task (agent_tasks)
├── objective, task_status, verification_status, acceptance_mode
├── conversation  ← chat_sessions (origin='delegate'), never closed
├── runs[]        ← agent_runs (each attempt), evidence + criteria per run
└── actions       ← external_actions (consequential, deduped)
```

**States the user can act from:** `Ready for your review` → *Accept* / *Continue*
/ *Challenge*; `Failed` / `Blocked` → *Retry* / *Continue*; `Completed —
verified` → *Continue* (follow-up work).

---

## 5. Commit plan

Ordered smallest-risk-first; each is independently shippable and testable.

| # | Commit | Scope | Risk |
|---|---|---|---|
| **1** | **Task list + reopen** | Renderer surface over the existing `delegate:list` + `openTask`. Closes the reachability regression. | **Low** — no backend change |
| 2 | Accept / reject a reviewed result | `user_accepted` acceptance mode: an explicit Accept records a `user_accepted` criterion outcome → task reaches `completed` honestly | Low–Med (schema already supports it) |
| 3 | Challenge / revise in place | Reuse `delegate:continue`; make the follow-up composer available in **every** terminal state, not just `thread.length > 1` | Low |
| 4 | Per-run evidence inspector | Surface `task_evidence` + `task_acceptance_criteria` per run (why it is/isn't verified) | Med (new UI) |
| 5 | Resume safety review | Explicit test that resume never re-fires a confirmed `external_action` | Med (safety-critical) |

**Deliberately deferred:** multi-pane "workspace" chrome, parallel task
dashboards, drag-and-drop artifacts. Those are Cowork-parity *appearance*; the
directive forbids parity claims until benchmarked, and none of it improves trust.

---

## 6. Success criteria

- A finished task is reachable after relaunch (regression closed).
- A task can be continued/challenged from any terminal state; the thread survives.
- Accepting a reviewed result yields `completed` via `user_accepted` — never a
  silent auto-complete.
- Resume never re-fires a confirmed consequential action.
- Zero false completions on the adversarial set (unchanged from A.5 baseline).

---

## 7. Known issues to carry

- **Local-model latency:** qwen2.5:14b took >3 min on a trivial "list files"
  task. Independent of correctness, but it dominates perceived quality. Needs its
  own investigation.
- **Profile split:** installed (`Artha`), dev `--dir` (`artha`), and
  `npx electron` (`Electron`) resolve to *three* different userData dirs, and dev
  builds share the production bundle id. This caused real "wrong build / wrong
  data" confusion. Worth a permanent fix.
