# Artha Automation Object Model

**Status**: Foundational decision record — decided now, implemented incrementally across Phases A–E.
**Scope**: The single shared task-and-automation object model that Scheduler, Routines, Workflows, Dispatch, and Cowork are all built ON, not beside.
**Related**: `ARTHA_SECURITY_THREAT_MODEL.md` (tag/policy enforcement at context assembly), `ARTHA_MONETIZATION_TECHNICAL_FOUNDATION.md` (run ledger / metering).

---

## 1. The Principle

**Every automation feature is a view over shared objects, not its own subsystem.**

A schedule is not "the Scheduler feature's data". A routine is not "the Routines feature's data". They are all projections of the same small set of core objects — Task, Capability, Schedule, Workflow, Approval, Artifact — stored in one SQLite database (`packages/app/src/db/schema.ts`) and executed by one engine (`packages/app/src/agent/orchestrator.ts`).

This is not aspirational: the seed already exists in the Bodhi layer:

- `packages/app/src/bodhi/tasks.ts` — a **Task is the existing `agent_runs` row**, given a first-class API (`getTask`/`listTasks`/`getTaskSteps`/`setTaskStatus`). No new table was created; a durable, resumable unit of work was *named*.
- `packages/app/src/bodhi/capabilities.ts` — the universal `invoke(capability, input, context)` contract. `CapabilityRegistry` wraps `SkillRegistry` so **skills ARE capabilities today** and future autonomous agents implement the *same* interface ("promote a skill to an agent" is the `skills.kind` flag, not a rewrite).
- `packages/app/src/bodhi/executor.ts` — `OrchestratorCapabilityExecutor` runs every capability through `AgentOrchestrator.runCapability()`, so Delegate, Scheduler fires, and future Dispatch runs execute through the **same ReAct engine as Chat**, tracked as Tasks.

The consequence for future features:

| Feature | What it actually is |
|---|---|
| Scheduler | a trigger that creates Tasks (`scheduled_tasks` → Task) |
| Routine | a Schedule + a Workflow + Approvals + expected outputs, bundled and named |
| Workflow | a declarative graph whose node execution IS Task/sub-Task execution |
| Dispatch | Bodhi grown up — objective in, capability selection, decomposition into child Tasks, outcome out. **NOT a new subsystem.** |
| Cowork | shared visibility + handoff over the same Task/Approval/Artifact rows (LAN hub) |

If a Phase A–D feature ships with its own private "runs" or "jobs" table, that is a design bug. Everything that does work produces `agent_runs` + `agent_steps` rows and `tool_receipts`.

---

## 2. Core Objects

### 2.1 Task

**Definition**: One durable, resumable, forkable unit of agent work. The atom of the whole model.

**Existing tables**: `agent_runs` (run_id, session_id, workflow_id, `parent_run_id`, `forked_from_step`, goal, model, status ∈ running/completed/failed/cancelled) + `agent_steps` (per-run ordered trace: system/user/assistant/tool_call/tool_result/final, with `messages_snapshot` — this is what makes **time-travel forking** work today via `TimeTravelPanel`). `bodhi/tasks.ts` is the read/write API; `rowToTask` is the pure projection.

Lineage already exists in two forms: `forked_from_step` (time-travel) and `parent_run_id` (the orchestrator's `runChildCapability` creates child runs with the parent's id, intersected tool scope, and `depth+1`).

**Gaps**:
- No `trigger` provenance — a Task cannot say whether it came from chat, delegate, a schedule, a workflow node, or dispatch.
- No limits recorded on the run (time/cost/tool budget) — see §3.
- No terminal `outcome` payload (the executor scrapes the last agent message from `messages`, which is fragile).
- No priority / queue position for a durable queue.

**Target shape** (additive columns on `agent_runs`): `trigger_kind` ('chat'|'delegate'|'schedule'|'workflow'|'routine'|'dispatch'), `trigger_id` (the schedule/workflow-run/routine id), `limits_json`, `outcome_json`, `project_id`.

### 2.2 Capability

**Definition**: Anything Bodhi can invoke to do work. The universal execution unit.

**Existing tables/code**: `skills` table (slug, name, description, instructions, `allowed_tools_json`, `kind` ∈ skill/agent, `pinned_model`) + `SkillRegistry` (`packages/app/src/skills/registry.ts`) + the `Capability`/`CapabilityExecutor` contract and `CapabilityRegistry` in `bodhi/capabilities.ts`. Per-invocation metrics already land in `skill_runs` (linked to `agent_runs.run_id`).

**Gaps**: no input/output schema on a capability (needed for workflow node wiring and dry-run validation); no cost profile; no declared risk tier (which tools it may mutate with — today only inferable from the allowlist).

**Target shape**: additive columns on `skills`: `input_schema_json`, `output_schema_json`, `risk_tier`. The `invoke(capability, input, context)` contract does **not** change — every new object below ultimately bottoms out in this call.

### 2.3 Schedule

**Definition**: A time-based trigger that creates Tasks.

**Existing tables/code**: `scheduled_tasks` (name, prompt, cron | fire_at, is_enabled, last_run_at, last_status, run_count) + `SchedulerService` (`packages/app/src/scheduler/scheduler.ts`, node-schedule, in-memory `jobs` map, runner injected at `init()`).

**Gaps** (all real product needs):
- **Missed-run behaviour** — node-schedule jobs simply don't fire if the app was closed; nothing records the miss or decides catch-up vs skip.
- **Retry policy** — a failed fire sets `last_status='error'` and stops.
- **Budget/limits** — no token/cost/time cap on the fired run.
- **Approval requirements** — a schedule can currently run any prompt unattended.
- **Device-awake requirements** — no declaration of "needs screen unlocked / needs network / can run headless".
- **Durable queue** — a fire that arrives while another heavy run is active just runs concurrently; there is no queue row that survives restart.
- The fired run is a bare `runTask(prompt)` — the resulting `agent_runs` row has no link back to the schedule.

**Target shape**: additive columns on `scheduled_tasks`: `missed_policy` ('skip'|'run_once_on_launch'|'run_all'), `retry_json` ({max, backoff_ms}), `limits_json` ({max_seconds, max_tokens, max_cost_cents, max_tool_calls}), `approval_required` (0/1 + risk tier), `requires_json` ({awake, network, model}), `capability_id`, `workflow_id`, `project_id`, `timezone`. Fires enqueue a row in a small `task_queue` (or write the Task immediately with status 'queued' — decided at implementation; the object model only requires that a fire is durable before it executes).

**Interface rule**: the local `SchedulerService` and any future managed cloud scheduler implement the **same interface** — `list/create/update/remove/toggle` over `scheduled_tasks` rows plus a `fire(schedule) → Task` contract. The cloud variant is a different trigger source writing the same Task rows; renderer code (`SchedulerPanel.tsx`) must never know which one fired.

### 2.4 Routine (NEW)

**Definition**: A named, recurring personal/business sequence = **Schedule + Workflow + Approvals + expected outputs**. Examples: "Morning business review" (07:30 → run CRM digest workflow → expect a summary artifact → notify), "Daily inbox review", "Weekly financial summary".

**Existing tables**: none. A Routine is deliberately *thin* — it owns almost nothing:

```
routines row = { name, schedule_id → scheduled_tasks,
                 workflow_id → workflow_templates,
                 approval_policy, expected_outputs_json, project_id, tags }
```

**Gaps**: the table itself, plus UI. Nothing else — every execution concern (retries, limits, queueing) lives on the Schedule; every step concern lives on the Workflow; every consent concern lives on Approvals. If Routines ever needs its own executor, the model has failed.

**Target shape**: new `routines` table (see §4). Each fire produces a Task with `trigger_kind='routine'`, `trigger_id=routine_id`; the Routine detail view is `listTasks WHERE trigger_id = ?` — a pure view over Tasks.

### 2.5 Workflow

**Definition**: A versioned, declarative graph of steps executed as Tasks.

**Existing table**: `workflow_templates` — currently primitive: `(template_id, name, prompt_template, tool_sequence_json)`. Note the orchestrator's decomposition machinery already exists: `runParallel(sessionId, goal, subTasks)` fans out sub-tasks, and `runChildCapability` runs a capability as a silent child Task with lineage + scope intersection. Workflows are a *declarative front-end* onto that machinery.

**Gaps vs target**: no versioning, no graph (only a flat tool sequence), no conditions/loops, no human-approval nodes, no error branches, no per-step retries, no input/output schemas, no dry-run, no cost estimate, no import/export.

**Target shape**:
- `workflow_templates` gains `current_version` (additive); the graph itself lives in a new `workflow_versions` table (template_id, version, `graph_json`, `input_schema_json`, `output_schema_json`, created_at) — **versions are immutable**; editing creates a new version; running Tasks pin the version they started on.
- `graph_json` node kinds (reserved now, implemented incrementally): `capability` (invoke), `condition`, `loop`, `approval` (creates an Approval row and parks the Task), `parallel` (maps to `runParallel`), `error_branch`, `emit_artifact`.
- Dry-run = walk the graph, evaluate policies (`tool_policies` tiers incl. the existing `dry_run` tier), and produce a cost estimate from `model_profiles` latencies + capability cost profiles — without invoking anything.
- Import/export reuses the signed-bundle pattern from `packages/app/src/bundles/bundle.ts` (HMAC manifest, content hashing, `ENV:` secret stripping).
- A workflow *run* is not a new object: it is a parent Task whose children are the node Tasks.

### 2.6 Tag (NEW — first-class)

**Definition**: A named label with **policy semantics**, attachable to nearly everything: conversations (`chat_sessions`), files/scopes (`session_scopes`), memories (`memory_entities` — note its `tags_json` column is display-only today, no semantics), tasks (`agent_runs`), workflows, browser research (`web_cache`), artifacts, contacts (`crm_contacts`/`kg_entities`), projects, schedules, and routing policies.

**Semantics** (the built-in vocabulary; user tags are plain labels): `Confidential`, `Local Only`, `Cloud Allowed`, `Requires Approval`, `Do Not Retain`, plus project tags. Tags influence:
- **Routing** — `Local Only` content excludes cloud/BYOK models from the router's candidate set for any Task whose assembled context includes it.
- **Retention** — `Do Not Retain` rows are excluded from memory extraction and purged from `web_cache`/transcript exports.
- **Access control** — LAN/team visibility (extends the existing `is_shared` booleans on `memory_entities` and `context_packs`, which are effectively hard-coded single-purpose tags).
- **Cloud eligibility** and **workflow execution** — `Requires Approval` on any input object forces an Approval node even if the workflow didn't declare one.

**Enforcement point**: tags are evaluated at **context assembly** (`agent/contextGather.ts`, the memory preamble, pack injection in `agent/contextPacks.ts`) and at **model selection** — not scattered through feature code. See `ARTHA_SECURITY_THREAT_MODEL.md` for the threat analysis; the rule here is only that there is ONE place semantics are enforced.

**Target shape**: new `tags` + polymorphic `tag_assignments` tables (§4). No existing table changes.

### 2.7 Artifact

**Definition**: Any durable output the agent produced: file, document, generated report, exported dataset.

**Existing tables**: `artifacts` (session_id, name, file_path, file_type, size_bytes) — the browsable ledger behind `ArtifactsPanel` — and `generated_documents` (doc_id, file_path, doc_type ∈ docx/pptx/xlsx/pdf, prompt_hash, content_hash, receipt_path) with per-anchor `provenance_records` (source_type ∈ rag/tool/llm/user). Provenance is genuinely ahead of the curve here; the two tables just aren't unified.

**Gaps**: no `run_id` (which Task made it), no version chain (regenerate = new unrelated row), no project association, no access-control/tags, no typed preview/edit/export/regenerate contract.

**Target shape**: additive columns on `artifacts`: `run_id`, `project_id`, `doc_id` (links a generated document's provenance record), `version_of` (previous artifact_id — regeneration builds a chain), `source_json` (provenance summary for non-document artifacts). Tags come via `tag_assignments`. The local file under `~/Library/Application Support/Artha/artifacts/` remains the canonical bytes; rows are metadata.

### 2.8 Workspace / Project

**Definition**: The container: conversations + files + browser sessions + artifacts + tasks + schedules + workflows + memory + permissions + models + activity.

**Existing tables**: `projects` (root_path, rag_index_id, summary, `default_skill_id`, settings_json), `session_scopes` (per-chat sandbox, folder rows deduped into projects via `db/scopes.ts` `findOrCreateFolderWorkspace`), `context_packs` (portable named context sets, applied via `chat_sessions.context_pack_id`). Scoping columns already radiate outward: `chat_sessions.project_id`, `memory_entities.project_id`, `kg_entities.project_id`, `crm_*.project_id`.

**Gaps**: Tasks, Schedules, Workflows, and Artifacts have no `project_id`; no per-project permission or model policy beyond `default_skill_id`.

**Target shape**: add `project_id` to `agent_runs`, `scheduled_tasks`, `workflow_templates`, `artifacts` (all nullable — NULL = general, exactly the established convention). Per-project policy (allowed models, tool tiers) goes into the existing `projects.settings_json` first; promote to columns only when queried hot. A "workspace view" is then a set of `WHERE project_id = ?` queries — no new container table.

### 2.9 Approval (NEW)

**Definition**: A risk-tiered consent record — who approved what, when, at which risk tier, with what decision — **shared by** browser actions (the `browser_request_user` handoff), workflow approval nodes, dispatch gates, and desktop control.

**Existing seams**: `tool_policies` (tier ∈ auto/confirm/dry_run/forbid — the *rules*), `agent_states.status='awaiting_approval'` and `PlanApproval.tsx` (the plan gate), `tool_receipts.status='blocked'` (the after-the-fact trace). What's missing is the durable *record of the decision itself* — today a confirm is an ephemeral IPC round-trip.

**Target shape**: new `approvals` table (§4). A parked Task references its blocking approval; approving flips the approval row and resumes the Task. This gives Cowork its cross-device story for free: an approval is a row, so a teammate on the LAN hub can grant it.

### 2.10 Run Ledger Entry

**Definition**: Usage/cost per Task — tokens in/out, model, provider, wall time, estimated cost. The metering substrate for `ARTHA_MONETIZATION_TECHNICAL_FOUNDATION.md` and for enforcing per-Task budgets.

**Existing seams**: `skill_runs` (duration_ms, tool_calls — but only for skill-backed runs), `tool_receipts` (per-call durations). Nothing records tokens or cost.

**Target shape**: new `usage_ledger` table (§4): one row per Task (plus one per child Task), written by the orchestrator when a run terminates. Local-only by default; the aggregate (never the content) is what a future metered plan could report.

---

## 3. Dispatch Semantics

Dispatch is the mature form of the existing Delegate/Bodhi pipeline. The flow, with each stage mapped to what exists:

1. **Receive objective** — free text, exactly like Delegate's goal entry (`DelegateTaskInput.tsx`).
2. **Classify** — `CapabilityRegistry.select(goal)` (exists; delegates to `SkillRegistry.resolve` so routing lives in one place).
3. **Determine required capabilities** — the selected capability's playbook + tool allowlist; the operator playbook (`bodhi/operator.ts` `buildOperatorSkill`) folds a matched capability under the operator rules (exists).
4. **Select model/agent per execution profile** — router (`model_profiles` + `router_overrides`) and per-capability `pinned_model` (exists); execution profiles extend this with cost/quality intent.
5. **Choose local / BYOK / BYOC / cloud / hybrid** — the router's candidate set, filtered by Tags (`Local Only` etc.) and the Task's `limits_json`.
6. **Decompose into sub-tasks** — `runParallel` / `runChildCapability` in `agent/orchestrator.ts` (exists: child Tasks with `parent_run_id`, intersected tool scope, depth cap).
7. **Dependencies** — workflow graph edges when the objective matched a Workflow; otherwise the planner's ordering.
8. **Permissions & budgets** — `tool_policies` tiers per call (exists) + Approval rows for confirm-tier actions + `limits_json` enforced by the loop.
9. **Collect & validate** — output schemas where declared; the verify-before-claiming-done rule already in the operator playbook.
10. **Present outcome + full history** — the Task's `outcome_json` + `getTaskSteps` + `tool_receipts` (the verifiable audit trail).

**Hard rule — no uncontrolled autonomous loops.** Every Task carries explicit limits: **time, cost, tool calls, retries, external actions**. Stored in `agent_runs.limits_json`, defaulted from tier entitlements (`license/entitlements.ts`), enforced inside the ReAct loop (which already has an iteration cap and a child-depth cap). A Task that hits a limit parks with status + an Approval request to continue; it never silently keeps going.

---

## 4. Table Evolution Strategy

The established pattern is `runMigrations()` in `db/schema.ts`: `PRAGMA table_info` guard → `ALTER TABLE … ADD COLUMN` with a constant default → swallow errors so a bad block can't prevent boot. **All changes below follow it. Existing rows must keep working with defaults; no destructive migration, no rewrite of existing tables.**

**Existing tables that gain columns** (all nullable or constant-default):

| Table | New columns | For |
|---|---|---|
| `agent_runs` | `trigger_kind` (default 'chat'), `trigger_id`, `limits_json`, `outcome_json`, `project_id` | Task provenance, budgets, results |
| `scheduled_tasks` | `missed_policy` (default 'skip'), `retry_json`, `limits_json`, `approval_required` (default 0), `requires_json`, `capability_id`, `workflow_id`, `project_id`, `timezone` | Schedule maturity (§2.3) |
| `workflow_templates` | `current_version` (default 1), `project_id` | Versioning pointer |
| `artifacts` | `run_id`, `project_id`, `doc_id`, `version_of`, `source_json` | Artifact target shape |
| `skills` | `input_schema_json`, `output_schema_json`, `risk_tier` | Capability schemas |

**New tables** (CREATE TABLE IF NOT EXISTS, same idempotent style):

```sql
tags            (tag_id PK, name UNIQUE, semantic TEXT,        -- NULL = plain label; else
                                                               -- 'local_only'|'cloud_allowed'|'confidential'
                                                               -- |'requires_approval'|'do_not_retain'
                 color, created_at)

tag_assignments (assignment_id PK, tag_id REFERENCES tags,
                 object_type TEXT,   -- 'session'|'task'|'memory'|'artifact'|'workflow'
                                     -- |'schedule'|'routine'|'project'|'contact'|'scope'|'web_cache'
                 object_id TEXT, created_at,
                 UNIQUE(tag_id, object_type, object_id))

approvals       (approval_id PK, run_id, object_type, object_id,
                 risk_tier, requested_action, requested_by,    -- 'local' | member_id (mirrors tool_audit_log.actor)
                 decision TEXT CHECK IN ('pending','approved','denied','expired'),
                 decided_by, decided_at, expires_at, created_at)

routines        (routine_id PK, name, schedule_id REFERENCES scheduled_tasks,
                 workflow_id REFERENCES workflow_templates,
                 approval_policy_json, expected_outputs_json,
                 project_id, is_enabled DEFAULT 1, created_at)

workflow_versions (version_id PK, template_id REFERENCES workflow_templates,
                 version INTEGER, graph_json, input_schema_json, output_schema_json,
                 created_at, UNIQUE(template_id, version))     -- immutable rows

usage_ledger    (entry_id PK, run_id REFERENCES agent_runs, model, provider,
                 tokens_in, tokens_out, wall_ms, est_cost_cents,
                 project_id, created_at)
```

**Backward compatibility contract**: a v-current database opened by this code gains columns with defaults that reproduce today's behaviour exactly (`trigger_kind='chat'`, `missed_policy='skip'`, `approval_required=0`). Nothing reads a new table it didn't create. Feature code must treat NULL/absent as "legacy row, old behaviour".

---

## 5. Object Relationships

```
                          ┌────────────┐
                          │  Project   │  projects (+ settings_json policy)
                          └─────┬──────┘
          project_id on: sessions, memories, kg/crm, and (new)
              tasks, schedules, workflows, artifacts, routines
                                │
   ┌──────────┐  fires   ┌──────▼─────┐   versions   ┌──────────────────┐
   │ Schedule ├─────────►│    TASK    │◄─────────────┤     Workflow     │
   │scheduled_│ trigger_ │ agent_runs │  (node runs) │workflow_templates│
   │  tasks   │  id/kind │agent_steps │              │workflow_versions │
   └────▲─────┘          └┬─┬──┬──┬──┬┘              └────────▲─────────┘
        │                 │ │  │  │  │ parent_run_id /        │
   ┌────┴─────┐           │ │  │  │  │ forked_from_step       │
   │ Routine  ├───────────┼─┼──┼──┼──┼── (bundles both) ──────┘
   │ routines │           │ │  │  │  └──► child / forked TASKs
   └──────────┘           │ │  │  │
              invokes ◄───┘ │  │  └────► usage_ledger (1 row / task)
   ┌────────────┐           │  │
   │ Capability │           │  └───────► tool_receipts, skill_runs (trace)
   │ skills +   │           │
   │ Registry   │     ┌─────▼────┐  parks/resumes  ┌──────────┐
   └────────────┘     │ Approval │◄────────────────┤ Artifact │ run_id
                      │approvals │                 │artifacts,│ version_of
                      └──────────┘                 │generated_│ provenance
                                                   │documents │
                                                   └──────────┘
        Tag (tags + tag_assignments) ──── attaches to ANY of the above
        (policy semantics enforced at context assembly + model selection)
```

Task is the hub: everything else either **creates** Tasks (Schedule, Routine, Workflow, Dispatch, Chat), **is invoked by** Tasks (Capability), **gates** Tasks (Approval, Tag), or **is produced by** Tasks (Artifact, usage_ledger, receipts).

---

## 6. What NOT To Build Yet

Deliberately deferred — but their **seams are reserved by this document**, so building them later is additive:

1. **Visual workflow editor.** Not until `workflow_versions.graph_json` has stabilised through real hand-authored/AI-authored workflows. The seam: the graph schema and node kinds in §2.5 are the editor's file format; the editor is a view, it defines nothing.
2. **Workflow marketplace.** The seam: import/export via the existing signed-bundle pattern (`bundles/bundle.ts`) applied to workflow versions. Distribution/marketplace UI comes later; the artifact format is decided now.
3. **Cloud scheduler backend.** The seam: the Schedule interface in §2.3 (`fire(schedule) → Task`, same `scheduled_tasks` semantics). A managed scheduler is just a second trigger source honouring `missed_policy`/`requires_json`; nothing in the renderer or the Task model changes.
4. **A separate "agents" table or Dispatch service.** Explicitly rejected. Agents are `skills.kind='agent'` implementing `CapabilityExecutor`; Dispatch is the orchestrator + this object model. Any proposal introducing a parallel run/job/queue table must be reconciled against §1 first.

---

## 7. Decision Summary

| Decision | Rationale |
|---|---|
| Task = `agent_runs`, never a new table | Durability, resume, fork, lineage already work; features project onto it |
| Capabilities stay skill-backed via one registry | `CapabilityRegistry` wraps `SkillRegistry` — one source of truth, no drift |
| Schedules/Routines/Workflows only *create* Tasks | One executor (`OrchestratorCapabilityExecutor` → `AgentOrchestrator`), one trace |
| Tags are polymorphic rows with enforced semantics | One enforcement point (context assembly + routing), not per-feature checks |
| Approvals are durable rows, not IPC round-trips | Resumable across restarts; grantable by teammates (Cowork) |
| All migrations additive, defaults = old behaviour | Matches `runMigrations()` pattern; existing installs keep working |
| Every Task carries explicit limits | No uncontrolled autonomous loops, per §3 |

---

## Appendix: Where the Model Lives Today

| Object | Code | Tables |
|---|---|---|
| Task | `packages/app/src/bodhi/tasks.ts` | `agent_runs`, `agent_steps` |
| Capability | `packages/app/src/bodhi/capabilities.ts`, `skills/registry.ts` | `skills`, `skill_runs` |
| Executor | `packages/app/src/bodhi/executor.ts`, `agent/orchestrator.ts` (`runCapability`, `runParallel`, `runChildCapability`) | — |
| Operator (Dispatch seed) | `packages/app/src/bodhi/operator.ts` | — |
| Schedule | `packages/app/src/scheduler/scheduler.ts` | `scheduled_tasks` |
| Workflow | (primitive) | `workflow_templates` |
| Artifact | `packages/app/src/docs/generator.ts`, `tools/docs.ts` | `artifacts`, `generated_documents`, `provenance_records` |
| Workspace/Project | `packages/app/src/db/scopes.ts`, `agent/contextPacks.ts` | `projects`, `session_scopes`, `context_packs` |
| Policy / audit | `packages/app/src/db/schema.ts` (tool policies), receipts | `tool_policies`, `tool_receipts`, `tool_audit_log` |
| Tag, Routine, Approval, Run ledger | — (this document reserves them) | `tags`, `tag_assignments`, `routines`, `approvals`, `workflow_versions`, `usage_ledger` (new) |
