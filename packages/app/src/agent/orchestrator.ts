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
import { getActiveLLMClient, type StreamedMessage, type TaskType } from '../llm/client';
import { MCPRegistry, type ToolContext } from '../mcp/registry';
import { SkillRegistry, type ActiveSkill } from '../skills/registry';
import { getDb } from '../db/schema';
import { getSessionScopes, getSessionAllowedRoots, getSessionPrimaryFolder, getSessionRagIndexIds } from '../db/scopes';
import { buildShallowTree } from './folderTree';
import { getRunContext } from './runContext';
import OpenAI from 'openai';
import {
  startCitationCollection,
  drainCitations,
  setActiveCitationToken,
  getActiveCitationToken,
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
import { gatherContext } from './contextGather';
import { shouldNudgeToAct, compactStaleDomDumps } from './actGuard';
import { noteDesktopControlActive } from '../controlOverlay';
import { estimateBlastRadius, type BlastRadius } from './blastRadius';
import { evaluatePolicy } from '../bodhi/policy';
import { recordReceipt, RECEIPT_MUTATION_TOOLS, type ReceiptStatus } from '../bodhi/receipts';
import {
  isSubcapabilityTool,
  getSubcapabilityToolSchemas,
  intersectToolScopes,
  MAX_CAPABILITY_DEPTH,
} from '../bodhi/subcapability';
import { filterToolsByAllowlist } from '../skills/util';

const MAX_RETRIES = 3; // kept for future retry logic
void MAX_RETRIES;

/** One entry in the agent's internal chain-of-thought trace. Produced by the
 *  <think> phase (and the preceding context-gather), persisted to
 *  `messages.reasoning_steps`, and surfaced in the UI as an expandable
 *  "Thinking" disclosure. `context_score` records how strongly the assembled
 *  local context (memories + history + scopes) influenced this step (0-1). */
export interface ReasoningStep {
  // 'reasoning' is the model's own live chain-of-thought streamed from the LLM
  // (Ollama `thinking` / OpenAI `reasoning_content`); 'context'/'think' are the
  // orchestrator's pre-flight phases.
  phase: 'context' | 'think' | 'reasoning';
  content: string;
  context_score: number;
}

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
  /** Pre-flight estimate of what executing this plan will touch (deletes/moves/
   *  writes/web/reversibility/token cost). Shown in the approval card so the user
   *  approves with the consequences in view, not on faith. */
  blastRadius?: BlastRadius;
}

/** A per-tool-call approval the orchestrator paused on because a policy assigned
 *  the call the `confirm` tier. The renderer shows a modal and answers via
 *  `respondToolApproval(approvalId, approved)`. */
export interface ToolApprovalRequest {
  approvalId: string;
  workflowId: string;
  sessionId: string;
  toolName: string;
  /** Pretty-printed (truncated) arguments for the user to inspect. */
  argsPreview: string;
  /** Note from the policy rule that triggered this prompt. */
  note: string;
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
  'fs_move_batch',
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
  /** Pending per-tool-call approvals (policy `confirm` tier), keyed by approvalId.
   *  The workflowId is kept so cancelWorkflow() can promptly deny any approval
   *  the user is mid-decision on when they hit Stop. */
  private toolApprovalResolvers = new Map<string, { workflowId: string; resolve: (approved: boolean) => void }>();

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

    // ── Intent gate ──────────────────────────────────────────────────────────
    // A casual greeting or general question must NOT be forced through the
    // file-task planner + tool-forcing ReAct loop — that's what makes local
    // models refuse with "I cannot perform this task ... beyond the given
    // functions". Route conversational messages to a plain reply with no tools
    // attached. An explicit/auto-matched skill always implies action, so it
    // skips the gate.
    if (!skill) {
      const intent = await this.classifyIntent(goal);
      if (intent === 'chat') {
        await this.handleConversational(workflowId, sessionId, goal, attachments);
        return;
      }
    }
    // ── End intent gate ──────────────────────────────────────────────────────

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

  /** Decide whether a message is casual conversation / a general question
   *  ("chat") or an actionable task that should go through the planner + tool
   *  loop ("task"). A rule-based fast-path resolves the obvious cases with zero
   *  LLM cost; only the ambiguous middle costs one cheap classification call on
   *  the smallest local model. Defaults to "task" on any error so real work is
   *  never silently swallowed into a chit-chat reply. */
  private async classifyIntent(goal: string): Promise<'chat' | 'task'> {
    const text = goal.trim();
    if (!text) return 'chat';

    // Fast-path 1: short greetings / acknowledgements / identity questions.
    const GREETING = /^(hi+|hello+|hey+|yo|sup|howdy|greetings|thanks|thank you|thx|ty|ok|okay|cool|nice|great|bye|goodbye|good (morning|afternoon|evening|night)|how are you|who are you|what('?s| is) your name|what can you do)\b[\s!.?]*$/i;
    if (GREETING.test(text)) return 'chat';

    // Fast-path 2: an explicit action verb almost always means a real task —
    // skip the classifier round-trip and go straight to the planner.
    const ACTION = /\b(move|moving|rename|delete|remove|create|make|organi[sz]e|copy|open|find|search|download|fetch|read|write|summari[sz]e|generate|build|convert|list|sort|clean|email|send|browse|navigate|click|screenshot|install|run|edit|update|fix|deploy)\b/i;
    if (ACTION.test(text)) return 'task';

    // Ambiguous middle: ask the model to label it. Use the SAME model that will
    // answer a conversational reply ('synthesis' → active model) rather than the
    // small 'plan' model: on local Ollama, classifying on 'plan' and then
    // answering on the active model means two back-to-back model loads before
    // the first token. Reusing the active model keeps it warm so a plain chat
    // question streams its answer after a single load. The classification is one
    // token, so the larger model costs almost nothing here.
    try {
      const llm = getActiveLLMClient(undefined, 'synthesis');
      const resp = await llm.complete([
        {
          role: 'system',
          content: `Classify the user's message as exactly one word: "chat" or "task".
- "chat": greetings, small talk, opinions, or general-knowledge questions answerable in plain conversation WITHOUT touching the user's files, the web, the browser, or the desktop.
- "task": a request to act on files, the web, documents, or the computer.
Reply with ONLY the single word "chat" or "task" — nothing else.`,
        },
        { role: 'user', content: text },
      ]);
      const answer = (resp.choices[0]?.message?.content ?? '').toLowerCase();
      // Bias toward "chat" only when the model clearly didn't say "task": this
      // branch already saw no action verb, so a false "task" just falls back to
      // the (working) planner path, while a false "chat" is harmless.
      return answer.includes('task') ? 'task' : 'chat';
    } catch {
      return 'task';
    }
  }

  /** Plain conversational reply path — no planner, no tools, no ReAct loop.
   *  Used for greetings and general questions so local models never refuse for
   *  lack of a matching tool. Mirrors runParallel's persist + emit lifecycle so
   *  the chat UI behaves exactly like a normal agent turn. */
  private async handleConversational(
    workflowId: string,
    sessionId: string,
    goal: string,
    attachments?: Attachment[]
  ): Promise<void> {
    const db = getDb();
    const runId = crypto.randomUUID();

    db.prepare(`UPDATE agent_states SET status='running' WHERE workflow_id=?`).run(workflowId);
    db.prepare(
      `INSERT INTO agent_runs (run_id, session_id, workflow_id, goal, model, status) VALUES (?,?,?,?,?, 'running')`
    ).run(runId, sessionId, workflowId, goal, this.activeModelName());

    this.emit('agent:workflowStart', workflowId);

    const projectId = this.getSessionProjectId(sessionId);
    const memoryBlock = getMemoryContext(projectId);
    const projectBlock = this.getSessionScopeBlock(sessionId);
    const envBlock = this.buildEnvironmentContext();

    const messages: OpenAI.ChatCompletionMessageParam[] = [
      {
        role: 'system',
        content: `You are Artha, a friendly local-first AI assistant on the user's Mac. You can chat normally, and when asked you can act on their files, the web, documents, and desktop using real tools.

Right now you're just talking. Answer naturally and concisely in plain English — you do NOT need a tool for everything, and you must NEVER refuse merely because no tool fits. If the user wants you to actually DO something on their computer (organise files, fetch a page, make a document), invite them to ask and you'll take it from there.

${memoryBlock}${projectBlock}

${envBlock}`,
      },
      ...this.getSessionHistory(sessionId),
      { role: 'user', content: this.buildUserContent(goal, attachments) },
    ];

    let finalText = '';
    // Stream the model's own chain-of-thought to the chat bubble so the user
    // sees *what* Artha is thinking during the (often long) reasoning phase that
    // precedes the first answer token, rather than a blank spinner. Throttled to
    // avoid flooding IPC on fast token streams.
    const showReasoning = this.showReasoningEnabled();
    let reasoningText = '';
    let lastReasonEmit = 0;
    const onReasoning = (chunk: string) => {
      reasoningText += chunk;
      const now = Date.now();
      if (now - lastReasonEmit < 100) return;
      lastReasonEmit = now;
      this.emit('agent:reasoning', {
        steps: [{ phase: 'reasoning', content: reasoningText, context_score: 0 }],
        showReasoning,
      });
    };
    try {
      const llm = getActiveLLMClient(undefined, 'synthesis');
      const result = await llm.streamComplete(
        messages,
        undefined, // no tools → tool_choice dropped → no tool-constrained refusal
        (tok) => { finalText += tok; this.emit('agent:token', tok); },
        () => this.cancelledWorkflows.has(workflowId),
        onReasoning,
      );
      // Flush any reasoning buffered since the last throttled emit so the final
      // thinking text is complete before the answer takes over the bubble.
      if (reasoningText) {
        this.emit('agent:reasoning', {
          steps: [{ phase: 'reasoning', content: reasoningText, context_score: 0 }],
          showReasoning,
        });
      }
      // Some models return the whole answer in the final message instead of
      // streaming token-by-token — surface that if nothing streamed.
      if (!finalText && result.content) {
        finalText = result.content;
        this.emit('agent:token', finalText);
      }
    } catch (err) {
      finalText = `⚠️ Error: ${err instanceof Error ? err.message : String(err)}`;
      this.emit('agent:token', `\n\n${finalText}`);
    }

    if (!finalText.trim()) finalText = 'Hi! How can I help?';

    try {
      db.prepare(`INSERT INTO messages (session_id, sender_type, content) VALUES (?, 'agent', ?)`)
        .run(sessionId, finalText);
    } catch (err) {
      console.warn('[Artha] persisting conversational reply failed:', err);
    }

    db.prepare(`UPDATE agent_runs SET status='completed' WHERE run_id=?`).run(runId);
    db.prepare(`UPDATE agent_states SET status='completed' WHERE workflow_id=?`).run(workflowId);
    this.emit('agent:streamEnd');
  }

  /** Called by the IPC handler when the user submits clarification answers.
   *  `answers` is a parallel array to the emitted `questions`. Pass null to skip. */
  clarifyRespond(workflowId: string, answers: string[] | null): void {
    const resolve = this.clarifyResolvers.get(workflowId);
    if (resolve) resolve(answers);
  }

  /** Called by the IPC handler when the user approves or denies a policy-gated
   *  tool call (the `confirm` tier). Resolves the awaiting ReAct loop. */
  respondToolApproval(approvalId: string, approved: boolean): void {
    const entry = this.toolApprovalResolvers.get(approvalId);
    if (entry) entry.resolve(approved);
  }

  /** Emit a tool-approval request to the renderer and block until the user
   *  answers (or a safety timeout denies it). Used when a policy assigns a tool
   *  call the `confirm` tier. Defaults to DENY on timeout — a governance gate
   *  must fail closed. */
  private requestToolApproval(req: {
    workflowId: string;
    sessionId: string;
    toolName: string;
    args: Record<string, unknown>;
    note: string;
  }): Promise<boolean> {
    const approvalId = crypto.randomUUID();
    this.emit('agent:toolApprovalRequest', {
      approvalId,
      workflowId: req.workflowId,
      sessionId: req.sessionId,
      toolName: req.toolName,
      argsPreview: JSON.stringify(req.args, null, 2).slice(0, 800),
      note: req.note,
    } satisfies ToolApprovalRequest);
    return Promise.race([
      new Promise<boolean>(resolve => { this.toolApprovalResolvers.set(approvalId, { workflowId: req.workflowId, resolve }); }),
      new Promise<boolean>(resolve => setTimeout(() => resolve(false), 120_000)),
    ]).finally(() => this.toolApprovalResolvers.delete(approvalId));
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
    // If the user is mid-decision on a tool-approval modal for this workflow,
    // deny it immediately so the loop unblocks now instead of after the 120s
    // timeout — otherwise Stop feels broken while an approval is pending.
    for (const [, entry] of this.toolApprovalResolvers) {
      if (entry.workflowId === workflowId) entry.resolve(false);
    }
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

    // Same live env context the sequential loop gets, so concurrent children
    // share the agent's awareness of the date/OS/user.
    const envBlock = this.buildEnvironmentContext();

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
              content: `You are Artha, a local AI agent on a Mac, running ONE sub-task of a larger goal. You have real filesystem and web tools.

${envBlock}

Complete exactly this one sub-task using your tools — do not expand scope or start other sub-tasks.

Rules:
- NEVER fabricate results. Every claim that a file was read/created/moved/deleted, or that a page said something, MUST come from an actual tool call.
- Only call tools that have been made available to you; never invent a tool name or a parameter that isn't in its schema.
- If a tool reports an error, correct the arguments and retry that call at most once; never repeat an identical failing call.
- When moving files: resolve bare folder names via ~/Desktop/NAME → ~/Documents/NAME → ~/Downloads/NAME → ~/NAME, call fs_move_file once per file (the destination must include the filename), then fs_list_directory to verify.
- When you use web_fetch or web_search, weave the source URL into your answer so it can be cited.
- Output only the result and a one-line verification of what you confirmed — no preamble, no extra commentary.`,
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

  /** Whether the renderer should DISPLAY the reasoning disclosure. Default true.
   *  When false the <think> phase still runs (and is persisted) — only the UI is
   *  hidden, per the `show_reasoning` setting. */
  private showReasoningEnabled(): boolean {
    try {
      const row = getDb().prepare(`SELECT settings_json FROM users WHERE user_id='default'`).get() as { settings_json: string } | undefined;
      return JSON.parse(row?.settings_json ?? '{}').show_reasoning !== false;
    } catch {
      return true;
    }
  }

  /** Dedicated chain-of-thought call made BEFORE any tool use. Reuses the run's
   *  system prompt (so it sees the injected <context> + memory + environment)
   *  but asks ONLY for a plain-English plan — no tools, no final answer. The
   *  returned trace is recorded + shown in the UI and fed back as private
   *  guidance, never as the user-facing reply. Best-effort: '' on any failure. */
  private async runThinkPhase(goal: string, messages: OpenAI.ChatCompletionMessageParam[]): Promise<string> {
    try {
      const llm = getActiveLLMClient(undefined, 'plan');
      const sys = messages.find(m => m.role === 'system');
      const sysText = typeof sys?.content === 'string' ? sys.content : '';
      const thinkMessages: OpenAI.ChatCompletionMessageParam[] = [
        {
          role: 'system',
          content: `${sysText}\n\n— REASONING STEP —\nBefore taking any action, think step by step about how to accomplish the user's goal. Cover: (1) what the user actually wants, (2) what information or files you need, (3) which tools you'll call and in what order, (4) how you'll verify success. Write a concise plan in plain English. Do NOT call any tools and do NOT write the final answer yet — only the plan.`,
        },
        { role: 'user', content: goal },
      ];
      // No tools passed → the model can only return plain text.
      const resp = await llm.complete(thinkMessages);
      return (resp.choices[0]?.message?.content ?? '').trim();
    } catch {
      return '';
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

${this.buildEnvironmentContext()}

Available tools: ${tools.map(t => t.function.name).join(', ')}
${skillBlock}
Decompose the user's request into a clear, minimal step-by-step plan.

Respond ONLY with a valid JSON object (no markdown, no explanation):
{
  "steps": [
    { "index": 0, "description": "List files in ~/Desktop to see what screenshots exist", "toolName": "fs_list_directory" },
    { "index": 1, "description": "Move all matching screenshots into the target folder in one batch", "toolName": "fs_move_batch" }
  ],
  "requiresApproval": true,
  "requiresParallel": false,
  "subTasks": []
}

Rules:
- Set requiresApproval=true whenever steps move, delete, or modify files
- For filesystem work, always start with fs_list_directory or fs_search_files before moving anything
- For browser/website work (sending email, filling a form, posting), plan concrete browser_* steps: browser_navigate → browser_read_dom to find the fields → browser_type → browser_click to submit → confirm. These are real actions to perform, not advice to give the user.
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

    const steps = parsed.steps.map((s, i) => ({ ...s, index: i, status: 'pending' as const }));
    return {
      workflowId,
      sessionId,
      goal,
      steps,
      requiresApproval: parsed.requiresApproval,
      requiresParallel: !!parsed.requiresParallel && subTasks.length > 1,
      subTasks,
      // Pre-flight blast-radius estimate, surfaced in the approval card so the
      // user sees the consequences before approving.
      blastRadius: estimateBlastRadius(steps, goal),
    };
  }

  /** Resolve the active model, persist a new `agent_runs` row, build the
   *  ReAct system prompt (filesystem/web/browser rules + destination hint),
   *  then hand off to `runReactLoop()`. Returns the `runId` of the Task it
   *  created so callers (e.g. the capability executor) can track it. `silent`
   *  suppresses renderer-facing events while still persisting to SQLite —
   *  used when a capability is run outside the Chat surface. */
  private async executePlan(plan: AgentPlan, opts: { silent?: boolean; runId?: string; taskType?: TaskType } = {}): Promise<string> {
    const db = getDb();
    const homeDir = os.homedir();
    // Caller may pre-create the run id (non-blocking starts insert the row up
    // front so it can be polled immediately); otherwise mint one here.
    const runId = opts.runId ?? crypto.randomUUID();
    const model = this.activeModelName();
    const planStartMs = Date.now();

    db.prepare(`UPDATE agent_states SET status='running' WHERE workflow_id=?`)
      .run(plan.workflowId);
    // OR IGNORE: a non-blocking start has already inserted this row.
    db.prepare(`
      INSERT OR IGNORE INTO agent_runs (run_id, session_id, workflow_id, goal, model, status)
      VALUES (?, ?, ?, ?, ?, 'running')
    `).run(runId, plan.sessionId, plan.workflowId, plan.goal, model);

    // Silent runs (e.g. Delegate) must not drive the Chat surface's working UI.
    if (!opts.silent) this.emit('agent:workflowStart', plan.workflowId);

    const history = this.getSessionHistory(plan.sessionId);
    const destHint = this.extractDestination(plan.goal, homeDir);
    const skill = plan.skill ?? null;
    const skillBlock = skill
      ? `ACTIVE SKILL — "${skill.name}". This is your operating playbook for this task; follow it:\n${skill.instructions}\n\n`
      : '';
    const projectId = this.getSessionProjectId(plan.sessionId);
    const memoryBlock = getMemoryContext(projectId);
    const projectBlock = this.getSessionScopeBlock(plan.sessionId);
    const envBlock = this.buildEnvironmentContext();

    const messages: OpenAI.ChatCompletionMessageParam[] = [
      {
        role: 'system',
        content: `You are Artha, a local AI agent on a Mac. You have real filesystem tools AND a real browser, and you ACT. On every task you reach the goal by CALLING TOOLS — never by describing what the user could do, and never by writing out the steps you "would" take.

When the user asks you to move, organise, rename, create, or delete files, you DO it by calling tools — you NEVER just list a folder and then describe it or ask what to do next. Listing a directory (fs_list_directory) is only the FIRST step to see what's there; you must IMMEDIATELY continue calling tools to perform the actual task, and keep going until it is fully done and verified. Do not summarise the folder contents back to the user instead of acting.

The SAME act-don't-describe rule governs the browser. When the user asks you to do something on a website — send an email, fill or submit a form, post, reply, book, search-then-click — you DO it by calling browser_* tools, not by explaining how. The pattern is: browser_navigate to the page → browser_read_dom to see the actual fields/buttons → browser_type into each field → browser_click the send/submit control → browser_read_dom (or browser_get_url) to CONFIRM it actually happened (e.g. a "Message sent" confirmation). Keep calling browser tools until the action is genuinely completed and verified. NEVER stop and tell the user how they could do it themselves, and never claim you sent/submitted something unless a browser tool call actually did it. The only reason to pause is a genuine login, captcha, or 2FA wall — and for that you call browser_request_user, you do not give up or narrate.

Only write a plain-English reply once the task is COMPLETE (or you are genuinely blocked and must ask one specific question).

${memoryBlock}${skillBlock}${projectBlock}

${envBlock}

Home:      ${homeDir}
Desktop:   ${homeDir}/Desktop
Documents: ${homeDir}/Documents
Downloads: ${homeDir}/Downloads

${destHint ? `DESTINATION (extracted from user request): ${destHint}\nUse THIS path as the destination. Do NOT use any other location.\n` : ''}
RULES — follow exactly, no exceptions:
1. Resolve folder names: bare names (e.g. "ss26", "Screenshots") must be found by trying ~/Desktop/NAME → ~/Documents/NAME → ~/Downloads/NAME → ~/NAME with fs_list_directory.
2. NEVER fabricate results. If you did not call a tool, do NOT claim the action happened. Every statement about a file being moved, created, or deleted MUST have a corresponding tool call.
3. To move files: call fs_list_directory first to see what exists, then move them. For MULTIPLE files (e.g. organising a folder), call fs_move_batch ONCE with every { source, destination } pair — this is far faster than one call per file. Use fs_move_file only for a single file.
4. After moving, call fs_list_directory on the DESTINATION to confirm files arrived (and on the SOURCE if the user expects it emptied).
5. Do NOT stop calling tools until the task is fully done and verified. Listing the folder is NOT the task — moving the files is.
6. Destination path for fs_move_file MUST include the filename: e.g. ${homeDir}/Desktop/FolderName/file.png
7. NEVER respond with JSON. Always write plain conversational English.
8. Write a plain-English summary ONLY after all tool calls and verification are complete.
9. When you used web_fetch or web_search, weave the source URL into your answer (e.g. "according to example.com/foo") — the UI renders citations from those URLs.
10. Browser tools (browser_navigate, browser_click, browser_type, browser_read_dom, browser_screenshot) open a real, visible browser pane the user can watch.
    - Prefer web_fetch for plain article reads. Use the browser only when the page needs interaction (logins, SPAs, dynamic content, form submission, sending email).
    - To act on a page you must SEE it first: call browser_read_dom to find the real selectors (compose button, To/Subject/Body fields, Send button) before typing or clicking — do not guess selectors blindly.
    - For an email-send request the loop is concrete: browser_navigate to the mail app → click Compose → browser_type the recipient, subject, and body into their fields → click Send → browser_read_dom to confirm it shows as sent. Do NOT report success until that confirmation is on screen.
    - If the page needs a login, captcha, 2FA, or anything you cannot do safely, call browser_request_user with a short reason. The user will complete it and resume you — the call returns "resumed" or "cancelled". If the page is already logged in, just proceed — do not request the user unnecessarily.
11. When the user asks for a report, proposal, summary document, presentation, or spreadsheet AS A FILE, call docs_generate (type docx/pptx/xlsx/pdf). Gather facts first with web_fetch/web_search when needed and pass them in the "context" argument so the document is sourced. Do not paste a long document into chat when the user wanted a file.
12. When the user asks about THEIR OWN files, notes, or documents, call rag_search to retrieve relevant passages from their indexed files, then answer from those passages and cite the source filenames. Do not fabricate file contents.
13. Use memory_store to persist important facts about the user or their work for future sessions (preferences, project names, contacts, decisions). Use memory_recall before answering questions about things the user has told you before. Use memory_forget if a memory is outdated.
14. Tool errors: if a tool result reports a failure (it starts with "Error:" or contains an "error" field), read the message, correct the arguments, and retry THAT call AT MOST once more. NEVER re-issue a byte-identical call that just failed — change something or stop. If the same operation fails twice, leave it, note it as failed, and continue with the rest of the task; do not loop on it.
15. Tool availability: only call tools that have been made available to you. Never invent a tool name, and never pass a parameter that isn't in that tool's schema. If no available tool can do what's needed, say so plainly — do not pretend an action happened. But if the user is just greeting you or asking a general question that needs no tool at all, simply answer in plain English — NEVER refuse for lack of a matching tool.`,
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
      silent: opts.silent,
      taskType: opts.taskType,
    });

    // Phase 3: refresh the project's rolling cross-session memory in the
    // background so a future chat in this project starts already aware of what
    // happened here. Best-effort; never blocks or fails the run.
    if (projectId) void this.updateProjectSummary(projectId, plan.sessionId);

    return runId;
  }

  /** Invoke one capability (a Skill playbook) against a goal and run it to
   *  completion as a tracked Task, returning the Task's run id. This is the
   *  orchestrator side of Bodhi's universal `invoke(capability, …)` contract.
   *
   *  It runs SILENT — its tokens/tool events are not emitted to the Chat
   *  surface — because callers like Delegate own their own UI and observe the
   *  result via the Task (`agent_runs`) and its persisted final message. It
   *  also skips clarification + skill auto-match: the capability is already
   *  chosen, so we go straight to execution with that skill active. */
  async runCapability(args: { sessionId: string; goal: string; skill?: ActiveSkill | null }): Promise<string> {
    const workflowId = crypto.randomUUID();
    getDb().prepare(`
      INSERT INTO agent_states (workflow_id, session_id, status, context_json)
      VALUES (?, ?, 'running', ?)
    `).run(workflowId, args.sessionId, JSON.stringify({ goal: args.goal, skill: args.skill?.slug ?? null }));

    const plan: AgentPlan = {
      workflowId,
      sessionId: args.sessionId,
      goal: args.goal,
      steps: [{ index: 0, description: args.goal, status: 'pending' }],
      requiresApproval: false,
      skill: args.skill ?? null,
    };
    return this.executePlan(plan, { silent: true });
  }

  /** Non-blocking variant of {@link runCapability}: synchronously create the
   *  Task (so it can be polled immediately), kick the run off in the background,
   *  and return the run id right away. This is how goal-driven surfaces like
   *  Delegate execute — the UI polls the Task's status/steps instead of blocking
   *  on the whole run, which is what makes long tasks observable and resumable. */
  startCapability(args: { sessionId: string; goal: string; skill?: ActiveSkill | null }): string {
    const db = getDb();
    const workflowId = crypto.randomUUID();
    const runId = crypto.randomUUID();

    db.prepare(`
      INSERT INTO agent_states (workflow_id, session_id, status, context_json)
      VALUES (?, ?, 'running', ?)
    `).run(workflowId, args.sessionId, JSON.stringify({ goal: args.goal, skill: args.skill?.slug ?? null }));
    db.prepare(`
      INSERT INTO agent_runs (run_id, session_id, workflow_id, goal, model, status)
      VALUES (?, ?, ?, ?, ?, 'running')
    `).run(runId, args.sessionId, workflowId, args.goal, this.activeModelName());

    const plan: AgentPlan = {
      workflowId,
      sessionId: args.sessionId,
      goal: args.goal,
      steps: [{ index: 0, description: args.goal, status: 'pending' }],
      requiresApproval: false,
      skill: args.skill ?? null,
    };
    // Fire-and-forget; on hard failure mark the Task failed so pollers see it.
    // 'tool_args' routes the loop to the router's fast model (smallest installed
    // when un-benchmarked) so Delegate's many turns aren't all on the heavy
    // active model — the #1 cause of slow delegated runs on local hardware.
    void this.executePlan(plan, { silent: true, runId, taskType: 'tool_args' }).catch((err) => {
      console.error('[Artha] delegate capability run failed:', err);
      try { getDb().prepare(`UPDATE agent_runs SET status='failed' WHERE run_id=?`).run(runId); } catch { /* ignore */ }
    });

    return runId;
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
    /** Route the loop's model via the router for this task type instead of the
     *  active model. Delegate passes 'tool_args' so its many mechanical turns run
     *  on a fast small model (the router's pick / smallest installed) rather than
     *  the heavy active model — keeping Chat on the active model untouched. */
    taskType?: TaskType;
    /** Composable sub-capabilities: how deeply nested this loop is. A top-level
     *  Chat/Delegate run is 0; a capability it invokes runs at 1, and so on up to
     *  MAX_CAPABILITY_DEPTH. Used to bound recursion and withhold the delegation
     *  tool at the cap. */
    depth?: number;
    /** The tool scope the PARENT loop was actually running with. The child's
     *  effective scope is the intersection of this and its own skill's allowlist,
     *  guaranteeing a child can never exceed its parent (permission monotonicity). */
    parentAllowedTools?: string[];
    /** The parent run's workflowId. A child loop also honours the parent's Stop
     *  so cancelling a top-level run promptly unwinds any sub-capability it's
     *  blocked inside (rather than waiting for the child to run to completion). */
    parentWorkflowId?: string;
  }): Promise<void> {
    const db = getDb();
    const llm = getActiveLLMClient(args.modelOverride, args.taskType);
    // Renderer-facing emit gate. Silent child loops still persist to SQLite.
    const emit = (channel: string, data?: unknown): void => {
      if (!args.silent) this.emit(channel, data);
    };

    const depth = args.depth ?? 0;
    // Effective tool scope for THIS loop = parent's scope ∩ this skill's allowlist
    // (empty allowlist = all tools). This is what enforces permission monotonicity
    // for composed sub-capabilities; a top-level run has no parent so it's just
    // the skill's own allowlist.
    const ownAllowed = args.skill?.allowedTools ?? [];
    const effectiveAllowed = args.parentAllowedTools
      ? intersectToolScopes(args.parentAllowedTools, ownAllowed)
      : ownAllowed;
    // Delegation is only offered when we're below the depth cap AND the current
    // scope actually permits it (an unrestricted run, or one that explicitly
    // allows invoke_capability) — so a tightly-scoped skill can't escape its box
    // by delegating.
    const mayDelegate =
      depth < MAX_CAPABILITY_DEPTH &&
      (effectiveAllowed.length === 0 || effectiveAllowed.includes('invoke_capability'));
    const tools = [
      ...filterToolsByAllowlist(this.registry.getToolSchemas(), effectiveAllowed),
      ...MEMORY_TOOL_SCHEMAS,
      // Desktop control (mouse/keyboard/screenshot) is opt-in and dangerous, so
      // it's only offered to the model when the user has enabled it in Settings.
      ...(this.desktopControlEnabled() ? DESKTOP_TOOL_SCHEMAS : []),
      // Composable sub-capabilities — let this run delegate a self-contained
      // step to a trusted, pre-scoped capability (bounded by depth + scope).
      ...(mayDelegate ? getSubcapabilityToolSchemas() : []),
    ];

    const messages = args.messages;
    const mutations: TrackedMutation[] = [];
    const reasoningSteps: ReasoningStep[] = [];
    const recordStep = this.makeStepRecorder(args.runId);
    let stepIdx = 0;

    // Begin collecting citations for any web_fetch / web_search calls the
    // model makes inside this loop. Drained + emitted at the final response.
    // Capture the previously-active token so a NESTED loop (a sub-capability)
    // restores the parent's token on exit instead of clobbering it to null.
    const prevCitationToken = getActiveCitationToken();
    startCitationCollection(args.workflowId);
    setActiveCitationToken(args.workflowId);

    recordStep(stepIdx++, 'system', { note: 'loop start', model: args.modelOverride ?? this.activeModelName() }, messages);

    // ── Context gather + <think> phase ───────────────────────────────────────
    // Before the first tool call we (1) assemble a structured <context> block of
    // the most relevant local context (top memories by semantic similarity, a
    // short conversation recap, active scopes) and inject it at the TOP of the
    // system prompt, then (2) make a dedicated reasoning call that plans the tool
    // use. The reasoning trace is persisted + shown in the UI but never becomes
    // the user-facing answer. Skipped for silent parallel child loops (cost).
    if (!args.silent) {
      try {
        const gathered = await gatherContext(args.sessionId, args.goal);
        if (gathered.block && messages[0]?.role === 'system' && typeof messages[0].content === 'string') {
          // Inject <context> above the existing memory preamble.
          messages[0].content = `${gathered.block}\n\n${messages[0].content}`;
          reasoningSteps.push({
            phase: 'context',
            content: `Pulled ${gathered.memoryCount} relevant memory item(s), recent conversation, and active folder scopes into context.`,
            context_score: gathered.contextScore,
          });
        }
        // Skip the dedicated planning generation for trivial one-line goals
        // (e.g. "search for X", "what is Y"). It's a full extra model call that
        // adds little for simple asks — the model still reasons inline while
        // answering. Longer or multi-step goals keep the explicit plan.
        const g = args.goal.trim();
        const trivialGoal = g.length <= 80 && !g.includes('\n') &&
          !/\b(then|after|first|step|plan|compare|analy|refactor|build|create|generate|summari|multiple|each|all of)\b/i.test(g);
        const trace = trivialGoal ? '' : await this.runThinkPhase(args.goal, messages);
        if (trace) {
          reasoningSteps.push({ phase: 'think', content: trace, context_score: gathered.contextScore });
          // Feed the plan back as private guidance for tool use — kept out of the
          // final answer (it lives in a system message, never emitted to chat).
          messages.push({
            role: 'system',
            content: `Your private plan for this task (use it to guide your tool calls; do NOT repeat it to the user):\n${trace}`,
          });
          recordStep(stepIdx++, 'assistant', { phase: 'think', reasoning: trace, context_score: gathered.contextScore });
        }
        if (reasoningSteps.length) {
          // Live disclosure: ChatWindow shows these while the agent works. The
          // flag lets the renderer hide the panel when the user turned reasoning
          // off in Settings (the phase still ran — only the UI is suppressed).
          emit('agent:reasoning', { steps: reasoningSteps, showReasoning: this.showReasoningEnabled() });
        }
      } catch (err) {
        console.warn('[Artha] context/think phase failed (continuing):', err);
      }
    }

    const MAX_ITERATIONS = 60;
    let iterations = 0;
    let emptyCount = 0;
    const homeDir = os.homedir();

    // Per-chat scope context: when the chat has attached folders/files, confine
    // the filesystem tools to them (hard sandbox) and default generated docs to
    // the primary folder. Empty roots ⇒ unscoped chat, historical behaviour.
    const allowedRoots = getSessionAllowedRoots(args.sessionId);
    const fsCtx: ToolContext = {
      allowedRoots,
      primaryDir: getSessionPrimaryFolder(args.sessionId),
      ragIndexIds: getSessionRagIndexIds(args.sessionId),
      // Scope CRM/KG writes to the session's project, like memory.
      projectId: this.getSessionProjectId(args.sessionId),
    };

    let finalEmitted = false;

    // Backstop for the "narrates instead of acting" failure mode on browser
    // tasks: count browser_* tool calls and how many times we've nudged the
    // model to actually act. When the model tries to finalise with plain prose
    // on a clear web-action request WITHOUT ever having driven the browser, we
    // inject one corrective turn and keep looping instead of accepting the
    // narration. Bounded by MAX_ACT_NUDGES so a genuinely-stuck model still ends.
    let browserToolCalls = 0;
    let actNudges = 0;
    const MAX_ACT_NUDGES = 2;

    // tool_call ids of every browser_read_dom call, so we can keep only the
    // latest DOM dump in context and stub the rest (see compactStaleDomDumps).
    const readDomCallIds = new Set<string>();

    // A run is cancelled if its own workflow was stopped, OR (for a child
    // sub-capability loop) if the parent run was stopped — so Stop on a
    // top-level run unwinds the nested capability it's blocked inside.
    const isCancelled = (): boolean =>
      this.cancelledWorkflows.has(args.workflowId) ||
      (!!args.parentWorkflowId && this.cancelledWorkflows.has(args.parentWorkflowId));

    while (iterations < MAX_ITERATIONS) {
      iterations++;

      if (isCancelled()) {
        this.cancelledWorkflows.delete(args.workflowId);
        emit('agent:token', '_Task stopped by user._');
        recordStep(stepIdx++, 'final', { reason: 'cancelled' });
        db.prepare(`UPDATE agent_runs SET status='cancelled' WHERE run_id=?`).run(args.runId);
        break;
      }

      // Keep only the most recent browser_read_dom payload in context; stub the
      // rest. Stale ~12k-char DOM dumps otherwise re-send on every turn and are
      // the main driver of slow/expensive browser-action runs.
      compactStaleDomDumps(messages, readDomCallIds);

      // Stream the turn. Text deltas are emitted live; if the turn turns out to
      // be a tool step (or its text gets replaced by a verified summary), we
      // emit `agent:streamReset` to clear the live preamble.
      let msg: StreamedMessage;
      let streamedLive = false;
      // Stream this turn's model reasoning into the live disclosure, appended
      // after the pre-flight context/think steps so the user follows the model's
      // thinking as it decides which tool to use.
      let turnReasoning = '';
      let lastReasonEmit = 0;
      const onReasoning = (chunk: string) => {
        turnReasoning += chunk;
        const now = Date.now();
        if (now - lastReasonEmit < 100) return;
        lastReasonEmit = now;
        emit('agent:reasoning', {
          steps: [...reasoningSteps, { phase: 'reasoning', content: turnReasoning, context_score: 0 }],
          showReasoning: this.showReasoningEnabled(),
        });
      };
      try {
        msg = await llm.streamComplete(
          messages,
          tools,
          (tok) => { emit('agent:token', tok); streamedLive = true; },
          () => isCancelled(),
          onReasoning,
        );
      } catch (err) {
        const m = err instanceof Error ? err.message : String(err);
        emit('agent:token', `\n\n⚠️ Error: ${m}`);
        recordStep(stepIdx++, 'final', { error: m });
        db.prepare(`UPDATE agent_runs SET status='failed' WHERE run_id=?`).run(args.runId);
        break;
      }

      // Aborted mid-stream — bounce to the top so the cancel handler finalises.
      if (isCancelled()) continue;

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
          if (toolCall.function.name.startsWith('browser_')) browserToolCalls++;
          if (toolCall.function.name === 'browser_read_dom') readDomCallIds.add(toolCall.id);
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

          let toolResult = '';
          const toolStart = Date.now();
          let toolStatus: 'ok' | 'error' = 'ok';
          let parsedArgs: Record<string, unknown> = {};
          try { parsedArgs = JSON.parse(toolCall.function.arguments); } catch { /* ignore */ }

          // ── Policy gate ────────────────────────────────────────────────
          // Evaluate THIS specific call (tool name + arguments) against the
          // user's tool policies before it runs. forbid blocks it; dry_run
          // describes it without executing; confirm pauses for explicit
          // approval; auto runs silently. Local-first — rules never leave the
          // device. (See bodhi/policy.ts.)
          const decision = evaluatePolicy(toolCall.function.name, parsedArgs, { allowedRoots });
          let receiptStatus: ReceiptStatus = 'ok';
          let policyHandled = false;
          if (decision.tier === 'forbid') {
            toolResult = `Error: Blocked by your tool policy${decision.matchedPattern ? ` (rule "${decision.matchedPattern}")` : ''} — this call was not executed.${decision.note ? ` ${decision.note}` : ''}`;
            toolStatus = 'error'; receiptStatus = 'blocked'; policyHandled = true;
          } else if (decision.tier === 'dry_run') {
            toolResult = `Dry run (policy): would call ${toolCall.function.name} with ${JSON.stringify(parsedArgs)}. It was NOT executed — describe this to the user as a preview of what would happen.`;
            receiptStatus = 'skipped'; policyHandled = true;
          } else if (decision.tier === 'confirm') {
            // Confirm only works when a desktop user is watching. Silent runs
            // (Delegate / sub-capability), LAN requests, and scheduled tasks have
            // nobody to approve, so they fail closed instead of hanging a modal.
            const rc = getRunContext();
            const unattended = args.silent || !!rc?.lan || !!rc?.unattended;
            if (unattended) {
              toolResult = `Error: ${toolCall.function.name} needs interactive approval (policy rule "${decision.matchedPattern}") but this run is unattended, so it was blocked.`;
              toolStatus = 'error'; receiptStatus = 'blocked'; policyHandled = true;
            } else {
              const approved = await this.requestToolApproval({
                workflowId: args.workflowId, sessionId: args.sessionId,
                toolName: toolCall.function.name, args: parsedArgs, note: decision.note,
              });
              if (!approved) {
                toolResult = `Error: The user declined this action (${toolCall.function.name}). Do not retry it — continue with the rest of the task, or ask how they'd like to proceed.`;
                toolStatus = 'error'; receiptStatus = 'blocked'; policyHandled = true;
              }
              // approved → fall through to normal execution below.
            }
          }

          if (!policyHandled) {
          try {
            if (isMemoryTool(toolCall.function.name)) {
              toolResult = invokeMemoryTool(toolCall.function.name, parsedArgs, args.sessionId);
            } else if (isDesktopTool(toolCall.function.name)) {
              // Artha is about to drive the REAL cursor/keyboard — paint the
              // full-screen "Artha is in control" overlay so the takeover is
              // obvious. Auto-hides shortly after the last desktop action.
              noteDesktopControlActive();
              toolResult = await invokeDesktopTool(toolCall.function.name, parsedArgs);
            } else if (isSubcapabilityTool(toolCall.function.name)) {
              // Composable sub-capability: delegate a self-contained step to a
              // trusted capability whose tool scope is clamped to this loop's own
              // (permission monotonicity). Bounded by depth in invokeSubcapability.
              toolResult = await this.invokeSubcapability(parsedArgs, {
                sessionId: args.sessionId,
                workflowId: args.workflowId,
                parentRunId: args.runId,
                parentEffectiveAllowed: effectiveAllowed,
                depth,
              });
            } else {
              toolResult = await this.registry.invokeTool(toolCall.function.name, parsedArgs, fsCtx);
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
                  const alt = await this.registry.invokeTool('fs_list_directory', { path: candidate }, fsCtx);
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
          }

          // Anti-hallucination: only count a mutation as having happened when it
          // actually executed AND succeeded — a blocked or dry-run call must
          // never be reported as done.
          if (MUTATION_TOOLS.has(toolCall.function.name)) {
            mutations.push({
              tool: toolCall.function.name,
              args: parsedArgs,
              result: toolResult,
              success: receiptStatus === 'ok' && toolStatus === 'ok' && !toolResult.startsWith('Error:'),
            });
          }

          // Verified receipt: a user-facing, hashed record of this call — auto,
          // confirmed, blocked, or dry-run alike. This is the audit trail behind
          // "agents that prove what they did". (See bodhi/receipts.ts.)
          recordReceipt({
            runId: args.runId,
            sessionId: args.sessionId,
            workflowId: args.workflowId,
            idx: stepIdx,
            toolName: toolCall.function.name,
            args: parsedArgs,
            result: toolResult,
            status: receiptStatus === 'ok' ? (toolStatus === 'error' ? 'error' : 'ok') : receiptStatus,
            tier: decision.tier,
            isMutation: RECEIPT_MUTATION_TOOLS.has(toolCall.function.name),
            durationMs: Date.now() - toolStart,
          });

          try {
            db.prepare(`
              INSERT INTO tool_audit_log
                (session_id, workflow_id, tool_name, args_json, result, duration_ms, status, actor)
              VALUES (?,?,?,?,?,?,?,?)
            `).run(
              args.sessionId, args.workflowId,
              toolCall.function.name, toolCall.function.arguments,
              toolResult.slice(0, 500),
              Date.now() - toolStart,
              toolStatus,
              getRunContext()?.actor ?? 'local'
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

        // Backstop: the model is trying to answer a web-action request with
        // prose, but it never actually drove the browser. Unless it's asking a
        // genuine clarifying question, reject the narration, tell it to act, and
        // loop again. Capped so we never trap a model that truly can't proceed.
        if (shouldNudgeToAct({
          goal: args.goal,
          browserToolCalls,
          mutationCount: mutations.length,
          nudges: actNudges,
          maxNudges: MAX_ACT_NUDGES,
          content: rawContent,
        })) {
          if (streamedLive) emit('agent:streamReset');
          actNudges++;
          messages.push({
            role: 'system',
            content:
              `You replied with words but did NOT call any browser tool, so nothing actually happened. ` +
              `The user asked you to act on a website ("${args.goal.slice(0, 200)}"). ` +
              `Do it now by calling tools — browser_navigate to the page, browser_read_dom to find the real ` +
              `fields and buttons, browser_type to fill them, browser_click to submit — and verify the result. ` +
              `Do not describe the steps; perform them. Only call browser_request_user if you hit a real login/captcha/2FA wall.`,
          });
          recordStep(stepIdx++, 'system', { note: 'act-nudge', nudge: actNudges });
          emptyCount = 0;
          continue;
        }

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
            `INSERT INTO messages (session_id, sender_type, content, citations_json, reasoning_steps) VALUES (?, 'agent', ?, ?, ?)`
          ).run(
            args.sessionId,
            finalText,
            cits.length ? JSON.stringify(cits) : null,
            reasoningSteps.length ? JSON.stringify(reasoningSteps) : null,
          );
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

    // Restore the parent loop's citation token (null at the top level). A bare
    // setActiveCitationToken(null) here would silence the parent's web/browser
    // citation collection after it delegated to a sub-capability.
    setActiveCitationToken(prevCitationToken);

    // Fire a native notification when a long-running task finishes (> 10 s)
    // so the user knows the agent is done even if they switched apps.
    if (args.startMs && Date.now() - args.startMs > 10_000) {
      const g = args.goal;
      const goalSnippet = g.length > 60 ? g.slice(0, 57) + '…' : g;
      sendNotification('Artha — task complete', goalSnippet);
    }

    emit('agent:streamEnd');
  }

  /** Dispatch the `invoke_capability` tool: resolve the named capability, run it
   *  as a child Task with a tool scope clamped to the caller's, and return its
   *  final output as the tool result. Depth-bounded; never throws (errors come
   *  back as a tool-result string the model can react to). */
  private async invokeSubcapability(
    parsedArgs: Record<string, unknown>,
    ctx: {
      sessionId: string;
      workflowId: string;
      parentRunId: string;
      /** The tool scope the calling loop was actually running with. */
      parentEffectiveAllowed: string[];
      depth: number;
    },
  ): Promise<string> {
    const capId = typeof parsedArgs.capability_id === 'string' ? parsedArgs.capability_id.trim() : '';
    const input = typeof parsedArgs.input === 'string' ? parsedArgs.input.trim() : '';
    if (!capId || !input) return 'Error: invoke_capability requires both "capability_id" and "input".';
    if (ctx.depth >= MAX_CAPABILITY_DEPTH) {
      return 'Error: capability nesting limit reached — perform this step directly instead of delegating further.';
    }
    const row = this.skills.getBySlug(capId);
    if (!row || !row.is_enabled) {
      return `Error: no enabled capability with id "${capId}". Pick one from the listed capabilities or do the step yourself.`;
    }

    let allowedTools: string[] = [];
    try {
      const parsed = JSON.parse(row.allowed_tools_json);
      if (Array.isArray(parsed)) allowedTools = parsed.filter((x): x is string => typeof x === 'string');
    } catch { /* empty allowlist = all tools */ }
    const childSkill: ActiveSkill = {
      slug: row.slug, name: row.name, icon: row.icon,
      instructions: row.instructions, allowedTools,
      kind: row.kind === 'agent' ? 'agent' : 'skill',
    };

    try {
      return await this.runChildCapability({
        skill: childSkill,
        input,
        parentRunId: ctx.parentRunId,
        parentWorkflowId: ctx.workflowId,
        parentEffectiveAllowed: ctx.parentEffectiveAllowed,
        depth: ctx.depth,
      });
    } catch (err) {
      return `Error running capability "${capId}": ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  /** Run one capability as a silent child Task and return its final message.
   *  The child loop runs at depth+1 and receives the parent's effective tool
   *  scope, so its own scope is intersected down — it can never exceed the
   *  caller. Lineage is preserved via `parent_run_id`; the throwaway child
   *  session is dropped after the result is read (the run + its receipts stay). */
  private async runChildCapability(args: {
    skill: ActiveSkill;
    input: string;
    parentRunId: string;
    parentWorkflowId: string;
    parentEffectiveAllowed: string[];
    depth: number;
  }): Promise<string> {
    const db = getDb();
    const childSessionId = crypto.randomUUID();
    const runId = crypto.randomUUID();
    const workflowId = crypto.randomUUID();

    db.prepare(`INSERT INTO chat_sessions (session_id, title, origin) VALUES (?, ?, 'delegate')`)
      .run(childSessionId, `Sub: ${args.skill.name}`.slice(0, 60));
    db.prepare(`
      INSERT INTO agent_runs (run_id, session_id, workflow_id, parent_run_id, goal, model, status)
      VALUES (?, ?, ?, ?, ?, ?, 'running')
    `).run(runId, childSessionId, workflowId, args.parentRunId, args.input, this.activeModelName());

    const envBlock = this.buildEnvironmentContext();
    const messages: OpenAI.ChatCompletionMessageParam[] = [
      {
        role: 'system',
        content: `You are Artha, running as the "${args.skill.name}" capability invoked by another agent to handle ONE self-contained sub-task. You have real tools.

ACTIVE CAPABILITY PLAYBOOK — follow it:
${args.skill.instructions}

${envBlock}

Rules:
- Do exactly the sub-task you were given — do not expand scope.
- ACT with tools; never just describe steps. Never fabricate a result — every claim must come from a real tool call.
- Some tools may be unavailable to you because the calling agent's permissions are narrower than yours; if a needed tool is missing, say so plainly rather than pretending.
- End with a short, factual summary of what you actually did and found — that summary is returned to the agent that called you.`,
      },
      { role: 'user', content: args.input },
    ];

    try {
      await this.runReactLoop({
        workflowId,
        runId,
        sessionId: childSessionId,
        goal: args.input,
        messages,
        skill: args.skill,
        silent: true,
        taskType: 'tool_args',
        depth: args.depth + 1,
        parentAllowedTools: args.parentEffectiveAllowed,
        parentWorkflowId: args.parentWorkflowId,
      });
      const row = db.prepare(
        `SELECT content FROM messages WHERE session_id=? AND sender_type='agent' ORDER BY rowid DESC LIMIT 1`
      ).get(childSessionId) as { content: string } | undefined;
      return row?.content?.trim() || '(the capability finished but produced no summary)';
    } finally {
      // Drop the throwaway session (cascades its messages); the agent_run row and
      // its receipts persist so the sub-task stays auditable and in lineage.
      try { db.prepare(`DELETE FROM chat_sessions WHERE session_id=?`).run(childSessionId); } catch { /* ignore */ }
    }
  }

  /** Build a 2-3 sentence summary anchored to the verified mutation list.
   *  Falls back to a one-liner if the synthesis LLM call fails. */
  private async generateVerifiedSummary(goal: string, mutations: TrackedMutation[]): Promise<string> {
    const successful = mutations.filter(m => m.success);
    const failed = mutations.filter(m => !m.success);

    // fs_move_batch is one tool call that moves many files; surface the actual
    // moved/failed counts from its result instead of dumping the whole moves
    // array, so the summary can accurately say "moved N files".
    const describeMutation = (m: TrackedMutation): string => {
      if (m.tool === 'fs_move_batch') {
        try {
          const r = JSON.parse(m.result) as { moved?: number; failed?: number };
          return `- moved ${r.moved ?? 0} file(s) in one batch${r.failed ? `, ${r.failed} could not be moved` : ''} → OK`;
        } catch { /* fall through to generic */ }
      }
      return `- ${m.tool}(${JSON.stringify(m.args)}) → OK`;
    };

    const groundTruth = [
      `Goal: ${goal}`,
      `Operations performed (${successful.length} ok, ${failed.length} failed):`,
      ...successful.map(describeMutation),
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

  /** Live environment context injected into the agent's system prompt on every
   *  run. Surfaces the three things the model can never infer on its own:
   *    1. the real wall-clock date/time (+ the user's timezone) so "today",
   *       "now", "latest", and relative dates resolve correctly;
   *    2. the actual OS/platform/arch it is operating on; and
   *    3. the current user account + hostname.
   *  Best-effort — any lookup that fails degrades gracefully rather than
   *  throwing, since a missing line is better than a failed run. */
  private buildEnvironmentContext(): string {
    const now = new Date();
    let when: string;
    let tz: string;
    try {
      tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'local time';
      when = new Intl.DateTimeFormat('en-US', {
        weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
        hour: '2-digit', minute: '2-digit', timeZoneName: 'short',
      }).format(now);
    } catch {
      tz = 'local time';
      when = now.toString();
    }

    // Friendly OS name; fall back to the raw platform code for anything exotic.
    const platformName =
      ({ darwin: 'macOS', win32: 'Windows', linux: 'Linux' } as Record<string, string>)[os.platform()]
      ?? os.platform();

    let username = 'unknown';
    try { username = os.userInfo().username; } catch { /* sandboxed env — leave unknown */ }

    return [
      `ENVIRONMENT — live context for this turn (you cannot infer these values, so trust them):`,
      `- Current date & time: ${when} (timezone ${tz}). Use this for any "today"/"now"/"latest"/"recent" wording and for resolving relative dates.`,
      `- Operating system: ${platformName} ${os.release()} (${os.platform()}/${os.arch()}).`,
      `- User account: ${username}@${os.hostname()}.`,
    ].join('\n');
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

  /** The project a session belongs to, or null. */
  private getSessionProjectId(sessionId: string): string | null {
    try {
      const r = getDb().prepare(`SELECT project_id FROM chat_sessions WHERE session_id=?`).get(sessionId) as { project_id: string | null } | undefined;
      return r?.project_id ?? null;
    } catch {
      return null;
    }
  }

  /** Refresh a project's rolling cross-session memory from the latest exchange.
   *  Merges the existing summary with the tail of the session via the synthesis
   *  model and stores it on the project. Best-effort; failures are swallowed. */
  private async updateProjectSummary(projectId: string, sessionId: string): Promise<void> {
    try {
      const db = getDb();
      const proj = db.prepare(`SELECT summary FROM projects WHERE project_id=?`).get(projectId) as { summary: string | null } | undefined;
      if (!proj) return;
      const recent = db.prepare(
        `SELECT sender_type, content FROM messages WHERE session_id=? ORDER BY rowid DESC LIMIT 6`
      ).all(sessionId) as { sender_type: string; content: string }[];
      if (!recent.length) return;
      const transcript = recent.reverse()
        .map(m => `${m.sender_type}: ${m.content}`).join('\n').slice(0, 4000);

      const llm = getActiveLLMClient(undefined, 'synthesis');
      const resp = await llm.complete([
        {
          role: 'system',
          content: 'You maintain a concise running memory of a project across chat sessions. Given the existing project memory and the latest conversation, output an UPDATED memory as 4-10 short bullet points capturing durable facts, decisions, current state, and user preferences. Drop stale or superseded points. Omit chit-chat. Keep it under 200 words and output only the bullets.',
        },
        {
          role: 'user',
          content: `EXISTING PROJECT MEMORY:\n${proj.summary ?? '(none yet)'}\n\nLATEST CONVERSATION:\n${transcript}\n\nUpdated project memory:`,
        },
      ]);
      const text = resp.choices[0]?.message?.content?.trim();
      if (text) db.prepare(`UPDATE projects SET summary=? WHERE project_id=?`).run(text.slice(0, 4000), projectId);
    } catch {
      /* best-effort */
    }
  }

  /** Build the working-scope preamble for a chat: the folders + files attached
   *  to this session. Folders carry their RAG index, an ARTHA.md/.artha context
   *  file, and cross-session memory (the primary folder's rolling summary);
   *  small attached files are inlined directly. Tells the model it is hard-
   *  sandboxed to these locations. Returns '' for an unscoped chat. Best-effort
   *  — any failure yields no block. */
  private getSessionScopeBlock(sessionId: string): string {
    try {
      const db = getDb();
      const scopes = getSessionScopes(sessionId);
      if (!scopes.length) return '';

      const fs = require('fs') as typeof import('fs');
      const path = require('path') as typeof import('path');
      const folders = scopes.filter(s => s.kind === 'folder');
      const files = scopes.filter(s => s.kind === 'file');

      let block = `WORKING SCOPE — this chat is restricted to the locations below. ` +
        `You may only read or write files inside them; any path outside is denied. ` +
        `When the user names a file/folder without an absolute path, resolve it inside these locations.\n` +
        `To answer what a folder or app is/does, READ its key files directly (e.g. README.md, ` +
        `package.json, source files) with fs_read_file — the structure is shown below so you can ` +
        `pick files without guessing. Use rag_search only for semantic lookup across many files, ` +
        `and never claim "no information found" before reading the obvious files listed here.\n`;

      if (folders.length) {
        block += `\nFOLDERS:\n`;
        for (const f of folders) {
          const idx = f.rag_index_id
            ? db.prepare(`SELECT doc_count FROM rag_indexes WHERE index_id=?`).get(f.rag_index_id) as { doc_count: number } | undefined
            : undefined;
          const chunks = idx?.doc_count ?? 0;
          const status = chunks > 0
            ? ` (semantic index ready: ${chunks} chunks — rag_search works here)`
            : ` (semantic index not ready yet — read files directly with fs_read_file)`;
          block += `- ${f.path}${status}\n`;
          const tree = buildShallowTree(f.path);
          if (tree) block += `  Contents:\n${tree}\n`;
        }
        block += `Save any files you generate into ${folders[0].path}.\n`;
      }

      if (files.length) {
        block += `\nFILES:\n`;
        let budget = 12000; // total chars of inlined file content
        for (const f of files) {
          block += `- ${f.path}\n`;
          try {
            const stat = fs.statSync(f.path);
            if (stat.isFile() && stat.size <= 64 * 1024 && budget > 0) {
              const content = fs.readFileSync(f.path, 'utf-8').slice(0, Math.min(4000, budget));
              budget -= content.length;
              block += `\`\`\`\n${content}\n\`\`\`\n`;
            }
          } catch { /* unreadable — leave it listed by path only */ }
        }
      }

      // Cross-session context for the primary folder: ARTHA.md + rolling summary.
      const primary = folders[0];
      if (primary) {
        const p = db.prepare(`SELECT summary FROM projects WHERE root_path=? ORDER BY created_at ASC LIMIT 1`)
          .get(primary.path) as { summary: string | null } | undefined;
        let context = '';
        let contextFile = '';
        for (const rel of ['ARTHA.md', '.artha/context.md']) {
          const cf = path.join(primary.path, rel);
          try {
            if (fs.existsSync(cf)) { context = fs.readFileSync(cf, 'utf-8').slice(0, 4000); contextFile = rel; break; }
          } catch { /* try next */ }
        }
        if (p?.summary) block += `\nFOLDER MEMORY (carried over from past chats in this folder):\n${p.summary}\n`;
        if (context) block += `\nFOLDER CONTEXT (from ${contextFile}):\n${context}\n`;
      }

      return block + '\n';
    } catch {
      return '';
    }
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
    // Guard BOTH the window and its webContents: a reload (e.g. our renderer-
    // crash recovery) destroys/recreates webContents while the window lives, so
    // checking only the window let a mid-run emit throw "Object has been
    // destroyed". try/catch covers the destroy-between-check-and-send race.
    if (this.window.isDestroyed()) return;
    const wc = this.window.webContents;
    if (!wc || wc.isDestroyed()) return;
    try {
      wc.send(channel, data);
    } catch {
      /* window/webContents torn down mid-emit — drop the event */
    }
  }
}
