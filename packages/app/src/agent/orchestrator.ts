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
import { sendNotification } from '../notify';
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
import {
  MEMORY_TOOL_SCHEMAS,
  isMemoryTool,
  invokeMemoryTool,
  getMemoryContext,
} from '../tools/memory';
import {
  DESKTOP_TOOL_SCHEMAS,
  isDesktopTool,
  invokeDesktopTool,
} from '../tools/desktop';

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
  /** True if this step is independent and may run in parallel with siblings. */
  parallel?: boolean;
}

/** Image or file attachment the user added before sending a message. The
 *  base64 data is passed directly to the LLM in the OpenAI vision format. */
export interface Attachment {
  name: string;
  mime: string;  // e.g. 'image/png'
  data: string;  // base64-encoded bytes
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
  /** When true, the goal decomposes into independent sub-tasks the orchestrator
   *  should fan out via runParallel() instead of the sequential ReAct loop. */
  requiresParallel?: boolean;
  /** The independent sub-task prompts to run concurrently (set with requiresParallel). */
  subTasks?: string[];
  /** Skill active for this run, if one was matched/invoked. Threaded through
   *  approval so its instructions + tool scope survive a pause-for-approval. */
  skill?: ActiveSkill | null;
  /** Images/files attached to the triggering user message. Threaded through to
   *  the first LLM turn in vision format so the model can see them. */
  attachments?: Attachment[];
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
/** A clarification request the orchestrator paused on. */
export interface ClarifyRequest {
  workflowId: string;
  sessionId: string;
  goal: string;
  questions: string[];
}

export class AgentOrchestrator {
  private window: BrowserWindow;
  private registry: MCPRegistry;
  private skills: SkillRegistry;
  /** Plans awaiting user approval, keyed by workflowId. */
  private activePlans = new Map<string, AgentPlan>();
  /** Set of workflow IDs the user has hit Stop on; consulted each loop tick. */
  private cancelledWorkflows = new Set<string>();
  /** Pending clarification requests, keyed by workflowId. */
  private clarifyResolvers = new Map<string, (answers: string[] | null) => void>();

  constructor(window: BrowserWindow) {
    this.window = window;
    this.registry = MCPRegistry.getInstance();
    this.skills = SkillRegistry.getInstance();
  }

  /** Entry point: receive a user message and start the ReAct loop.
   *
   *  Flow:
   *   1. Resolve skill.
   *   2. Ask the LLM whether the request is ambiguous (clarification detection).
   *      If yes, emit agent:clarifyRequest and pause until the user answers or skips.
   *   3. Generate plan (with enriched goal if answers were provided).
   *   4. Execute or pause for approval.
   */
  async handleMessage(sessionId: string, userContent: string, attachments?: Attachment[]): Promise<void> {
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

    // ── Clarification check ──────────────────────────────────────────────────
    // Ask the LLM whether the goal needs clarification before planning.
    // Short messages (≤6 words) and "/slug" invocations skip this to avoid
    // annoying interruptions on simple commands.
    const wordCount = goal.trim().split(/\s+/).length;
    let enrichedGoal = goal;

    if (wordCount > 6 && !userContent.startsWith('/')) {
      const questions = await this.detectClarificationNeeded(goal);
      if (questions.length > 0) {
        db.prepare(`UPDATE agent_states SET status='awaiting_approval' WHERE workflow_id=?`).run(workflowId);
        this.emit('agent:clarifyRequest', { workflowId, sessionId, goal, questions } satisfies ClarifyRequest);

        // Pause until the renderer calls clarifyRespond() or times out (90s).
        const answers = await Promise.race([
          new Promise<string[] | null>(resolve => { this.clarifyResolvers.set(workflowId, resolve); }),
          new Promise<null>(resolve => setTimeout(() => resolve(null), 90_000)),
        ]);
        this.clarifyResolvers.delete(workflowId);

        if (answers && answers.some(a => a.trim())) {
          // Weave Q&A into the goal so the planner has full context.
          const qa = questions.map((q, i) => `Q: ${q}\nA: ${answers[i] ?? '(not answered)'}`).join('\n');
          enrichedGoal = `${goal}\n\nAdditional context from user:\n${qa}`;
        }
        // If answers is null (timeout or skip), proceed with original goal.
        db.prepare(`UPDATE agent_states SET status='pending' WHERE workflow_id=?`).run(workflowId);
      }
    }
    // ── End clarification ────────────────────────────────────────────────────

    const history = this.getSessionHistory(sessionId);

    const plan = await this.generatePlan(workflowId, sessionId, enrichedGoal, history, skill);
    plan.skill = skill;
    plan.attachments = attachments;
    this.activePlans.set(workflowId, plan);

    // Fan-out path: the planner judged the goal to be independent sub-tasks.
    // Run them concurrently rather than as one sequential loop.
    if (plan.requiresParallel && plan.subTasks && plan.subTasks.length > 1) {
      this.activePlans.delete(workflowId);
      await this.runParallel(sessionId, enrichedGoal, plan.subTasks);
      return;
    }

    if (plan.requiresApproval) {
      db.prepare(`UPDATE agent_states SET status='awaiting_approval', plan_json=? WHERE workflow_id=?`)
        .run(JSON.stringify(plan.steps), workflowId);
      this.emit('agent:planReady', plan);
      return;
    }

    await this.executePlan(plan);
  }

  /** Called by the IPC handler when the user submits clarification answers.
   *  `answers` is a parallel array to the emitted `questions`. Pass null to skip. */
  clarifyRespond(workflowId: string, answers: string[] | null): void {
    const resolve = this.clarifyResolvers.get(workflowId);
    if (resolve) resolve(answers);
  }

  /** Ask the LLM whether a goal needs clarification.
   *  Returns up to 3 short questions, or [] if the goal is clear enough. */
  private async detectClarificationNeeded(goal: string): Promise<string[]> {
    try {
      const llm = getActiveLLMClient(undefined, 'plan');
      const resp = await llm.complete([
        {
          role: 'system',
          content: `You are a pre-flight clarification detector for an AI agent.
Given a user's task description, decide if any SHORT clarifying questions would materially improve the outcome.
Only ask if the answer would change what files are touched, what format to use, or what scope to cover.
Do NOT ask about things the agent can infer or look up itself.

Respond ONLY with a JSON array of up to 3 short questions, or an empty array if the goal is clear:
["Question 1?", "Question 2?"]
or
[]`,
        },
        { role: 'user', content: goal },
      ]);

      const raw = (resp.choices[0]?.message?.content ?? '[]').trim();
      const parsed = JSON.parse(raw.replace(/```json\n?|\n?```/g, '')) as unknown;
      if (Array.isArray(parsed) && parsed.every(q => typeof q === 'string')) {
        return (parsed as string[]).slice(0, 3);
      }
    } catch {
      // Non-critical — if detection fails, proceed without clarification.
    }
    return [];
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

  /** Decompose a goal into independent sub-tasks and run them concurrently.
   *  Each sub-task gets a throwaway child session + its own ReAct loop; we cap
   *  concurrency at 4 so we don't hammer Ollama. The final assistant message of
   *  each child is collected, the child sessions are deleted, and a combined
   *  summary is persisted to the parent session.
   *
   *  Note: child loops emit their own token/streamEnd events to the desktop UI,
   *  so output interleaves; the ChatWindow's parallel indicator (driven by the
   *  parallelStart/parallelTaskDone events below) is the intended UX surface. */
  async runParallel(sessionId: string, goal: string, subTasks: string[]): Promise<string[]> {
    const db = getDb();
    const workflowId = crypto.randomUUID();
    const results: string[] = new Array(subTasks.length).fill('');

    this.emit('agent:workflowStart', workflowId);
    this.emit('agent:parallelStart', { goal, subTasks });

    const CONCURRENCY = 4;
    let cursor = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        const i = cursor++;
        if (i >= subTasks.length) break;
        const subTask = subTasks[i];
        const childSessionId = crypto.randomUUID();
        const runId = crypto.randomUUID();
        db.prepare(`INSERT INTO chat_sessions (session_id, title) VALUES (?, ?)`)
          .run(childSessionId, `Sub-task ${i + 1}: ${subTask.slice(0, 40)}`);
        db.prepare(`INSERT INTO agent_runs (run_id, session_id, workflow_id, goal, model, status) VALUES (?,?,?,?,?, 'running')`)
          .run(runId, childSessionId, workflowId, subTask, this.activeModelName());

        try {
          const messages: OpenAI.ChatCompletionMessageParam[] = [
            {
              role: 'system',
              content: `You are Artha, a local AI agent on a Mac running one sub-task of a larger goal. Complete this sub-task precisely using your tools, then report the result concisely. Sub-task:`,
            },
            { role: 'user', content: subTask },
          ];
          await this.runReactLoop({ workflowId, runId, sessionId: childSessionId, goal: subTask, messages, silent: true });
          const row = db.prepare(
            `SELECT content FROM messages WHERE session_id=? AND sender_type='agent' ORDER BY rowid DESC LIMIT 1`
          ).get(childSessionId) as { content: string } | undefined;
          results[i] = row?.content ?? '';
        } catch (err) {
          results[i] = `Error: ${err instanceof Error ? err.message : String(err)}`;
        } finally {
          // Drop the throwaway session (cascades its messages) after collecting.
          try { db.prepare(`DELETE FROM chat_sessions WHERE session_id=?`).run(childSessionId); } catch { /* ignore */ }
          this.emit('agent:parallelTaskDone', { index: i, result: results[i] });
        }
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, subTasks.length) }, () => worker())
    );

    // Persist a combined summary to the parent session so the chat shows a result.
    const combined = subTasks
      .map((t, i) => `### Sub-task ${i + 1}: ${t}\n\n${results[i] || '_(no result)_'}`)
      .join('\n\n');
    try {
      db.prepare(`INSERT INTO messages (session_id, sender_type, content) VALUES (?, 'agent', ?)`)
        .run(sessionId, combined);
    } catch (err) {
      console.warn('[Artha] persisting parallel summary failed:', err);
    }
    this.emit('agent:token', combined);
    this.emit('agent:streamEnd');

    return results;
  }

  /** Desktop-control tools are gated behind an opt-in setting (default off). */
  private desktopControlEnabled(): boolean {
    try {
      const row = getDb().prepare(`SELECT settings_json FROM users WHERE user_id='default'`).get() as { settings_json: string } | undefined;
      return !!JSON.parse(row?.settings_json ?? '{}').desktop_control_enabled;
    } catch {
      return false;
    }
  }

  // ── Private ───────────────────────────────────────────────────────────────

  /** Build the user-turn content. If image attachments are present, returns an
   *  OpenAI vision content array; otherwise returns a plain string. */
  private buildUserContent(
    text: string,
    attachments?: Attachment[]
  ): OpenAI.ChatCompletionUserMessageParam['content'] {
    if (!attachments?.length) return text;
    return [
      { type: 'text', text },
      ...attachments.map(a => ({
        type: 'image_url' as const,
        image_url: { url: `data:${a.mime};base64,${a.data}` },
      })),
    ];
  }

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
  "requiresApproval": true,
  "requiresParallel": false,
  "subTasks": []
}

Rules:
- Set requiresApproval=true whenever steps move, delete, or modify files
- Always start with fs_list_directory or fs_search_files before moving anything
- Keep steps minimal and concrete
- Set requiresParallel=true ONLY when the request is clearly several INDEPENDENT tasks that don't depend on each other's output (e.g. "research X, Y and Z separately", "summarize each of these 3 files"). In that case put each independent task as a self-contained prompt string in "subTasks" (2-4 items). For normal sequential work leave requiresParallel=false and subTasks=[].`,
    };

    const response = await llm.complete([planningPrompt, ...history, { role: 'user', content: goal }]);
    const raw = response.choices[0]?.message?.content ?? '{}';

    let parsed: { steps: WorkflowStep[]; requiresApproval: boolean; requiresParallel?: boolean; subTasks?: string[] };
    try {
      parsed = JSON.parse(raw.replace(/```json\n?|\n?```/g, ''));
    } catch {
      parsed = {
        steps: [{ index: 0, description: goal, status: 'pending' }],
        requiresApproval: false,
      };
    }

    const subTasks = Array.isArray(parsed.subTasks)
      ? parsed.subTasks.filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
      : [];

    return {
      workflowId,
      sessionId,
      goal,
      steps: parsed.steps.map((s, i) => ({ ...s, index: i, status: 'pending' as const })),
      requiresApproval: parsed.requiresApproval,
      requiresParallel: !!parsed.requiresParallel && subTasks.length > 1,
      subTasks,
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
    const planStartMs = Date.now();

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
    const memoryBlock = getMemoryContext();

    const messages: OpenAI.ChatCompletionMessageParam[] = [
      {
        role: 'system',
        content: `You are Artha, a local AI agent on a Mac. You have real filesystem tools.

${memoryBlock}${skillBlock}

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
12. When the user asks about THEIR OWN files, notes, or documents, call rag_search to retrieve relevant passages from their indexed files, then answer from those passages and cite the source filenames. Do not fabricate file contents.
13. Use memory_store to persist important facts about the user or their work for future sessions (preferences, project names, contacts, decisions). Use memory_recall before answering questions about things the user has told you before. Use memory_forget if a memory is outdated.`,
      },
      ...history,
      { role: 'user', content: this.buildUserContent(plan.goal, plan.attachments) },
    ];

    await this.runReactLoop({
      workflowId: plan.workflowId,
      runId,
      sessionId: plan.sessionId,
      goal: plan.goal,
      messages,
      skill,
      startMs: planStartMs,
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
    startMs?: number;
    /** When true, suppress renderer-facing events (token/toolCall/streamEnd/…)
     *  but keep DB persistence. Used for parallel child loops so their output
     *  doesn't interleave in the chat — runParallel owns the visible lifecycle. */
    silent?: boolean;
  }): Promise<void> {
    const db = getDb();
    const llm = getActiveLLMClient(args.modelOverride);
    // Renderer-facing emit gate. Silent child loops still persist to SQLite.
    const emit = (channel: string, data?: unknown): void => {
      if (!args.silent) this.emit(channel, data);
    };
    const tools = [
      ...this.skills.filterTools(this.registry.getToolSchemas(), args.skill ?? null),
      ...MEMORY_TOOL_SCHEMAS,
      // Desktop control (mouse/keyboard/screenshot) is opt-in and dangerous, so
      // it's only offered to the model when the user has enabled it in Settings.
      ...(this.desktopControlEnabled() ? DESKTOP_TOOL_SCHEMAS : []),
    ];

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
        emit('agent:token', '_Task stopped by user._');
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
          (tok) => { emit('agent:token', tok); streamedLive = true; },
          () => this.cancelledWorkflows.has(args.workflowId),
        );
      } catch (err) {
        const m = err instanceof Error ? err.message : String(err);
        emit('agent:token', `\n\n⚠️ Error: ${m}`);
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
        if (streamedLive) emit('agent:streamReset');
        for (const toolCall of msg.tool_calls) {
          emit('agent:toolCall', {
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
            if (isMemoryTool(toolCall.function.name)) {
              toolResult = invokeMemoryTool(toolCall.function.name, parsedArgs, args.sessionId);
            } else if (isDesktopTool(toolCall.function.name)) {
              toolResult = await invokeDesktopTool(toolCall.function.name, parsedArgs);
            } else {
              toolResult = await this.registry.invokeTool(toolCall.function.name, parsedArgs);
            }

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

          emit('agent:toolCall', {
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
          if (streamedLive) emit('agent:streamReset');
          if (finalText) emit('agent:token', finalText);
        } else if (!streamedLive && finalText) {
          emit('agent:token', finalText);
        }

        // Persist the assistant message so the next session load shows it.
        try {
          const cits = drainCitations(args.workflowId);
          db.prepare(
            `INSERT INTO messages (session_id, sender_type, content, citations_json) VALUES (?, 'agent', ?, ?)`
          ).run(args.sessionId, finalText, cits.length ? JSON.stringify(cits) : null);
          if (cits.length > 0) {
            emit('agent:citations', { citations: cits });
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

    // Fire a native notification when a long-running task finishes (> 10 s)
    // so the user knows the agent is done even if they switched apps.
    if (args.startMs && Date.now() - args.startMs > 10_000) {
      const g = args.goal;
      const goalSnippet = g.length > 60 ? g.slice(0, 57) + '…' : g;
      sendNotification('Artha — task complete', goalSnippet);
    }

    emit('agent:streamEnd');
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
