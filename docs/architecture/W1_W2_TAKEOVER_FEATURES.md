# W1/W2 takeover features — short notes

One paragraph per feature, naming the key modules (paths under `packages/app/src` or `packages/renderer/src`) and SQLite tables. See `SITEMAP.md` for per-file detail.

## Run event log

Every meaningful point in an agent run is appended to `run_events` with a per-run `seq`: status, plan, step, tool call and result, interaction, heartbeat (every 10 s) and terminal. Before this, the renderer only had fire-and-forget IPC events, so a reload lost whatever happened while it was away. `agent/runEvents.ts` writes the log. `agent/runEventIpc.ts` handles `run:subscribe` / `run:unsubscribe` and replays from a given `seq`. `agent/runEventRetention.ts` keeps the last 30 days or the last 200 runs, whichever keeps more. `agent/runTimeline.ts` pulls a run's events plus the workflow-level plan-review events for the Run Inspector. In the renderer, `lib/runResume.ts` stores the last-seen `seq` in localStorage so a reloaded view gets only the events it missed, and `lib/runTimeline.ts` turns events into readable rows.

## Permission modes and grants

Each chat has a permission mode (`chat_sessions.permission_mode`). When none is set, the mode comes from the `autonomousActions` setting. The modes are ask, accept edits, plan, auto and unattended, and `agent/modes.ts` holds the mode × tool decision matrix. Scheduled and LAN runs are always unattended, and unattended runs block confirm-tier tools. Users pick a mode with `components/Chat/PermissionModeSelector.tsx` and `components/Delegate/DelegateModeSelector.tsx`. Answering an approval with "Always allow (30 days)" creates a standing grant in `grants` (`bodhi/grants.ts`) that binds a scope (what is allowed) to a subject (where). `components/Settings/GrantsPanel.tsx` lists grants and revokes them immediately. Expired and revoked grants stay listed as an audit trail.

## Goals and evaluator

A goal is a durable statement of what "done" means for a chat session. Goals live in `goals` (`bodhi/goals.ts`), survive restarts, and are re-checked at the stop gate of every ReAct loop in that session. When the model says it is finished, `bodhi/goalEvaluator.ts` treats that as a claim. It checks deterministic acceptance criteria first, then asks an independent judge, and an unparseable verdict never counts as met. Only the evaluator can complete a goal, not the model and not the UI. `components/Delegate/GoalChip.tsx` (with `lib/goalChip.ts`) shows the objective, status and elapsed time with Pause / Resume / Stop, and a blocked goal reads "Needs you".

## Durable undo and checkpoints

Undo entries are stored in `undo_entries`, so Undo survives a restart (`agent/undo.ts`, covered by `undo.persist.test.ts`). Before a filesystem tool overwrites, moves, deletes or trashes a file, `agent/checkpoints.ts` copies the file's bytes into a content-addressed store (`<userData>/checkpoints/<sha256>`) and records a `checkpoint_files` row. `rewindRunToStep` puts every touched path back as it was before a chosen step. A run left running by a quit or crash is marked `interrupted`, never completed. `agent/resume.ts` and `components/ResumeInterruptedRuns.tsx` offer those runs with Resume / Dismiss, and nothing resumes automatically. `db/sqlLike.ts` is a shared SQL handle that lets these modules run on better-sqlite3 in the app and on `node:sqlite` in tests.

## Global stop and app grants

`desktop/killSwitch.ts` registers a system-wide hotkey only while a run is active. Pressing it stops every run, because each ReAct loop registers a cancel callback in `desktop/runtime.ts`. `desktop/actionQueue.ts` runs nut-js actions one at a time, so a stop rejects queued actions and halts the one in progress, including long typing. Turning on desktop control does not let Artha drive every app. Before acting, `desktop/desktopGate.ts` resolves the target app and checks `app_grants` (`desktop/appGrants.ts`). If there is no grant, it asks: Once, Always for this project (30 days), or Deny. Unattended runs skip the action instead of asking. Related: `system/keepAwake.ts` and `components/Settings/KeepAwakeSettings.tsx` can optionally keep the machine awake while a run is active.

## ask_user and interactions

`agent/interactions.ts` handles every pause for a person: an `ask_user` question, a plan approval, a browser handoff, or a policy confirm. Each one opens a single `Interaction` frame, persisted in `interactions` (DDL in `db/interactionsTable.ts`), so a pending question survives a renderer reload. `agent/askUser.ts` lets the model ask 1–4 multiple-choice questions mid-run. The answers resolve the same tool call, so no new turn starts. `agent/planReview.ts` adds Accept, Accept with comments (one planner revision) and Reject (ends the run as cancelled-by-user). `agent/interactionRunEvents.ts` mirrors ask and plan interactions into the run event log. Renderer side: `components/Chat/AskUserCard.tsx`, `lib/askCard.ts` and `stores/interactions.ts`.

**Every pause waits until it is answered.** Question cards and plan reviews always did; tool approval prompts used to expire after 2 minutes (counted as a decline) and now wait too. What that relies on:
- **Unattended runs are never asked.** `requestToolApproval` refuses up front when the run is scheduled or from the LAN, so nothing can park a run nobody is watching.
- **Stop releases a waiting prompt,** including one raised by a sub-capability loop (`workflowParents` links a child workflow to its caller). Quitting the app also ends it; the run then shows as interrupted with a resume offer.
- **A waiting run costs nothing.** It does not hold the keep-awake blocker (`system/keepAwake.ts`, `runWaiting`), and the run monitor writes one heartbeat every 5 minutes instead of every 10 seconds.
- **A prompt cannot leave the screen unanswered.** The main process lists everything still waiting (`InteractionHub.listPending`, including a prompt whose row could not be written). The renderer keeps the shown prompt until that list says it is settled and then shows the next one (`lib/pendingPrompts.ts`).
- **The user is told once.** If a prompt is still open after 30 seconds and Artha is not the focused app, one notification says a task is waiting (`APPROVAL_NUDGE_MS`).

## Outbox

While a run is active, the composer's Send becomes Queue, and messages go to `outbox` (`agent/outbox.ts`, DDL in `db/outboxSchema.ts`) instead of starting a competing run. `agent/outboxDriver.ts` decides when to send. It drains the next item after the run ends and injects "steer now" items at the next tool-call boundary. It never sends past a pending approval, ask card or plan review. After a cancel the queue pauses (`chat_sessions.outbox_paused`, `outbox_paused_reason`). Delegate uses the same queue. Renderer side: `components/Chat/OutboxPanel.tsx`, `lib/outboxQueue.ts` and `lib/delegateParity.ts`.

## Automations v2

`scheduler/engine.ts` (`AutomationEngine.fire()`) is the single fire path for every unattended run: cron and one-shot fires, missed-run catch-up, folder triggers (`scheduler/folderTrigger.ts`), local webhooks and Run now. It guarantees no overlap and checks hold states before a run starts. Results are recorded in `task_executions`. `scheduler/scheduledRunner.ts` runs tasks on the shared app orchestrator, so the kill switch, cancel and outbox all reach scheduled runs. `scheduler/automationPolicy.ts` holds the pure safety rules, such as the 15-minute schedule floor and ±90 s jitter. `scheduler/taskFile.ts` exports and imports tasks as Markdown with frontmatter. `components/Workflows/SchedulerInbox.tsx` shows run history exactly as recorded, and never upgrades an unverified or held run to a success.
