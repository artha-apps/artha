# W1 + W2 live test matrix

A manual checklist for the W1/W2 work (#80 integration, #84 follow-ups). Run it
in the **real Electron app**. The unit suites cover the logic below the UI,
but #84 says that nothing in these slices has been checked by hand in the app.
This matrix fills that gap.

## Set up a disposable QA profile

Never run this matrix on your real profile. Some cases send email, delete
files or let the agent control the desktop.

```sh
export ARTHA_USER_DATA_DIR="$HOME/artha-qa/w1-$(date +%Y%m%d-%H%M)"   # absolute path, NOT your live profile
export ARTHA_QA_MODE=1                                                 # required for a packaged build
mkdir -p "$ARTHA_USER_DATA_DIR"
# then launch the packaged app (or `npm run dev`) from this same shell
```

- At startup the log must show that an isolated QA profile is active, and it
  must show the directory **basename** only. If it doesn't, stop.
- If the override is invalid in QA mode (relative path, empty, or the live
  profile), the app must **refuse to start**. Check this once (case 0.2).
- Use a throwaway mailbox for the `email_send` cases, and a scratch folder
  such as `~/artha-qa/scratch` for the file and folder-trigger cases.
- DB evidence: `sqlite3 "$ARTHA_USER_DATA_DIR/artha.db" "<query>"`. Quit the
  app first, or open the DB read-only (`-readonly`).

**Evidence types:** 📸 screenshot · 🗄 DB row (paste the query and its output) ·
📜 log line (paste the line) · 🎥 short screen recording, used only where the
case depends on timing.

**Recording results:** for each case, record the app version, OS, ✅/❌, and
a link to the evidence in the PR conversation. Save the files under
`docs/testing/evidence/w1-w2/<case-id>.*`.

---

## 0. Profile isolation (run first)

| # | Steps | Expected | Evidence |
|---|---|---|---|
| 0.1 | Launch with the env above | The app starts on an empty profile with onboarding showing. The live profile's sessions are not visible. | 📜 QA-profile log line (basename only) · 📸 onboarding |
| 0.2 | Relaunch with `ARTHA_USER_DATA_DIR=relative/path ARTHA_QA_MODE=1` | The app refuses to start and never falls back to the live profile | 📜 fatal "refusing to run" line |

## 1. Run timeline (Run Inspector → Timeline)

| # | Steps | Expected | Evidence |
|---|---|---|---|
| 1.1 | Start a multi-step run (e.g. "list the files in scratch, then summarise each"). Open the Run Inspector → Timeline. | Rows are paired: each tool call with its result, and each approval with its response. Heartbeats and step events are not shown. The end row says "Run ended (outcome)" and never says verified success unless verification passed. | 📸 timeline |
| 1.2 | During a run from 1.1, reload the renderer (View → Reload / Cmd/Ctrl+R) | The view reattaches to the **same** run, with events from before the reload plus new live events. There are no duplicate rows and no second run is started. | 🎥 reload → reattach · 🗄 `select count(*) from agent_runs where session_id=…` stays the same |
| 1.3 | Force a stall: use a slow local model, or block network to the provider partway through a run, for more than 60 s | A "run status unchanged" stall row appears on the timeline. The run is not marked successful. | 📸 stall row · 🗄 `select type,payload from run_events where run_id=… order by id desc limit 5` |
| 1.4 | Hold an approval prompt open for more than 60 s, then answer it | **No** stall row appears while the prompt is open, because an interaction pauses the watchdog. The request and response appear as one paired row. | 📸 timeline |
| 1.5 | Open a scheduled run from the scheduler inbox → **Open run** | It opens the same inspector. Linked plan-review events are marked "before run". | 📸 |

## 2. Permission modes and grants

Modes: `ask` · `accept_edits` · `plan` · `auto` (`unattended` is covered in §8).

| # | Steps | Expected | Evidence |
|---|---|---|---|
| 2.1 | Mode **ask**. Ask the agent to write a file in scratch. | A confirm prompt appears before the write. Deny → the file is not written and the run continues honestly. | 📸 prompt · `ls` of scratch |
| 2.2 | Mode **accept_edits**. Same request, then a request that sends an email. | The file edit goes through without a prompt. The email still prompts. | 📸 · 🗄 `select type,payload from run_events where type='interaction'` |
| 2.3 | Mode **plan** | The agent proposes a plan and runs no mutating tools until the plan is approved | 📸 plan card |
| 2.4 | Mode **auto** | Safe-tier and edit tools run without prompting. Confirm-floor tools still prompt (see 2.7). | 📸 |
| 2.5 | Mode ask. On a write prompt, click **Always allow (30 days)**, then repeat the write. | The second write doesn't prompt. Settings → Grants lists the grant with an expiry about 30 days out. | 📸 Grants list · 🗄 grant row with `expires_at` |
| 2.6 | Revoke the grant in Settings → Grants, then repeat the write. Separately, set a grant's `expires_at` to the past in a copy of the DB and relaunch. | It prompts again in both cases. A revoked or expired grant is ignored. | 📸 · 🗄 revoked/expired row |
| 2.7 | In **every** mode, ask the agent to send an email to the throwaway mailbox | `email_send` **always** prompts and **never** offers "Always allow" | 📸 prompt with no Always button, once per mode |
| 2.8 | Change the mode, then reload the app | The session keeps its mode (`session:getMode`) | 📸 mode selector |

## 3. Goals

| # | Steps | Expected | Evidence |
|---|---|---|---|
| 3.1 | Set a goal with checkable criteria (e.g. "create `scratch/report.md` containing a heading and 3 bullets"). Make the agent try to finish early: use a weak model, or say "just say done". | The goal stop gate **blocks** the false "done". The goal chip is not completed. The timeline shows a `goal_gate` row listing the gaps. | 📸 chip + timeline · 🗄 `select status from goals where session_id=…` |
| 3.2 | Use criteria that the evidence can only partly satisfy | The goal goes to **needs-review**, the gaps are listed, and the status is not completed | 📸 · 🗄 goal row |
| 3.3 | Press chat **Stop** during a goal run. Repeat using the global stop shortcut. Repeat while the judge is evaluating (the stop lands mid-evaluation). | The goal is **never** set to completed. The run is recorded as `cancelled` / `stopped_by_user`, and the goal stays open. | 🗄 goal + `agent_runs` rows · 📸 timeline kill-switch row |
| 3.4 | Make `goal_set` request approval | The approval is recorded as an `interaction` run event and appears on the timeline | 📸 |

## 4. Durable undo and checkpoints

| # | Steps | Expected | Evidence |
|---|---|---|---|
| 4.1 | Have the agent overwrite `scratch/a.txt` (with known content) and delete `scratch/b.txt`. Quit Artha completely and relaunch. Use **Rewind** to go back to the checkpoint before those steps. | Both files are restored byte-for-byte after the restart. `diff` against your saved copies is empty. | 📸 rewind UI · `diff` output · 🗄 checkpoint rows for those step_ids |
| 4.2 | Enable keep-awake in settings, start a long run, and check the OS power assertions (`pmset -g assertions` on macOS / `powercfg /requests` on Windows) | An assertion is held during the run and released when the run ends, errors or is stopped | 📜 assertion output during and after |
| 4.3 | Start a run that sends an email (approve it) and then does more steps. Kill the app (force quit) after the send and before the run ends. Relaunch and accept the **resume** offer. | The run resumes after the send. The email is **not** sent again: the throwaway inbox has exactly one message and no second confirm is triggered for that send. | 📸 inbox showing 1 message · 📸 resume offer · 🗄 steps for the run |
| 4.4 | Decline the resume offer | The run is recorded as cancelled and nothing replays | 🗄 run row |

## 5. Global stop shortcut and desktop control

| # | Steps | Expected | Evidence |
|---|---|---|---|
| 5.1 | Check that the stop shortcut is set in Settings. Start a desktop-control task (e.g. open the calculator app and type into it). Press the shortcut from another app while the agent is acting. | Desktop control stops: an action already under way may finish (typing stops within 16 characters), and no further input events occur after that. The timeline shows a `status` row `{source: 'kill_switch', reason: 'stopped_by_user'}`. | 🎥 · 📸 timeline |
| 5.2 | First desktop action on a new app | A per-app prompt appears with **Once / Always for this project / Deny**. Enter = Once. | 📸 |
| 5.3 | Choose "Always for this project", then repeat | It doesn't prompt again. The grant appears in Settings → Grants as `desktop-control:<app>` and can be revoked there. After revoking, it prompts again. | 📸 Grants · 🗄 grant row value |
| 5.4 | Target an app on the deny-list (e.g. a password manager, terminal or system settings) after granting "Always" to other apps | It **always** asks and no standing grant is ever applied | 📸 prompt each time |
| 5.5 | Grant "Always" to a desktop app, then check the tool-policy grants | The app grant does **not** create a generic tool grant | 🗄 grants rows |

## 6. ask_user cards and plan review

| # | Steps | Expected | Evidence |
|---|---|---|---|
| 6.1 | Prompt something that makes the agent call `ask_user`. Reload the renderer before answering. | The card is still there after the reload. Answering it continues the same run. | 🎥 · 📸 |
| 6.2 | Plan review (chat): add comments to two steps → **Approve with 2 comments** | The plan is revised to address the comments before it runs. The timeline shows the plan request and response. | 📸 before/after plan |
| 6.3 | Delegate plan view: comment on a step → Approve with comments | The run starts with the comments carried as review notes. Known limit: there is no planner revision in Delegate. | 📸 |
| 6.4 | **Reject** or Cancel a plan (chat and Delegate) | No task runs. The run or goal is **not** shown as completed. | 📸 · 🗄 run row status |

## 7. Outbox (queued follow-ups), in chat and in Delegate

| # | Steps | Expected | Evidence |
|---|---|---|---|
| 7.1 | During a run, queue 3 messages (A, B, C), then reorder them to C, A, B | They drain one at a time in the order C, A, B, each after the previous turn finishes | 📸 OutboxPanel · 📸 transcript order |
| 7.2 | Pause the queue during a run | Nothing drains after the run ends until you resume | 📸 |
| 7.3 | **Steer now** on a queued item | It is delivered into the current run right away instead of waiting | 📸 |
| 7.4 | Queue an item while an approval, ask card or plan review is pending | It does **not** drain past the pending question. It drains only after the question is answered. | 🎥 |
| 7.5 | Queue items, then press Stop, and separately the global stop shortcut | The queue is **paused** after the stop and nothing auto-sends. (Known: the kill switch with an empty queue doesn't pause.) | 📸 paused state |
| 7.6 | In Delegate during a run, use the **Queue** box | The same behaviour as above. The drained item starts a Delegate continuation and the view follows the new run. | 📸 |

## 8. Automations v2 (scheduler)

| # | Steps | Expected | Evidence |
|---|---|---|---|
| 8.1 | Create an hourly automation. Put the machine to sleep (or quit Artha) across at least one fire time, then wake/relaunch. | One catch-up run fires, not one per missed slot | 🗄 runs for the task · 📜 catch-up line |
| 8.2 | Make an automation fail on purpose (e.g. read a missing file) 3 times in a row | After the 3rd consecutive failure it is **auto-paused** and the inbox says so | 📸 · 🗄 task enabled flag + failure count |
| 8.3 | Set notify = `on_change`. Run twice with identical output, then once with changed output. | Only the changed run notifies | 📸 notifications |
| 8.4 | Folder trigger on `scratch/inbox`: drop a file in | A run fires for that file, and only once | 🗄 run row · 📜 |
| 8.5 | Webhook trigger: POST without a token, with a wrong token, and with the correct token. Also try with the webhook disabled. | No token, a wrong token or a disabled webhook → **403** and no run. The correct token → a run fires. | 📜 curl status codes · 🗄 runs |
| 8.6 | Automation whose task needs a confirm-tier tool (write a file, send an email) | The unattended run **blocks** the tool. There is no prompt and no silent execution. The run reports the block honestly. | 📸 inbox · 🗄 run_events showing the block |

## 9. Shared orchestrator

| # | Steps | Expected | Evidence |
|---|---|---|---|
| 9.1 | Start a long scheduled run (Run now, or cron), then press the global stop shortcut | The scheduled run is cancelled and marked `stopped_by_user`, and the inbox shows it | 📸 inbox · 🗄 run row |
| 9.2 | Have a chat run active while a scheduled run fires | Both complete. The chat run is still attended (it prompts normally) and the scheduled run is still unattended (it blocks). Neither context leaks into the other. | 📸 both |

## 10. Upgrade from v0.4.27

| # | Steps | Expected | Evidence |
|---|---|---|---|
| 10.1 | Copy a **v0.4.27** `artha.db` (a copy, never the original) into a fresh QA profile dir. Launch this build. | The migrations run with no errors and existing sessions, tasks and models are intact. New tables exist: `run_events`, `goals`, grants, checkpoints. | 📜 migration lines · 🗄 `.tables` + `pragma integrity_check` |
| 10.2 | Quit and relaunch on the same DB | The migrations run cleanly a **second** time: no errors, no duplicate columns, nothing re-applied destructively | 📜 second launch log · 🗄 `pragma integrity_check` = ok |
| 10.3 | After the upgrade, check the run event retention prune | One summary prune line is logged at launch, even when nothing is removed | 📜 prune line |

---

**Sign-off:** all ✅ in §0–§10, or each ❌ linked to an issue, before the W1/W2
integration branch is proposed for `main`.
