# Task / Run / Verification state model (Phase A.5)

**Governing rule:** Artha must distinguish *an execution stopped*, *an execution technically succeeded*, and *the user's objective was actually completed*. These are three different facts and get three different fields.

---

## 1. The three dimensions

### 1.1 Run status — "what happened to this execution attempt?"
`queued · running · succeeded · failed · timed_out · cancelled · interrupted`

`succeeded` means only: the executor finished without an execution-level failure. **It carries no claim about the user's objective.**

`interrupted` is new and load-bearing: today an app quit leaves `agent_runs.status='running'` forever, which is indistinguishable from a live run (audit §3 E8).

### 1.2 Verification status — "what does the evidence prove?"
`not_evaluated · verified · unverified · verification_failed · not_verifiable · awaiting_user_review · not_applicable`

### 1.3 Task status — "where does the user's objective stand?"
`draft · queued · active · awaiting_user_input · awaiting_approval · paused · blocked · partially_completed · awaiting_user_review · completed · failed · cancelled`

Only the **task** dimension may ever read `completed`, and only the validator may write it.

---

## 2. Legal combinations (enforced by test)

Many combinations are nonsense and must be unrepresentable in practice. The projection below is the single source of user-facing wording.

| Run | Verification | ⇒ Task | User-facing wording |
|---|---|---|---|
| succeeded | verified | completed | "Done — verified: *(evidence)*" |
| succeeded | awaiting_user_review | awaiting_user_review | "The requested draft is ready for your review." |
| succeeded | unverified | partially_completed | "The run finished, but Artha could not verify the result." |
| succeeded | not_verifiable | partially_completed | "The run finished. This objective can't be verified automatically." |
| succeeded | verification_failed | blocked | "The run finished, but a required check failed: *(which)*" |
| failed | any | failed | "The run failed at step N: *(error)*" |
| timed_out | any | partially_completed | "The run hit its time limit with N of M steps done." |
| interrupted | any | partially_completed | "The run was interrupted (app closed). Its last confirmed step was N." |
| cancelled | any | cancelled | "You cancelled this run." |
| running | not_evaluated | active | "Working…" |
| — | — | awaiting_approval | "Waiting for your approval to *(action)*." |

**Illegal (test-enforced):** `run=failed` + `verification=verified`; `task=completed` with any unresolved required criterion; `task=completed` with `verification ∈ {not_evaluated, unverified, verification_failed}`.

**One projection, one wording.** `userFacingOutcome(task)` is the only function permitted to produce completion language. Delegate UI, scheduler notifications, and the future CLI must all call it — **the model never writes status text.** This is what stops the notification layer becoming the new lying surface.

---

## 3. Acceptance criteria must be machine-checkable to count

The circularity risk: if the model writes the criteria *and* does the work, it can author criteria it trivially passes. Therefore:

**A criterion may only produce `verified` if it compiles to a predicate from this closed vocabulary:**

| Predicate | Evidence it consumes |
|---|---|
| `file_exists(path)` / `file_non_empty(path)` / `file_parses_as(path, type)` | real `fs.stat` at validation time, not the tool's own claim |
| `command_exit_code(cmd, 0)` | recorded exit code |
| `tests_pass(suite)` | runner output |
| `artifact_exists(artifact_id)` | `artifacts` row + on-disk check |
| `external_action_confirmed(kind, id)` | provider-returned identifier (message id, commit sha) |
| `http_status(url, code)` | recorded response |

Anything the model expresses in prose is legal and is stored — but it can only ever reach **`awaiting_user_review`**, never `verified`. Free-form criteria are review prompts, not proofs.

Where criteria cannot be inferred safely, Delegate asks the user or marks them review-required.

---

## 4. Write-ahead intent (required for duplicate-action safety)

Today, after a crash, "never attempted" and "attempted, outcome unknown" are indistinguishable — nothing is written before a consequential call. "Do not replay uncertain actions" is therefore unimplementable as stated.

Fix: for every consequential action (send, submit, purchase, delete, publish, external write, commit/push), write the intent **before** the call:

```
external_actions: intent_id, task_id, run_id, kind, target_digest,
                  state ∈ {intended, attempting, confirmed, failed, unknown},
                  external_ref (message id / sha / receipt), attempted_at, resolved_at
```

Crash between `attempting` and a resolution ⇒ the row stays `attempting` and is promoted to **`unknown`** on next launch. `unknown` **blocks automatic retry** and requires verification or explicit user approval. This single table is what makes the founder's §10 requirement real.

---

## 5. Schema plan — additive only (recommended)

`agent_runs.status` carries `CHECK(status IN ('running','completed','failed','cancelled'))`, and SQLite cannot alter a CHECK. A rebuild is possible but hazardous: `agent_steps` has `ON DELETE CASCADE` on `run_id`, so a naive `DROP TABLE agent_runs` **deletes the entire evidence history**.

**Recommendation: do not rebuild.** All three dimensions fit additively:

```sql
-- agent_runs: additive columns, deliberately WITHOUT CHECK constraints so the
-- vocabularies can evolve without another table rebuild.
ALTER TABLE agent_runs ADD COLUMN run_outcome          TEXT;    -- §1.1 (NULL ⇒ derive from legacy status)
ALTER TABLE agent_runs ADD COLUMN task_status          TEXT;    -- §1.3 (NULL ⇒ 'unknown (pre-A.5)')
ALTER TABLE agent_runs ADD COLUMN verification_status  TEXT;    -- §1.2 (NULL ⇒ 'not_evaluated')
ALTER TABLE agent_runs ADD COLUMN verified_at          INTEGER;
ALTER TABLE agent_runs ADD COLUMN tool_calls_total     INTEGER; -- audit E2: stop discarding
ALTER TABLE agent_runs ADD COLUMN tool_calls_failed    INTEGER;
ALTER TABLE agent_runs ADD COLUMN remaining_work_json  TEXT;

CREATE TABLE IF NOT EXISTS task_acceptance_criteria (
  criterion_id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  run_id TEXT NOT NULL,            -- no FK: never cascade-delete evidence
  kind TEXT NOT NULL,              -- 'predicate' | 'review'
  predicate TEXT,                  -- closed vocabulary (§3); NULL for review-only
  description TEXT NOT NULL,
  required INTEGER NOT NULL DEFAULT 1,
  outcome TEXT,                    -- 'passed' | 'failed' | 'not_evaluated' | 'awaiting_user_review'
  detail TEXT, evaluated_at INTEGER
);

CREATE TABLE IF NOT EXISTS task_evidence (
  evidence_id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  run_id TEXT NOT NULL, criterion_id TEXT,
  kind TEXT NOT NULL,              -- 'tool_result' | 'file' | 'artifact' | 'external_action' | 'test' | 'receipt'
  ref TEXT,                        -- path / artifact_id / external id / step idx
  status TEXT NOT NULL,            -- 'succeeded' | 'failed' | 'partial' | 'unknown'
  summary TEXT,                    -- sanitized; NEVER secrets or raw payloads
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS external_actions (  -- §4
  intent_id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  run_id TEXT NOT NULL, kind TEXT NOT NULL, target_digest TEXT,
  state TEXT NOT NULL DEFAULT 'intended',
  external_ref TEXT, attempted_at INTEGER, resolved_at INTEGER
);
```

**Legacy rows:** `task_status IS NULL` projects as *unknown (pre-A.5)* — never silently re-labelled `completed`. That preserves history honestly and needs no backfill.

**Migration class: additive, non-destructive, reversible** (an older build ignores unknown columns; new tables are inert to it). No founder review of a destructive migration is required under this plan.

---

## 6. Structured tool result envelope

`invokeTool` currently returns a **string**, and failure is inferred via `result.startsWith('Error:')` (audit E6). Wrap — don't rewrite — at the dispatch boundary:

```ts
interface ToolExecutionResult {
  status: 'succeeded' | 'failed' | 'partial' | 'timed_out' | 'cancelled' | 'interrupted';
  output?: unknown;
  error?: { code?: string; message: string; retryable?: boolean; category?: string };
  evidence?: EvidenceReference[]; artifacts?: ArtifactReference[];
  externalActions?: ExternalActionReference[];
  warnings?: string[]; remainingWork?: string[];
  startedAt: string; finishedAt: string; durationMs: number; attempt: number;
}
```

Existing string-returning tools keep working via an adapter (`string → {status, output}`), so this is incremental, not a big-bang refactor. Sanitization rule: evidence stores references and sanitized summaries — **never secrets or raw tool payloads**.

---

## 7. Reuse vs build

**Reuse as-is:** `agent_steps` trace, `bodhi/receipts.ts` (already distinguishes ok/error/blocked/dry-run), `tool_audit_log`, `TrackedMutation` success semantics, `generateVerifiedSummary` (becomes an evidence renderer), `RunInspector` (already the correct evidence UI), `bodhi/tasks.ts` API.
**Refactor:** orchestrator completion site (§ audit E1), tool dispatch envelope, `delegate:status` IPC contract (4 fields → task/run/verification + evidence + remaining work).
**Build new:** completion validator, acceptance-criteria compiler, `external_actions` intent log, `userFacingOutcome()` projection, persistent Delegate thread.
**Deferred (not this phase):** full Cowork workspace UI, scheduler interface redesign, recurrence/execution-semantics changes.
