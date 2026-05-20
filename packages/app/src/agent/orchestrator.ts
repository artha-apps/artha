/**
 * Agent Orchestrator — ReAct (Reason + Act) loop.
 *
 * Inspired by OpenHands' CodeAct pattern.
 * Takes a user message, builds a plan (planning mode), then executes
 * each step by calling LLM + MCP tools, observing outputs, and
 * self-correcting on failure.
 *
 * Anti-hallucination: every mutation (move/copy/delete/mkdir) is tracked in
 * a ToolCallTracker. After the loop the final response is generated from
 * VERIFIED GROUND TRUTH — the model cannot claim anything that didn't happen.
 *
 * Time-travel: every step is snapshotted to agent_steps with an optional
 * full-messages snapshot at assistant/system steps, so forkFromStep() can
 * resume the loop from any past point.
 */
import { BrowserWindow } from 'electron';
import * as os from 'os';
import { getActiveLLMClient, type StreamedMessage } from '../llm/client';
import { MCPRegistry } from '../mcp/registry';
import { SkillRegistry, type ActiveSkill } from '../skills/registry';
import { getDb } from '../db/schema';
import OpenAI from 'openai';
import {
  startCitationCollection,
  drainCitations,
  setActiveCitationToken,
} from '../tools/web';

const MAX_RETRIES = 3; // kept for future retry logic
void MAX_RETRIES;

/** One row in the agent's plan as shown to the user in Planning Mode. */
export interface WorkflowStep {
  index: number;
  description: string;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  status: 'pending' | 'running' | 'done' | 'failed';
  output?: string;
  error?: string;
}

/** A planning-mode plan handed to the renderer for explicit approval. When
 *  `requiresApproval=true` the orchestrator pauses until `approvePlan()` is
 *  called via IPC. */
export interface AgentPlan {
  workflowId: string;
  sessionId: string;
  goal: string;
  steps: WorkflowStep[];
  requiresApproval: boolean;
  /** Skill active for this run, if one was matched/invoked. Threaded through
   *  approval so its instructions + tool scope survive a pause-for-approval. */
  skill?: ActiveSkill | null;
}

// ── Anti-hallucination tracker ───────────────────────────────────────────────

/** Every file-system mutation that actually executed (success or fail). */
interface TrackedMutation {
  tool: string;
  args: Record<string, unknown>;
  result: string;
  success: boolean;
}

/** Tools that change filesystem state — only these are tracked for verification. */
const MUTATION_TOOLS = new Set([
  'fs_move_file',
  'fs_copy_file',
  'fs_delete_file',
  'fs_create_directory',
  'fs_write_file',
  'fs_rename_file',
]);

// ── Orchestrator ─────────────────────────────────────────────────────────────

/** Owns one ReAct loop per active conversation. State worth re-reading on
 *  resume (plans + cancel flags) lives in instance Maps; everything else
 *  (runs, steps, tool audit) is persisted to SQLite so a crash mid-loop
 *  doesn't lose the trace. */
export class AgentOrchestrator {
  private window: BrowserWindow;
  private registry: MCPRegistry;
  private skills: SkillRegistry;
  /** Plans awaiting user approval, keyed by workflowId. */
  private activePlans = new Map<string, AgentPlan>();
  /** Set of workflow IDs the user has hit Stop on; consulted each loop tick. */
  private cancelledWorkflows = new Set<string>();

  constructor(window: BrowserWindow) {
    this.window = window;
    this.registry = MCPRegistry.getInstance();
    this.skills = SkillRegistry.getInstance();
  }

  /** Entry point: receive a user message and start the ReAct loop. */
  async handleMessage(sessionId: string, userContent: string): Promise<void> {
    const db = getDb();
    const workflowId = crypto.randomUUID();

    // Resolve a skill (explicit "/slug" or auto-match). `goal` has any leading
    // "/slug" stripped, so the rest of the loop never sees the invocation prefix.
    const { skill, goal } = await this.skills.resolve(userContent);
    if (skill) {
      this.emit('agent:skillActive', { slug: skill.slug, name: skill.name, icon: skill.icon });
    }

    db.prepare(`
      INSERT INTO agent_states (workflow_id, session_id, status, context_json)
      VALUES (?, ?, 'pending', ?)
    `).run(workflowId, sessionId, JSON.stringify({ goal, skill: skill?.slug ?? null }));

    const history = this.getSessionHistory(sessionId);

    const plan = await this.generatePlan(workflowId, sessionId, goal, history, skill);
    plan.skill = skill;
    this.activePlans.set(workflowId, plan);

    if (plan.requiresApproval) {
      db.prepare(`UPDATE agent_states SET status='awaiting_approval', plan_json=? WHERE workflow_id=?`)
        .run(JSON.stringify(plan.steps), workflowId);
      this.emit('agent:planReady', plan);
      return;
    }

    await this.executePlan(plan);
  }

  // ── Time-travel: fork a prior run from a specific step ───────────────────
  async forkFromStep(stepId: string, overrides?: { modelOverride?: string }): Promise<string | null> {
    const db = getDb();
    const step = db.prepare(`
      SELECT s.run_id, s.idx, s.messages_snapshot, r.session_id, r.goal
      FROM agent_steps s JOIN agent_runs r ON r.run_id = s.run_id
      WHERE s.step_id = ?
    `).get(stepId) as { run_id: string; idx: number; messages_snapshot: string | null; session_id: string; goal: string } | undefined;
    if (!step?.messages_snapshot) return null;

    const snapshot = JSON.parse(step.messages_snapshot) as OpenAI.ChatCompletionMessageParam[];
    const newWorkflowId = crypto.randomUUID();
    const newRunId = crypto.randomUUID();

    db.prepare(`
      INSERT INTO agent_runs (run_id, session_id, workflow_id, parent_run_id, forked_from_step, goal, status)
      VALUES (?, ?, ?, ?, ?, ?, 'running')
    `).run(newRunId, step.session_id, newWorkflowId, step.run_id, stepId, step.goal);

    db.prepare(`
      INSERT INTO agent_states (workflow_id, session_id, status, context_json)
      VALUES (?, ?, 'running', ?)
    `).run(newWorkflowId, step.session_id, JSON.stringify({ goal: step.goal, forkedFrom: stepId }));

    this.emit('agent:workflowStart', newWorkflowId);
    // Fire-and-forget: run loop async so caller gets the runId back immediately
    void this.runReactLoop({
      workflowId: newWorkflowId,
      runId: newRunId,
      sessionId: step.session_id,
      goal: step.goal,
      messages: snapshot,
      modelOverride: overrides?.modelOverride,
    }).catch(err => console.error('[Artha] fork run failed:', err));

    return newRunId;
  }

  /** Called when user approves or rejects a plan in Planning Mode. */
  async approvePlan(workflowId: string, approved: boolean): Promise<void> {
    const plan = this.activePlans.get(workflowId);
    if (!plan) return;
    if (!approved) {
      this.activePlans.delete(workflowId);
      this.emit('agent:token', '\n\n_Plan cancelled by user._');
      this.emit('agent:streamEnd');
      return;
    }
    await this.executePlan(plan);
  }

  /** Called when user hits the Stop button in the UI. */
  cancelWorkflow(workflowId: string): void {
    this.cancelledWorkflows.add(workflowId);
  }

  // ── Private ───────────────────────────────────────────────────────────────

  private async generatePlan(
    workflowId: string,
    sessionId: string,
    goal: string,
    history: OpenAI.ChatCompletionMessageParam[],
    skill?: ActiveSkill | null
  ): Promise<AgentPlan> {
    const llm = getActiveLLMClient(undefined, 'plan');
    const tools = this.skills.filterTools(this.registry.getToolSchemas(), skill ?? null);

    const skillBlock = skill
      ? `\nActive skill — "${skill.name}". Follow its playbook when planning:\n${skill.instructions}\n`
      : '';

    const planningPrompt: OpenAI.ChatCompletionMessageParam = {
      role: 'system',
      content: `You are Artha, a local-first AI productivity agent running on the user's Mac.

Available tools: ${tools.map(t => t.function.name).join(', ')}
${skillBlock}
Decompose the user's request into a clear, minimal step-by-step plan.

Respond ONLY with a valid JSON object (no markdown, no explanation):
{
  "steps": [
    { "index": 0, "description": "List files in ~/Desktop to see what screenshots exist", "toolName": "fs_list_directory" },
    { "index": 1, "description": "Create a Screenshots folder", "toolName": "fs_create_directory" },
    { "index": 2, "description": "Move each screenshot into the folder", "toolName": "fs_move_file" }
  ],
  "requiresApproval": true
}

Rules:
- Set requiresApproval=true whenever steps move, delete, or modify files
- Always start with fs_list_directory or fs_search_files before moving anything
- Keep steps minimal and concrete`,
    };

    const response = await llm.complete([planningPrompt, ...history, { role: 'user', content: goal }]);
    const raw = response.choices[0]?.message?.content ?? '{}';

    let parsed: { steps: WorkflowStep[]; requiresApproval: boolean };
    try {
      parsed = JSON.parse(raw.replace(/```json\n?|\n?```/g, ''));
    } catch {
      parsed = {
        steps: [{ index: 0, description: goal, status: 'pending' }],
        requiresApproval: false,
      };
    }

    return {
      workflowId,
      sessionId,
      goal,
      steps: parsed.steps.map((s, i) => ({ ...s, index: i, status: 'pending' as const })),
      requiresApproval: parsed.requiresApproval,
    };
  }

  /** Resolve the active model, persist a new `agent_runs` row, build the
   *  ReAct system prompt (filesystem/web/browser rules + destination hint),
   *  then hand off to `runReactLoop()`. */
  private async executePlan(plan: AgentPlan): Promise<void> {
    const db = getDb();
    const homeDir = os.homedir();
    const runId = crypto.randomUUID();
    const model = this.activeModelName();

    db.prepare(`UPDATE agent_states SET status='running' WHERE workflow_id=?`)
      .run(plan.workflowId);
    db.prepare(`
      INSERT INTO agent_runs (run_id, session_id, workflow_id, goal, model, status)
      VALUES (?, ?, ?, ?, ?, 'running')
    `).run(runId, plan.sessionId, plan.workflowId, plan.goal, model);

    this.emit('agent:workflowStart', plan.workflowId);

    const history = this.getSessionHistory(plan.sessionId);
    const destHint = this.extractDestination(plan.goal, homeDir);
    const skill = plan.skill ?? null;
    const skillBlock = skill
      ? `ACTIVE SKILL — "${skill.name}". This is your operating playbook for this task; follow it:\n${skill.instructions}\n\n`
      : '';

    const messages: OpenAI.ChatCompletionMessageParam[] = [
      {
        role: 'system',
        content: `You are Artha, a local AI agent on a Mac. You have real filesystem tools.

${skillBlock}

Home:      ${homeDir}
Desktop:   ${homeDir}/Desktop
Documents: ${homeDir}/Documents
Downloads: ${homeDir}/Downloads

${destHint ? `DESTINATION (extracted from user request): ${destHint}\nUse THIS path as the destination. Do NOT use any other location.\n` : ''}
RULES — follow exactly, no exceptions:
1. Resolve folder names: bare names (e.g. "ss26", "Screenshots") must be found by trying ~/Desktop/NAME → ~/Documents/NAME → ~/Downloads/NAME → ~/NAME with fs_list_directory.
2. NEVER fabricate results. If you did not call a tool, do NOT claim the action happened. Every statement about a file being moved, created, or deleted MUST have a corresponding tool call.
3. To move files: call fs_list_directory first, then call fs_move_file for EACH file individually — one tool call per file.
4. After ALL moves, call fs_list_directory on the SOURCE to confirm it is empty, and on the DESTINATION to confirm files arrived.
5. Do NOT stop calling tools until every file is moved and verified.
6. Destination path for fs_move_file MUST include the filename: e.g. ${homeDir}/Desktop/FolderName/file.png
7. NEVER respond with JSON. Always write plain conversational English.
8. Write a plain-English summary ONLY after all tool calls and verification are complete.
9. When you used web_fetch or web_search, weave the source URL into your answer (e.g. "according to example.com/foo") — the UI renders citations from those URLs.
10. Browser tools (browser_navigate, browser_click, browser_type, browser_read_dom, browser_screenshot) open a real, visible browser pane the user can watch.
    - Prefer web_fetch for plain article reads. Use the browser only when the page needs interaction (logins, SPAs, dynamic content, form submission).
    - If the page needs a login, captcha, 2FA, or anything you cannot do safely, call browser_request_user with a short reason. The user will complete it and resume you — the call returns "resumed" or "cancelled".
11. When the user asks for a report, proposal, summary document, presentation, or spreadsheet AS A FILE, call docs_generate (type docx/pptx/xlsx/pdf). Gather facts first with web_fetch/web_search when needed and pass them in the "context" argument so the document is sourced. Do not paste a long document into chat when the user wanted a file.
12. When the user asks about THEIR OWN files, notes, or documents, call rag_search to retrieve relevant passages from their indexed files, then answer from those passages and cite the source filenames. Do not fabricate file contents.`,
      },
      ...history,
      { role: 'user', content: plan.goal },
    ];

    await this.runReactLoop({
      workflowId: plan.workflowId,
      runId,
      sessionId: plan.sessionId,
      goal: plan.goal,
      messages,
      skill,
    });
  }

  /** The core ReAct loop. Repeatedly: call the LLM with the current message
   *  list + tool schemas, execute any returned tool_calls (tracking
   *  filesystem mutations for verification + auditing every call), then loop
   *  until the model returns a plain-text reply, hits MAX_ITERATIONS, gets
   *  cancelled, or stalls with 3 empty responses in a row.
   *
   *  Also owns the citation window for this workflow — every web/browser
   *  tool call appends citations that are drained + emitted alongside the
   *  final response. */
  private async runReactLoop(args: {
    workflowId: string;
    runId: string;
    sessionId: string;
    goal: string;
    messages: OpenAI.ChatCompletionMessageParam[];
    modelOverride?: string;
    skill?: ActiveSkill | null;
  }): Promise<void> {
    const db = getDb();
    const llm = getActiveLLMClient(args.modelOverride);
    const tools = this.skills.filterTools(this.registry.getToolSchemas(), args.skill ?? null);

    const messages = args.messages;
    const mutations: TrackedMutation[] = [];
    const recordStep = this.makeStepRecorder(args.runId);
    let stepIdx = 0;

    // Begin collecting citations for any web_fetch / web_search calls the
    // model makes inside this loop. Drained + emitted at the final response.
    startCitationCollection(args.workflowId);
    setActiveCitationToken(args.workflowId);

    recordStep(stepIdx++, 'system', { note: 'loop start', model: args.modelOverride ?? this.activeModelName() }, messages);

    const MAX_ITERATIONS = 60;
    let iterations = 0;
    let emptyCount = 0;
    const homeDir = os.homedir();

    let finalEmitted = false;

    while (iterations < MAX_ITERATIONS) {
      iterations++;

      if (this.cancelledWorkflows.has(args.workflowId)) {
        this.cancelledWorkflows.delete(args.workflowId);
        this.emit('agent:token', '_Task stopped by user._');
        recordStep(stepIdx++, 'final', { reason: 'cancelled' });
        db.prepare(`UPDATE agent_runs SET status='cancelled' WHERE run_id=?`).run(args.runId);
        break;
      }

      // Stream the turn. Text deltas are emitted live; if the turn turns out to
      // be a tool step (or its text gets replaced by a verified summary), we
      // emit `agent:streamReset` to clear the live preamble.
      let msg: StreamedMessage;
      let streamedLive = false;
      try {
        msg = await llm.streamComplete(
          messages,
          tools,
          (tok) => { this.emit('agent:token', tok); streamedLive = true; },
          () => this.cancelledWorkflows.has(args.workflowId),
        );
      } catch (err) {
        const m = err instanceof Error ? err.message : String(err);
        this.emit('agent:token', `\n\n⚠️ Error: ${m}`);
        recordStep(stepIdx++, 'final', { error: m });
        db.prepare(`UPDATE agent_runs SET status='failed' WHERE run_id=?`).run(args.runId);
        break;
      }

      // Aborted mid-stream — bounce to the top so the cancel handler finalises.
      if (this.cancelledWorkflows.has(args.workflowId)) continue;

      messages.push({
        role: 'assistant',
        content: msg.content ?? null,
        tool_calls: msg.tool_calls,
      });
      recordStep(stepIdx++, 'assistant', {
        content: msg.content,
        tool_calls: msg.tool_calls,
      }, messages);

      if (msg.tool_calls?.length) {
        // Intermediate step — suppress any preamble text shown live.
        if (streamedLive) this.emit('agent:streamReset');
        for (const toolCall of msg.tool_calls) {
          this.emit('agent:toolCall', {
            type: 'tool_invoke',
            name: toolCall.function.name,
            args: toolCall.function.arguments,
          });
          recordStep(stepIdx++, 'tool_call', {
            name: toolCall.function.name,
            args: toolCall.function.arguments,
            id: toolCall.id,
          });

          let toolResult: string;
          const toolStart = Date.now();
          let toolStatus: 'ok' | 'error' = 'ok';
          let parsedArgs: Record<string, unknown> = {};
          try { parsedArgs = JSON.parse(toolCall.function.arguments); } catch { /* ignore */ }

          try {
            toolResult = await this.registry.invokeTool(toolCall.function.name, parsedArgs);

            // Self-correction: small models often pass a bare folder name
            // ("ss26") instead of a full path. When fs_list_directory fails
            // with ENOENT, probe Desktop/Documents/Downloads and inject the
            // resolved path as a system message so the model uses it for the
            // remaining moves — saves a 3-call retry loop.
            if (
              toolCall.function.name === 'fs_list_directory' &&
              toolResult.includes('ENOENT') &&
              typeof parsedArgs.path === 'string' &&
              !parsedArgs.path.includes('/')
            ) {
              const name = parsedArgs.path;
              const candidates = [
                `${homeDir}/Desktop/${name}`,
                `${homeDir}/Documents/${name}`,
                `${homeDir}/Downloads/${name}`,
              ];
              for (const candidate of candidates) {
                try {
                  const alt = await this.registry.invokeTool('fs_list_directory', { path: candidate });
                  if (!alt.includes('ENOENT')) {
                    toolResult = alt;
                    messages.push({
                      role: 'system',
                      content: `Path correction: "${name}" was found at "${candidate}". Use this full path for all remaining operations.`,
                    });
                    break;
                  }
                } catch { /* try next */ }
              }
            }
          } catch (err) {
            toolResult = `Error: ${err instanceof Error ? err.message : String(err)}`;
            toolStatus = 'error';
          }

          if (MUTATION_TOOLS.has(toolCall.function.name)) {
            mutations.push({
              tool: toolCall.function.name,
              args: parsedArgs,
              result: toolResult,
              success: toolStatus === 'ok' && !toolResult.startsWith('Error:'),
            });
          }

          try {
            db.prepare(`
              INSERT INTO tool_audit_log
                (session_id, workflow_id, tool_name, args_json, result, duration_ms, status)
              VALUES (?,?,?,?,?,?,?)
            `).run(
              args.sessionId, args.workflowId,
              toolCall.function.name, toolCall.function.arguments,
              toolResult.slice(0, 500),
              Date.now() - toolStart,
              toolStatus
            );
          } catch { /* non-critical */ }

          messages.push({
            role: 'tool',
            content: toolResult,
            tool_call_id: toolCall.id,
          });
          recordStep(stepIdx++, 'tool_result', {
            name: toolCall.function.name,
            result: toolResult.slice(0, 4000),
            status: toolStatus,
            duration_ms: Date.now() - toolStart,
          }, messages);

          this.emit('agent:toolCall', {
            type: 'tool_result',
            name: toolCall.function.name,
            result: toolResult,
          });
        }
        emptyCount = 0;
        // Loop continues — let the model decide what to do next

      } else if (msg.content?.trim()) {
        // ── Final response branch ──────────────────────────────────────────
        const rawContent = msg.content;
        let finalText: string;

        if (mutations.length > 0) {
          // The user-facing text is a verified summary, not the model's prose.
          finalText = await this.generateVerifiedSummary(args.goal, mutations);
        } else {
          finalText = rawContent
            .replace(/\{[\s\S]*?"name":\s*"fs_[^}]*\}/g, '')
            .replace(/^\s*\{[\s\S]*?\}\s*$/gm, '')
            .replace(/^\s*[a-z]+\s*$/gim, '')
            .replace(/\n{3,}/g, '\n\n')
            .trim();

          if (finalText.startsWith('{')) {
            try {
              const j = JSON.parse(finalText) as Record<string, unknown>;
              const pick = j.content ?? j.text ?? j.answer ?? j.response;
              if (typeof pick === 'string') finalText = pick;
            } catch { /* keep as-is */ }
          }
        }

        // The raw content was already streamed live. Only re-emit if the final
        // text differs (verified summary, or cleaning changed it) — otherwise
        // what the user already saw stands as-is.
        if (finalText !== rawContent.trim()) {
          if (streamedLive) this.emit('agent:streamReset');
          if (finalText) this.emit('agent:token', finalText);
        } else if (!streamedLive && finalText) {
          this.emit('agent:token', finalText);
        }

        // Persist the assistant message so the next session load shows it.
        try {
          const cits = drainCitations(args.workflowId);
          db.prepare(
            `INSERT INTO messages (session_id, sender_type, content, citations_json) VALUES (?, 'agent', ?, ?)`
          ).run(args.sessionId, finalText, cits.length ? JSON.stringify(cits) : null);
          if (cits.length > 0) {
            this.emit('agent:citations', { citations: cits });
          }
        } catch (err) {
          console.warn('[Artha] persisting final message failed:', err);
        }

        recordStep(stepIdx++, 'final', { content: finalText });
        db.prepare(`UPDATE agent_runs SET status='completed' WHERE run_id=?`).run(args.runId);
        db.prepare(`UPDATE agent_states SET status='completed' WHERE workflow_id=?`).run(args.workflowId);
        finalEmitted = true;
        break;

      } else {
        emptyCount++;
        if (emptyCount >= 3) {
          recordStep(stepIdx++, 'final', { reason: 'stall' });
          db.prepare(`UPDATE agent_runs SET status='failed' WHERE run_id=?`).run(args.runId);
          break;
        }
      }
    }

    if (!finalEmitted && iterations >= 60) {
      recordStep(stepIdx++, 'final', { reason: 'max_iterations' });
      db.prepare(`UPDATE agent_runs SET status='failed' WHERE run_id=?`).run(args.runId);
    }

    setActiveCitationToken(null);
    this.emit('agent:streamEnd');
  }

  /** Build a 2-3 sentence summary anchored to the verified mutation list.
   *  Falls back to a one-liner if the synthesis LLM call fails. */
  private async generateVerifiedSummary(goal: string, mutations: TrackedMutation[]): Promise<string> {
    const successful = mutations.filter(m => m.success);
    const failed = mutations.filter(m => !m.success);

    const groundTruth = [
      `Goal: ${goal}`,
      `Operations performed (${successful.length} ok, ${failed.length} failed):`,
      ...successful.map(m => `- ${m.tool}(${JSON.stringify(m.args)}) → OK`),
      ...failed.map(m => `- ${m.tool}(${JSON.stringify(m.args)}) → FAILED: ${m.result.slice(0, 200)}`),
    ].join('\n');

    try {
      const llm = getActiveLLMClient(undefined, 'synthesis');
      const resp = await llm.complete([
        { role: 'system', content: 'You summarize completed tasks accurately. Use 2-3 sentences. Never claim an operation not listed in the ground truth.' },
        { role: 'user', content: `Write a brief user-facing summary of what happened.\n\n${groundTruth}` },
      ]);
      const text = resp.choices[0]?.message?.content?.trim();
      if (text) return text;
    } catch { /* fall through */ }

    if (failed.length === 0) {
      return `Done — completed ${successful.length} operation${successful.length === 1 ? '' : 's'}.`;
    }
    return `Completed ${successful.length} of ${successful.length + failed.length} operations; ${failed.length} failed.`;
  }

  /** Bind a runId to a step recorder that writes to agent_steps.
   *  Snapshots are only meaningful for assistant/system steps — they capture
   *  the full message list so forkFromStep() can replay deterministically. */
  private makeStepRecorder(runId: string) {
    const db = getDb();
    const insert = db.prepare(
      `INSERT INTO agent_steps (step_id, run_id, idx, kind, payload, messages_snapshot)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    return (
      idx: number,
      kind: string,
      payload: unknown,
      snapshot?: OpenAI.ChatCompletionMessageParam[]
    ): void => {
      try {
        insert.run(
          crypto.randomUUID(),
          runId,
          idx,
          kind,
          JSON.stringify(payload),
          snapshot ? JSON.stringify(snapshot) : null,
        );
      } catch (err) {
        console.warn('[Artha] step record failed:', err);
      }
    };
  }

  /** Look up the active model name from llm_models. Used for run row metadata
   *  and to label the system step at loop start. */
  private activeModelName(): string {
    try {
      const db = getDb();
      const row = db
        .prepare(`SELECT ollama_name FROM llm_models WHERE is_active=1 LIMIT 1`)
        .get() as { ollama_name: string } | undefined;
      return row?.ollama_name ?? 'unknown';
    } catch {
      return 'unknown';
    }
  }

  /** Best-effort destination extraction from the user's goal. Returns an
   *  absolute path when the goal contains a clear "into <path>" / "to <path>"
   *  / "in <path>" cue; otherwise null. The system prompt uses this as an
   *  anchor so the model doesn't pick a different destination mid-run. */
  private extractDestination(goal: string, homeDir: string): string | null {
    const m = goal.match(
      /(?:into|to|in)\s+(~\/[^\s,.]+|\/[^\s,.]+|[A-Z][a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*)/
    );
    if (!m) return null;
    let p = m[1];
    if (p.startsWith('~/')) p = homeDir + p.slice(1);
    return p;
  }

  /** Pull the last N messages of this session into an OpenAI message array.
   *  Capped at 20 entries so very long sessions don't blow the context window. */
  private getSessionHistory(sessionId: string): OpenAI.ChatCompletionMessageParam[] {
    const db = getDb();
    const rows = db.prepare(
      `SELECT sender_type, content FROM messages
       WHERE session_id=? ORDER BY timestamp ASC LIMIT 20`
    ).all(sessionId) as { sender_type: string; content: string }[];
    return rows.map(r => ({
      role: r.sender_type === 'user' ? 'user' : 'assistant',
      content: r.content,
    } as OpenAI.ChatCompletionMessageParam));
  }

  private emit(channel: string, data?: unknown): void {
    if (!this.window.isDestroyed()) {
      this.window.webContents.send(channel, data);
    }
  }
}
