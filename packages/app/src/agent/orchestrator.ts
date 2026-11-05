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
import * as fs from 'fs';
import { sendNotification } from '../notify';
import { getActiveLLMClient, resolveRunModel, type StreamedMessage, type TaskType } from '../llm/client';
import { MCPRegistry, type ToolContext } from '../mcp/registry';
import { SkillRegistry, toActive, type ActiveSkill } from '../skills/registry';
import { resolveMentionBlock } from './mentionResolver';
import { getPackContextBlock, getPackSkillId } from './contextPacks';
import { getDb } from '../db/schema';
import { getSessionScopes, getSessionAllowedRoots, getSessionPrimaryFolder, getSessionRagIndexIds } from '../db/scopes';
import { buildShallowTree } from './folderTree';
import { noteRunStarted, noteRunEnded } from '../system/keepAwake';
import { getRunContext, confirmTierMustFailClosed } from './runContext';
import { persistRunFacts, recordEvidence } from '../bodhi/runFacts';
import { recordAcceptanceCriteria, deriveCriteriaFromMutations, evaluateCriterion, ensureRunTask } from '../bodhi/criteria';
import {
  GOAL_TOOL_SCHEMAS, isGoalTool, getOpenGoal, createGoal, modelUpdateGoal, userStatedOutcome, GoalError,
} from '../bodhi/goals';
import {
  evaluateGoal, applyStopGate, addGoalGapCriteria, numberEvidence, MAX_GOAL_FEEDBACK_ROUNDS,
  type EvaluatorEvidence, type JudgeFn,
} from '../bodhi/goalEvaluator';
import { classifyToolResult, isFailure, countsAsCompletedMutation } from './toolOutcome';
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
import { shouldNudgeToAct, shouldNudgeToSend, detectsSendIntent, detectsWebAction, detectsFileAction, parseEmailFieldsFromGoal, compactStaleDomDumps } from './actGuard';
import { dropEchoedGoal } from './historyDedupe';
import { clampToolResult } from './toolResultBudget';
import { resolveAgentRoute, agentRouteInput } from '../router/agentRouter';
import { ensureAgentModel } from '../router/modelProvisioner';
import { selectToolsForRun } from '../mcp/toolBudget';
import { nextEscalation, escalationLadder } from './escalation';
import { getInteractionHub } from './interactions';
import { ASK_USER_TOOL_NAME, ASK_USER_TOOL_SCHEMA, runAskUser } from './askUser';
import { decidePlanReview, type PlanReview } from './planReview';
import { noteDesktopControlActive } from '../controlOverlay';
import { trackRun, wasStoppedByUser, getKillSwitch } from '../desktop/runtime';
import { gateDesktopAction } from '../desktop/desktopGate';
import { GrantStoreAppGrantAdapter, type GrantAnswer } from '../desktop/appGrants';
import { resolveDesktopTargetApp } from '../tools/desktop';
import { estimateBlastRadius, type BlastRadius } from './blastRadius';
import { evaluatePolicy, isAlwaysConfirmTool } from '../bodhi/policy';
import { decideToolCall, decidePlanGate, defaultModeFor, getSessionMode, modeRequiresPlanApproval, resolveEffectiveMode } from './modes';
import { addGrant, getGrantStore, DEFAULT_GRANT_TTL_SECONDS } from '../bodhi/grants';
import { recordReceipt, RECEIPT_MUTATION_TOOLS, type ReceiptStatus } from '../bodhi/receipts';
import {
  isSubcapabilityTool,
  getSubcapabilityToolSchemas,
  intersectToolScopes,
  MAX_CAPABILITY_DEPTH,
} from '../bodhi/subcapability';
import { filterToolsByAllowlist, parseSlashInvocation, effectiveAllowedTools } from '../skills/util';
import { recordSkillRun, type SkillMatchedVia, type SkillRunStatus } from '../skills/metrics';
import { recordRunEvent, runEventFromChannel, startRunMonitor, markRunActive, markRunInactive } from './runEvents';
import { OutboxDriver, injectSteerAtBoundary } from './outboxDriver';

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
  /** Set when the approval gate was passed automatically (reason shown to the user). */
  autoApproved?: string;
  /** When true, the goal decomposes into independent sub-tasks the orchestrator
   *  should fan out via runParallel() instead of the sequential ReAct loop. */
  requiresParallel?: boolean;
  /** The independent sub-task prompts to run concurrently (set with requiresParallel). */
  subTasks?: string[];
  /** Skill active for this run, if one was matched/invoked. Threaded through
   *  approval so its instructions + tool scope survive a pause-for-approval. */
  skill?: ActiveSkill | null;
  /** Explicit per-run model override (cloud escalation "retry on X" / forks).
   *  Beats the skill's pinned model. Rides the plan so it survives a
   *  pause-for-approval. */
  modelOverride?: string | null;
  /** How the active skill was reached — recorded in the skill_runs ledger so the
   *  dashboard can show explicit-vs-auto-vs-delegated usage. Only meaningful when
   *  `skill` is set; defaults to 'auto' at record time when absent. */
  matchedVia?: SkillMatchedVia;
  /** Images/files attached to the triggering user message. Threaded through to
   *  the first LLM turn in vision format so the model can see them. */
  attachments?: Attachment[];
  /** Pre-flight estimate of what executing this plan will touch (deletes/moves/
   *  writes/web/reversibility/token cost). Shown in the approval card so the user
   *  approves with the consequences in view, not on faith. */
  blastRadius?: BlastRadius;
  /** How many comment-driven planner revisions this plan has had (planReview.ts
   *  caps it at one). */
  revisions?: number;
  /** Step comments the user approved the plan with; injected into the
   *  executor's system prompt so they are honoured while running. */
  reviewNotes?: string | null;
  /** The unified-frame interaction (agent/interactions.ts) this plan's
   *  approval is pending on, when it paused for review. */
  interactionId?: string;
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
  /** Whether the modal may offer "Always allow (30 days)". False for the
   *  always-confirm floor (email_send), which keeps asking every time. */
  allowAlways?: boolean;
  /** Present when this is a per-app desktop-control grant prompt ("Allow
   *  Artha to control {App}?"). The renderer then offers Once / Always for
   *  this project / Deny and answers with `scope`. */
  appGrant?: {
    appName: string;
    /** False when "Always" can't be offered (no project, deny-listed app). */
    alwaysAllowed: boolean;
    /** Deny-listed app (shell, settings, credential store) — always asks. */
    alwaysConfirm: boolean;
  };
}

// ── Anti-hallucination tracker ───────────────────────────────────────────────

/** Every file-system mutation that actually executed (success or fail). */
interface TrackedMutation {
  tool: string;
  args: Record<string, unknown>;
  result: string;
  success: boolean;
}

/**
 * Tools whose calls change state and must therefore be VERIFIED before the
 * run may describe them as done.
 *
 * This set previously covered filesystem tools only — and two of its entries
 * (`fs_write_file`, `fs_rename_file`) do not exist. That left the features
 * users actually run outside verification entirely: "I created your Q3
 * report", "I submitted the form" and "I clicked through and booked it" were
 * unverified model prose, while desktop control — the highest-blast-radius
 * capability in the product — produced no mutation evidence at all
 * (shipped-surface audit C5/H29).
 */
const MUTATION_TOOLS = new Set([
  // Filesystem (only these exist — see tools/filesystem.ts)
  'fs_move_file',
  'fs_move_batch',
  'fs_copy_file',
  'fs_delete_file',
  'fs_create_directory',
  // Deliverables — the flagship "Artha made me a document" claim
  'docs_generate',
  'email_compose',
  // Consequential send — actually dispatches mail (email_compose only drafts)
  'email_send',
  // Browser state changes (reads like browser_read_dom stay out)
  'browser_click',
  'browser_type',
  'browser_navigate',
  // Desktop control — drives the real cursor and keyboard
  'desktop_click',
  'desktop_type',
  'desktop_key',
  'desktop_move_mouse',
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
  private toolApprovalResolvers = new Map<string, { workflowId: string; resolve: (approved: boolean, always?: boolean) => void }>();
  /** Workflows whose plan the user explicitly approved on the plan card. Plan
   *  mode unlocks state-changing tools only for these; auto mode lets a delete
   *  that was in an approved plan run without a second prompt. */
  private userApprovedWorkflows = new Set<string>();
  /** Scope the user picked on an app-grant prompt ('always' vs 'once'),
   *  keyed by approvalId; read once the approval resolves. */
  private approvalScopes = new Map<string, 'once' | 'always'>();
  /** Per-app desktop-control grants, stored in the generic expiring/revocable
   *  grants table (bodhi/grants.ts) via an adapter — so they are listed and
   *  revocable in Settings → Grants. See desktop/appGrants.ts. */
  private appGrants = new GrantStoreAppGrantAdapter(() => getGrantStore());
  /** Chat-turn workflows (from handleMessage) → their session, so the outbox
   *  can tell whether an approval/clarification is pending in a session. */
  private workflowSessions = new Map<string, string>();
  /** Workflows whose plan is waiting on the Plan Approval card. The session's
   *  turn is still "active" for the outbox until approvePlan() settles it. */
  private awaitingPlanApproval = new Set<string>();
  /** Sessions whose current chat turn the user stopped (Stop button or plan
   *  rejection). Unlike cancelledWorkflows (consumed by the loop), this
   *  survives to the end of the turn so the outbox pauses instead of draining. */
  private userStoppedSessions = new Set<string>();
  /** Outbox (type while Artha works): drains queued messages when a turn ends
   *  and supplies "steer now" messages at ReAct tool-call boundaries. */
  readonly outbox: OutboxDriver;

  constructor(window: BrowserWindow) {
    this.window = window;
    this.registry = MCPRegistry.getInstance();
    this.skills = SkillRegistry.getInstance();
    this.outbox = new OutboxDriver({
      persistUserMessage: (sessionId, content) => this.persistUserMessage(sessionId, content),
      startTurn: (sessionId, content, attachments) =>
        this.handleMessage(sessionId, content, attachments.length ? attachments : undefined),
      hasPendingApproval: (sessionId) => this.hasPendingApproval(sessionId),
      emit: (channel, payload) => this.emit(channel, payload),
    });
  }

  /** Write a user message row for an outbox hand-off (the same row
   *  agent:sendMessage writes before calling handleMessage). */
  private persistUserMessage(sessionId: string, content: string): void {
    const db = getDb();
    db.prepare(`INSERT INTO messages (session_id, sender_type, content) VALUES (?, 'user', ?)`).run(sessionId, content);
    db.prepare(`UPDATE chat_sessions SET last_activity=unixepoch() WHERE session_id=?`).run(sessionId);
  }

  /** True while the user owes this session a decision: a confirm-tier tool
   *  approval, a Plan Approval card, or a clarification question. Queued
   *  outbox items never auto-send past one of these. */
  hasPendingApproval(sessionId: string): boolean {
    for (const wf of this.awaitingPlanApproval) {
      if (this.workflowSessions.get(wf) === sessionId) return true;
    }
    for (const [, entry] of this.toolApprovalResolvers) {
      if (this.workflowSessions.get(entry.workflowId) === sessionId) return true;
    }
    for (const wf of this.clarifyResolvers.keys()) {
      if (this.workflowSessions.get(wf) === sessionId) return true;
    }
    return false;
  }

  /** Session of a workflow not started by handleMessage (fan-out / fork), via
   *  its agent_states or agent_runs row. Null when unknown. */
  private sessionOfWorkflow(workflowId: string): string | null {
    try {
      const db = getDb();
      const row = (db.prepare(`SELECT session_id FROM agent_states WHERE workflow_id=?`).get(workflowId)
        ?? db.prepare(`SELECT session_id FROM agent_runs WHERE workflow_id=?`).get(workflowId)) as
        { session_id: string } | undefined;
      return row?.session_id ?? null;
    } catch {
      return null;
    }
  }

  /** Close out a chat turn for the outbox: forget the workflow and tell the
   *  driver how it ended (a user stop pauses the queue; anything else drains). */
  private finishOutboxTurn(workflowId: string, sessionId: string): void {
    this.workflowSessions.delete(workflowId);
    const cancelled = this.userStoppedSessions.delete(sessionId);
    this.awaitingPlanApproval.delete(workflowId);
    try {
      this.outbox.runEnded(sessionId, { cancelled });
    } catch (err) {
      console.warn('[Artha] outbox drain failed (non-critical):', err);
    }
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
  async handleMessage(
    sessionId: string,
    userContent: string,
    attachments?: Attachment[],
    opts: { modelOverride?: string } = {},
  ): Promise<void> {
    const workflowId = crypto.randomUUID();
    // Outbox lifecycle: mark the session busy BEFORE the first await so a
    // racing drain can't start a second turn, and settle it in `finally` so
    // every terminal path (reply, error, stop) reaches the drain. A plan left
    // on the approval card keeps the turn open until approvePlan() runs.
    this.workflowSessions.set(workflowId, sessionId);
    this.outbox.runStarted(sessionId);
    try {
      await this.handleMessageTurn(workflowId, sessionId, userContent, attachments, opts);
    } finally {
      if (!this.awaitingPlanApproval.has(workflowId)) this.finishOutboxTurn(workflowId, sessionId);
    }
  }

  /** The body of a chat turn (see handleMessage for the flow). */
  private async handleMessageTurn(
    workflowId: string,
    sessionId: string,
    userContent: string,
    attachments: Attachment[] | undefined,
    opts: { modelOverride?: string },
  ): Promise<void> {
    const db = getDb();

    // Resolve a skill (explicit "/slug" or auto-match). `goal` has any leading
    // "/slug" stripped, so the rest of the loop never sees the invocation prefix.
    // `skill` is mutable: the project default skill may fill it AFTER the intent
    // gate (a default must not force greetings into the tool loop the way an
    // explicit/auto skill deliberately does).
    const resolved = await this.skills.resolve(userContent);
    let skill = resolved.skill;
    const goal = resolved.goal;
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
        await this.handleConversational(workflowId, sessionId, goal, attachments, opts.modelOverride);
        return;
      }
    }
    // ── End intent gate ──────────────────────────────────────────────────────

    // Session-level skill fallbacks: when nothing explicit or auto-matched,
    // walk the precedence chain — the chat's Context Pack skill first, then
    // the project default (Project Context Hub). Placed after the gate on
    // purpose — see the comment on `skill`.
    if (!skill) {
      skill = this.resolveSkillForSession(sessionId);
      if (skill) {
        this.emit('agent:skillActive', { slug: skill.slug, name: skill.name, icon: skill.icon });
      }
    }

    // Instant acknowledgment: the message is now committed to the task path,
    // and everything between here and the first streamed token is model time
    // (plan, think phase, first tool call). Tell the user what's happening so
    // the working pill shows signal instead of a generic "Thinking…".
    this.emit('agent:status', 'Planning the steps…');

    // ── Clarification check ──────────────────────────────────────────────────
    // Ask the LLM whether the goal needs clarification before planning. This is
    // a full extra model round-trip, so it runs only when its answer could
    // plausibly change the plan. Skipped for:
    //   - short messages (≤6 words) and "/slug" invocations — simple commands;
    //   - any resolved skill (explicit, auto, pack, or project default) — the
    //     skill's playbook already disambiguates intent;
    //   - follow-up messages (session has history) — prior turns are the context
    //     a clarifying question would ask for;
    //   - messages carrying @-mention references — the user has already been
    //     maximally specific about what they mean.
    const wordCount = goal.trim().split(/\s+/).length;
    let enrichedGoal = goal;

    // The current user message is persisted BEFORE handleMessage runs (see
    // agent:sendMessage in ipc/handlers.ts), so "has history" means >1 rows.
    const msgCount = (getDb().prepare(
      `SELECT COUNT(*) AS n FROM messages WHERE session_id=?`
    ).get(sessionId) as { n: number }).n;
    const isFollowUp = msgCount > 1;
    const hasMentionRef = /@(chat|memory):/i.test(goal);
    // LAN / unattended runs have no human to answer the modal — asking would
    // stall the run for the full 90s timeout, so skip straight to planning.
    const rc = getRunContext();
    const noAnswerer = !!rc?.lan || !!rc?.unattended;

    if (wordCount > 6 && !userContent.startsWith('/') && !skill && !isFollowUp && !hasMentionRef && !noAnswerer) {
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

    const history = this.getSessionHistory(sessionId, enrichedGoal);

    const plan = await this.generatePlan(workflowId, sessionId, enrichedGoal, history, skill);
    plan.skill = skill;
    plan.modelOverride = opts.modelOverride ?? null;

    // Plan landed — replace the generic "Planning…" status with the actual
    // first steps ("Plan: list ~/Desktop → move screenshots → verify"), so the
    // remaining pre-first-token wait reads as progress, not dead air.
    if (plan.steps.length) {
      const brief = plan.steps.slice(0, 3)
        .map(s => s.description.replace(/\s+/g, ' ').slice(0, 60))
        .join(' → ');
      this.emit('agent:status', `Plan: ${brief}${plan.steps.length > 3 ? ' → …' : ''}`);
    }
    // Explicit only when the user's own "/slug" resolved to THIS skill; a bare
    // "/" or a slug that fell through to auto-match counts as 'auto'. Mirrors the
    // exact condition resolve() used, so the dashboard split is accurate.
    if (skill) {
      plan.matchedVia = parseSlashInvocation(userContent)?.slug === skill.slug ? 'explicit' : 'auto';
    }
    plan.attachments = attachments;
    this.activePlans.set(workflowId, plan);

    // Fan-out path: the planner judged the goal to be independent sub-tasks.
    // Run them concurrently rather than as one sequential loop.
    if (plan.requiresParallel && plan.subTasks && plan.subTasks.length > 1) {
      this.activePlans.delete(workflowId);
      await this.runParallel(sessionId, enrichedGoal, plan.subTasks);
      return;
    }

    // Permission mode (agent/modes.ts) for the plan gate. Plan mode shows the
    // plan card for EVERY plan; the per-call gate keeps it read-only until then.
    const planMode = getSessionMode(sessionId) ?? defaultModeFor(this.userSettings().autonomousActions as boolean | undefined);
    if (plan.requiresApproval || modeRequiresPlanApproval(planMode)) {
      // Reversible plans run without a modal (agent/autoApprove.ts); the user
      // reviews the outcome with Undo instead of the intent with a click.
      // Deletes and anything not provably reversible still ask. Ask and plan
      // modes always show the card (decidePlanGate). With no stored mode the
      // default comes from autonomousActions, so this is today's behaviour.
      const auto = decidePlanGate(planMode, plan.blastRadius);
      if (!auto.auto) {
        this.pausePlanForReview(plan);
        return;
      }
      plan.autoApproved = auto.reason;
      this.emit('agent:planAutoApproved', { workflowId, reason: auto.reason, summary: plan.blastRadius?.summary ?? '', steps: plan.steps.length });
      this.emit('agent:status', auto.reason);
    }

    await this.executePlan(plan);
  }

  /** Session-level skill fallback chain, consulted only when the message
   *  itself resolved nothing (no /slug, no auto-match):
   *    1. the chat's Context Pack skill (chat_sessions.context_pack_id),
   *    2. the project default (projects.default_skill_id).
   *  Null when neither applies or the referenced skill was deleted/disabled
   *  since being pinned (silent no-skill — bindings are not FK-validated by
   *  design). */
  private resolveSkillForSession(sessionId: string): ActiveSkill | null {
    try {
      const load = (id: string | null | undefined): ActiveSkill | null => {
        if (!id) return null;
        const row = this.skills.getById(id);
        // Session defaults are advisory: they were not chosen for THIS message.
        return row && row.is_enabled ? toActive(row, 'advise') : null;
      };

      const fromPack = load(getPackSkillId(sessionId));
      if (fromPack) return fromPack;

      const proj = getDb().prepare(
        `SELECT p.default_skill_id AS id
         FROM chat_sessions s JOIN projects p ON p.project_id = s.project_id
         WHERE s.session_id = ? AND p.default_skill_id IS NOT NULL`
      ).get(sessionId) as { id: string } | undefined;
      return load(proj?.id);
    } catch {
      return null; // never let a fallback-skill lookup break a run
    }
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
    const ACTION = /\b(move|moving|rename|delete|remove|create|make|organi[sz]e|copy|open|find|search|download|fetch|read|write|summari[sz]e|generate|build|convert|list|sort|clean|email|send|browse|navigate|click|screenshot|install|run|edit|update|fix|deploy|draft|save|export|import|compress|zip|unzip|extract|merge|translate|schedule|remind|book|fill|submit|post|reply|upload|print|look up|google|visit|go to)\b/i;
    if (ACTION.test(text)) return 'task';

    // Fast-path 3: web/file/desktop markers imply acting on something even
    // without a verb match — "@web latest AI news", "the report in ~/Documents".
    if (/@web\b|https?:\/\/|[~/](?:Users|Desktop|Documents|Downloads|tmp)\b|\.(pdf|docx?|xlsx?|pptx?|csv|txt|md|png|jpe?g|zip)\b/i.test(text)) {
      return 'task';
    }

    // Fast-path 4: pure question shape with no file/web/desktop markers is a
    // conversational ask ("why is the sky blue?", "what's a good name for…").
    // The markers were ruled out above, so answering in plain chat is safe —
    // and a rare miss self-corrects: the user rephrases with an action verb.
    if (/^(what|who|when|where|why|how|is|are|was|were|does|do|did|can you tell|could you explain|explain|tell me about)\b/i.test(text) && text.endsWith('?')) {
      return 'chat';
    }

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
    attachments?: Attachment[],
    modelOverride?: string,
  ): Promise<void> {
    const db = getDb();
    const runId = crypto.randomUUID();

    db.prepare(`UPDATE agent_states SET status='running' WHERE workflow_id=?`).run(workflowId);
    db.prepare(
      `INSERT INTO agent_runs (run_id, session_id, workflow_id, goal, model, status) VALUES (?,?,?,?,?, 'running')`
    ).run(runId, sessionId, workflowId, goal, modelOverride ?? this.activeModelName());

    this.emit('agent:workflowStart', workflowId);

    const projectId = this.getSessionProjectId(sessionId);
    const memoryBlock = getMemoryContext(projectId);
    const projectBlock = this.getSessionScopeBlock(sessionId);
    const envBlock = this.buildEnvironmentContext();
    // `@chat:`/`@memory:` references in the user's message → injected context.
    const mentionBlock = resolveMentionBlock(goal, sessionId);
    // Context Pack pinned memories (by-reference; '' when no pack).
    const packBlock = getPackContextBlock(sessionId);

    const messages: OpenAI.ChatCompletionMessageParam[] = [
      {
        role: 'system',
        content: `You are Artha, a friendly local-first AI assistant on the user's Mac. You can chat normally, and when asked you can act on their files, the web, documents, and desktop using real tools.

Right now you're just talking. Answer naturally and concisely in plain English — you do NOT need a tool for everything, and you must NEVER refuse merely because no tool fits. If the user wants you to actually DO something on their computer (organise files, fetch a page, make a document), invite them to ask and you'll take it from there.

${mentionBlock}${memoryBlock}${packBlock}${projectBlock}

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
    // Only forward live reasoning when the disclosure is on — when it's off the
    // renderer discards the event, so skip the IPC entirely. The model still
    // thinks (think:true is independent of this flag).
    const onReasoning = showReasoning
      ? (chunk: string) => {
          reasoningText += chunk;
          const now = Date.now();
          if (now - lastReasonEmit < 100) return;
          lastReasonEmit = now;
          this.emit('agent:reasoning', {
            steps: [{ phase: 'reasoning', content: reasoningText, context_score: 0 }],
            showReasoning,
          });
        }
      : undefined;
    try {
      const llm = getActiveLLMClient(modelOverride, 'synthesis');
      const result = await llm.streamComplete(
        messages,
        undefined, // no tools → tool_choice dropped → no tool-constrained refusal
        (tok) => { finalText += tok; this.emit('agent:token', tok); },
        () => this.cancelledWorkflows.has(workflowId),
        onReasoning,
      );
      // Flush any reasoning buffered since the last throttled emit so the final
      // thinking text is complete before the answer takes over the bubble.
      if (showReasoning && reasoningText) {
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
  respondToolApproval(approvalId: string, approved: boolean, scope?: 'once' | 'always'): void {
    const entry = this.toolApprovalResolvers.get(approvalId);
    if (!entry) return;
    // App-grant prompts read the chosen scope back via approvalScopes; tool
    // prompts turn 'always' into a standing grant (only when it was offered).
    if (approved && scope) this.approvalScopes.set(approvalId, scope);
    entry.resolve(approved, scope === 'always');
  }

  /** Emit a tool-approval request to the renderer and block until the user
   *  answers (or a safety timeout denies it). Used when a policy assigns a tool
   *  call the `confirm` tier. Defaults to DENY on timeout — a governance gate
   *  must fail closed. */
  private async requestToolApproval(req: {
    workflowId: string;
    sessionId: string;
    toolName: string;
    args: Record<string, unknown>;
    note: string;
    /** When set, the request and the answer are recorded as `interaction`
     *  run events (the stall watchdog pauses while one is pending), and the
     *  run id is stored on the unified interaction row. */
    runId?: string;
    /** Offer "Always allow (30 days)". Never for the always-confirm floor. */
    allowAlways?: boolean;
    appGrant?: ToolApprovalRequest['appGrant'];
    /** Receives the approvalId so a caller can read the chosen scope. */
    onId?: (approvalId: string) => void;
  }): Promise<boolean> {
    const approvalId = crypto.randomUUID();
    req.onId?.(approvalId);
    // App-grant prompts manage their own (per-app) grant; they never record a
    // generic tool grant from this path.
    const allowAlways = !!req.allowAlways && !req.appGrant && !isAlwaysConfirmTool(req.toolName);
    if (req.runId) recordRunEvent(req.runId, 'interaction', { phase: 'request', approvalId, toolName: req.toolName, note: req.note });
    const request: ToolApprovalRequest = {
      approvalId,
      workflowId: req.workflowId,
      sessionId: req.sessionId,
      toolName: req.toolName,
      argsPreview: JSON.stringify(req.args, null, 2).slice(0, 800),
      note: req.note,
      allowAlways,
      ...(req.appGrant ? { appGrant: req.appGrant } : {}),
    };
    this.emit('agent:toolApprovalRequest', request);
    // Unified frame (additive): record the confirm as an interaction so it
    // survives a renderer reload. The legacy resolver below stays the single
    // source of truth for the decision; a generic UI response is routed to it.
    // Only an explicit `approved: true` approves — anything else denies. The
    // generic channel never carries a scope, so it can never create a grant.
    const hub = getInteractionHub();
    hub.open(
      { id: approvalId, runId: req.runId ?? req.workflowId, workflowId: req.workflowId, kind: 'confirm', payload: { ...request } },
      (status, answer) => this.respondToolApproval(
        approvalId, status === 'answered' && (answer as { approved?: unknown } | null)?.approved === true,
      ),
    );
    let timedOut = false;
    return Promise.race([
      new Promise<boolean>(resolve => {
        this.toolApprovalResolvers.set(approvalId, {
          workflowId: req.workflowId,
          resolve: (approved, always) => {
            // "Always allow" records an expiring tool grant so the same tool
            // stops asking (bodhi/grants.ts). Only when offered and approved.
            if (approved && always && allowAlways) this.recordStandingGrant(req.sessionId, req.toolName);
            resolve(approved);
          },
        });
      }),
      new Promise<boolean>(resolve => setTimeout(() => { timedOut = true; resolve(false); }, 120_000)),
    ]).then(approved => {
      hub.settle(approvalId, timedOut ? 'expired' : approved ? 'answered' : 'declined', { approved });
      // Logging only — the decision itself (including fail-closed timeout) is unchanged.
      if (req.runId) recordRunEvent(req.runId, 'interaction', { phase: 'response', approvalId, approved });
      return approved;
    }).finally(() => {
      this.toolApprovalResolvers.delete(approvalId);
      // Only app-grant callers read the scope back (requestAppGrant); drop it
      // for every other prompt so the map can't grow.
      if (!req.appGrant) this.approvalScopes.delete(approvalId);
    });
  }

  /** Grant subjects that apply to a run in this session, most specific first.
   *  LAN runs get none — a teammate's request never rides the host's grants. */
  private grantSubjects(sessionId: string, lan: boolean): string[] {
    if (lan) return [];
    const subjects = [`session:${sessionId}`];
    const projectId = this.getSessionProjectId(sessionId);
    if (projectId) subjects.push(`project:${projectId}`);
    subjects.push('global');
    return subjects;
  }

  /** Persist an "Always allow (30 days)" answer as a tool grant, scoped to the
   *  chat's project when it has one, otherwise global. Never throws. */
  private recordStandingGrant(sessionId: string, toolName: string): void {
    if (isAlwaysConfirmTool(toolName)) return; // the floor is never granted from the modal
    try {
      const projectId = this.getSessionProjectId(sessionId);
      addGrant({
        scopeKind: 'tool',
        scopeValue: toolName,
        subject: projectId ? `project:${projectId}` : 'global',
        ttlSeconds: DEFAULT_GRANT_TTL_SECONDS,
      });
    } catch (err) {
      console.warn('[Artha] recording standing grant failed:', err);
    }
  }

  /** Ask "Allow Artha to control {App}?" through the existing tool-approval
   *  flow and map the answer to Once / Always / Deny. Timeout = Deny. */
  private async requestAppGrant(req: {
    workflowId: string; sessionId: string; toolName: string; args: Record<string, unknown>;
    appName: string; alwaysAllowed: boolean; alwaysConfirm: boolean;
  }): Promise<GrantAnswer> {
    let id = '';
    const approved = await this.requestToolApproval({
      workflowId: req.workflowId, sessionId: req.sessionId, toolName: req.toolName, args: req.args,
      note: req.alwaysConfirm
        ? `${req.appName} is sensitive (shell, settings or credentials), so Artha asks every time.`
        : `Allow Artha to control ${req.appName}?`,
      appGrant: { appName: req.appName, alwaysAllowed: req.alwaysAllowed, alwaysConfirm: req.alwaysConfirm },
      onId: (x) => { id = x; },
    });
    const scope = this.approvalScopes.get(id);
    this.approvalScopes.delete(id);
    if (!approved) return 'deny';
    return scope === 'always' && req.alwaysAllowed ? 'always' : 'once';
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

    // The original run's session may no longer exist — e.g. an ephemeral
    // sub-capability child session that was cleaned up after the sub-task
    // finished (those runs still surface in the Activity list). Forking would
    // create an orphan run and violate the agent_states → chat_sessions FK, so
    // bail gracefully and let the caller report it.
    const sessionExists = db.prepare(`SELECT 1 FROM chat_sessions WHERE session_id=?`).get(step.session_id);
    if (!sessionExists) return null;

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
    // Legacy boolean API — expressed as a review so both paths share one
    // implementation (and Reject is always recorded as cancelled-by-user).
    await this.reviewPlan(workflowId, { decision: approved ? 'accept' : 'reject' });
  }

  /** Persist + emit a plan that needs the user's review, and open its unified
   *  interaction. A UI response on the generic channel routes to reviewPlan(). */
  private pausePlanForReview(plan: AgentPlan): void {
    const db = getDb();
    db.prepare(`UPDATE agent_states SET status='awaiting_approval', plan_json=? WHERE workflow_id=?`)
      .run(JSON.stringify(plan.steps), plan.workflowId);
    const { interaction } = getInteractionHub().open(
      {
        runId: plan.workflowId,
        workflowId: plan.workflowId,
        kind: 'plan',
        payload: {
          workflowId: plan.workflowId, sessionId: plan.sessionId, goal: plan.goal,
          steps: plan.steps, requiresApproval: plan.requiresApproval,
          blastRadius: plan.blastRadius, revisions: plan.revisions ?? 0,
        },
      },
      (status, answer) => {
        const review: PlanReview = status === 'answered' && answer && typeof answer === 'object'
          ? answer as PlanReview
          : { decision: 'reject', reason: 'dismissed' };
        void this.reviewPlan(plan.workflowId, review).catch(err => console.error('[Artha] plan review failed:', err));
      },
    );
    plan.interactionId = interaction.id;
    // The session's chat turn stays "active" for the outbox until reviewPlan()
    // settles it (accept → after execution; reject → paused, never drained).
    this.awaitingPlanApproval.add(plan.workflowId);
    this.emit('agent:planReady', plan);
  }

  /** Apply the user's plan review: Accept runs it; Accept with comments sends
   *  the step comments to the planner for ONE revision and asks again (later
   *  comments ride along into execution); Reject ends the run as
   *  cancelled-by-user — never completed. Decision logic: agent/planReview.ts. */
  async reviewPlan(workflowId: string, review: PlanReview): Promise<void> {
    const plan = this.activePlans.get(workflowId);
    if (!plan) return;
    // Only a turn parked on the approval card is settled for the outbox here.
    // (A revision re-parks it via pausePlanForReview.)
    const parked = this.awaitingPlanApproval.delete(workflowId);
    const hub = getInteractionHub();
    const action = decidePlanReview(review, { goal: plan.goal, steps: plan.steps, revisions: plan.revisions ?? 0 });
    if (plan.interactionId) {
      hub.settle(plan.interactionId, action.kind === 'cancel' ? 'declined' : 'answered', review);
      plan.interactionId = undefined;
    }

    if (action.kind === 'cancel') {
      this.activePlans.delete(workflowId);
      // Honest terminal state: the user stopped this run. No agent_runs row
      // exists yet (execution never started), so agent_states carries it.
      try {
        getDb().prepare(`UPDATE agent_states SET status=?, context_json=json_set(COALESCE(context_json,'{}'), '$.cancelReason', ?) WHERE workflow_id=?`)
          .run(action.status, action.reason || 'rejected by user', workflowId);
      } catch (err) {
        console.warn('[Artha] recording plan rejection failed:', err);
      }
      this.emit('agent:token', `\n\n_Plan cancelled by user${action.reason ? `: ${action.reason}` : '.'}_`);
      this.emit('agent:streamEnd');
      // Rejecting the plan is a user cancel: the queue pauses, never drains.
      if (parked) {
        this.userStoppedSessions.add(plan.sessionId);
        this.finishOutboxTurn(workflowId, plan.sessionId);
      }
      return;
    }

    if (action.kind === 'revise') {
      this.emit('agent:status', 'Revising the plan with your comments…');
      let revised: AgentPlan;
      try {
        const history = this.getSessionHistory(plan.sessionId, plan.goal);
        revised = await this.generatePlan(workflowId, plan.sessionId, action.revisionPrompt, history, plan.skill);
      } catch (err) {
        // Planner failed: do not silently run the un-revised plan — ask again
        // with the original steps so the user decides.
        console.warn('[Artha] plan revision failed:', err);
        revised = { ...plan };
      }
      const next: AgentPlan = {
        ...plan,
        steps: revised.steps.length ? revised.steps : plan.steps,
        blastRadius: revised.steps.length ? revised.blastRadius : plan.blastRadius,
        // Keep the user's own goal (not the revision instruction) for execution.
        goal: plan.goal,
        requiresApproval: true,
        revisions: (plan.revisions ?? 0) + 1,
        interactionId: undefined,
      };
      this.activePlans.set(workflowId, next);
      this.pausePlanForReview(next);
      return;
    }

    // The user approved THIS plan — plan mode unlocks changes for it.
    this.userApprovedWorkflows.add(workflowId);
    plan.reviewNotes = action.reviewNotes;
    try {
      await this.executePlan(plan);
    } finally {
      if (parked) this.finishOutboxTurn(workflowId, plan.sessionId);
    }
  }

  /** Called when user hits the Stop button in the UI. */
  cancelWorkflow(workflowId: string): void {
    this.cancelledWorkflows.add(workflowId);
    // Unified frame: decline any pending ask_user card (and any other pending
    // interaction) of this workflow so the awaiting call unblocks now.
    getInteractionHub().declineForWorkflow(workflowId);
    // Remembered until the chat turn ends so the outbox pauses ("Queue paused
    // after cancel") instead of auto-sending the next queued message.
    const stoppedSession = this.workflowSessions.get(workflowId) ?? this.sessionOfWorkflow(workflowId);
    // Only while that session's turn is live — a late Stop after the turn
    // ended must not pause the NEXT turn's queue.
    if (stoppedSession && this.outbox.isActive(stoppedSession)) this.userStoppedSessions.add(stoppedSession);
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
    // Lets cancelWorkflow(fan-out id) find the session for the outbox pause.
    this.workflowSessions.set(workflowId, sessionId);

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
    this.workflowSessions.delete(workflowId);

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
  /** The default user's settings_json, {} on any failure. */
  private userSettings(): Record<string, unknown> {
    try {
      const row = getDb().prepare(`SELECT settings_json FROM users WHERE user_id='default'`).get() as { settings_json: string } | undefined;
      return JSON.parse(row?.settings_json ?? '{}');
    } catch { return {}; }
  }

  /** MCP servers that produced a successful call in a session — the tool
   *  budget keeps offering them for the rest of that chat. */
  private mcpUsedBySession = new Map<string, Set<string>>();

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
    // Plan against the same budgeted tool set the executor will be offered
    // (mcp/toolBudget.ts), so a plan never names a withheld MCP tool.
    const budgeted = selectToolsForRun({
      builtIn: this.registry.getBuiltInToolSchemas(),
      servers: this.registry.getMcpServerTools(),
      goal,
      recentlyUsed: this.mcpUsedBySession.get(sessionId) ?? new Set<string>(),
      allowlist: effectiveAllowedTools(skill),
    }).tools;
    const tools = this.skills.filterTools(budgeted, skill ?? null);

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
    // Model precedence: explicit per-run override (cloud escalation / fork) →
    // skill pin → active model. Record the model that will ACTUALLY run so the
    // per-skill model breakdown and the run's audit row are honest. A stale
    // skill pin (model uninstalled) resolves to null and falls back.
    const pinnedModel = this.resolvePinnedModel(plan.skill?.pinnedModel);
    const model = plan.modelOverride || pinnedModel
      || resolveRunModel(undefined, opts.taskType ?? 'agent') || this.activeModelName();
    // Tell the header chip which model is doing the work and why, so an
    // automatic switch (e.g. 72B pick → 14B agent) is visible, never silent.
    if (!opts.silent && !plan.modelOverride && !pinnedModel) {
      try {
        const route = resolveAgentRoute(db);
        this.emit('agent:modelRouted', route);
        // Routing had to settle for a fallback or a weak stand-in: have the
        // provisioner install the tier default in the background so the NEXT
        // run is fast. This run proceeds on what is installed now.
        if (route.source === 'user-fallback' || route.source === 'auto') {
          void ensureAgentModel({ emit: (c, p) => this.emit(c, p), notify: sendNotification });
        }
      } catch { /* chip is informational */ }
    }
    const planStartMs = Date.now();

    db.prepare(`UPDATE agent_states SET status='running' WHERE workflow_id=?`)
      .run(plan.workflowId);
    // OR IGNORE: a non-blocking start has already inserted this row.
    db.prepare(`
      INSERT OR IGNORE INTO agent_runs (run_id, session_id, workflow_id, goal, model, status)
      VALUES (?, ?, ?, ?, ?, 'running')
    `).run(runId, plan.sessionId, plan.workflowId, plan.goal, model);
    // Run event log: the plan this run executes is the first entry of its
    // replayable timeline (agent/runEvents.ts).
    recordRunEvent(runId, 'plan', { goal: plan.goal, steps: plan.steps, model });

    // Silent runs (e.g. Delegate) must not drive the Chat surface's working UI.
    if (!opts.silent) this.emit('agent:workflowStart', plan.workflowId);

    const history = this.getSessionHistory(plan.sessionId, plan.goal);
    const destHint = this.extractDestination(plan.goal, homeDir);
    const skill = plan.skill ?? null;
    const skillBlock = skill
      ? `ACTIVE SKILL — "${skill.name}". This is your operating playbook for this task; follow it:\n${skill.instructions}\n\n`
      : '';
    const projectId = this.getSessionProjectId(plan.sessionId);
    const memoryBlock = getMemoryContext(projectId);
    const projectBlock = this.getSessionScopeBlock(plan.sessionId);
    const envBlock = this.buildEnvironmentContext();
    // `@chat:`/`@memory:` references in the user's message → injected context.
    const mentionBlock = resolveMentionBlock(plan.goal, plan.sessionId);
    // Context Pack pinned memories (by-reference; '' when no pack).
    const packBlock = getPackContextBlock(plan.sessionId);
    // Step comments the user approved the plan with (agent/planReview.ts).
    const reviewBlock = plan.reviewNotes ? `${plan.reviewNotes}\n\n` : '';

    const messages: OpenAI.ChatCompletionMessageParam[] = [
      {
        role: 'system',
        content: `You are Artha, a local AI agent on a Mac. You have real filesystem tools AND a real browser, and you ACT. On every task you reach the goal by CALLING TOOLS — never by describing what the user could do, and never by writing out the steps you "would" take.

When the user asks you to move, organise, rename, create, or delete files, you DO it by calling tools — you NEVER just list a folder and then describe it or ask what to do next. Listing a directory (fs_list_directory) is only the FIRST step to see what's there; you must IMMEDIATELY continue calling tools to perform the actual task, and keep going until it is fully done and verified. Do not summarise the folder contents back to the user instead of acting.

The SAME act-don't-describe rule governs the browser. When the user asks you to do something on a website — send an email, fill or submit a form, post, reply, book, search-then-click — you DO it by calling browser_* tools, not by explaining how. The pattern is: browser_navigate to the page → browser_read_dom to see the actual fields/buttons → browser_type into each field → browser_click the send/submit control → browser_read_dom (or browser_get_url) to CONFIRM it actually happened (e.g. a "Message sent" confirmation). Keep calling browser tools until the action is genuinely completed and verified. NEVER stop and tell the user how they could do it themselves, and never claim you sent/submitted something unless a browser tool call actually did it. The only reason to pause is a genuine login, captcha, or 2FA wall — and for that you call browser_request_user, you do not give up or narrate.

Only write a plain-English reply once the task is COMPLETE (or you are genuinely blocked and must ask one specific question).

${mentionBlock}${memoryBlock}${packBlock}${skillBlock}${reviewBlock}${projectBlock}

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

    // Skills dashboard ledger: one row per skill invocation, with its outcome
    // and the tool work it did. Recorded in a `finally` so a run that THROWS
    // (rather than returning with a terminal status) is still counted — it reads
    // the run's status from agent_runs, which a crashed run leaves as 'running',
    // and maps anything non-terminal to 'error'. The finally never swallows the
    // original error (recordSkillInvocation is itself best-effort), so callers
    // see the same throw as before.
    try {
      await this.runReactLoop({
        workflowId: plan.workflowId,
        runId,
        sessionId: plan.sessionId,
        goal: plan.goal,
        messages,
        skill,
        // Explicit escalation/fork override beats the skill pin; undefined
        // falls through to the router.
        modelOverride: plan.modelOverride ?? pinnedModel ?? undefined,
        startMs: planStartMs,
        silent: opts.silent,
        taskType: opts.taskType,
      });
    } finally {
      if (skill) this.recordSkillInvocation(skill, plan.matchedVia ?? 'auto', runId, plan.sessionId, plan.goal, planStartMs);
    }

    // Phase 3: refresh the project's rolling cross-session memory in the
    // background so a future chat in this project starts already aware of what
    // happened here. Best-effort; never blocks or fails the run.
    if (projectId) void this.updateProjectSummary(projectId, plan.sessionId);

    return runId;
  }

  /** Write one `skill_runs` row summarising a finished skill invocation. Reads
   *  the run's terminal status from agent_runs and counts the tool calls/errors
   *  it logged in tool_receipts, so the dashboard reflects what actually
   *  happened. Strictly best-effort — never throws into the run path. */
  private recordSkillInvocation(
    skill: ActiveSkill,
    matchedVia: SkillMatchedVia,
    runId: string,
    sessionId: string,
    goal: string,
    startMs: number
  ): void {
    try {
      const db = getDb();
      // Only record runs of REAL skills (rows in the skills table). Synthetic
      // ActiveSkills that aren't persisted — notably the Delegate operator
      // (slug 'delegate-operator', built per-run by buildOperatorSkill) — must
      // NOT enter the per-skill ledger: their skill_id has no skills row, so the
      // dashboard (which joins FROM skills) would never show them and they'd just
      // accumulate as orphans. The operator isn't a dashboard skill; skip it.
      const skillRow = this.skills.getBySlug(skill.slug);
      if (!skillRow) return;

      const run = db.prepare(`SELECT status FROM agent_runs WHERE run_id=?`)
        .get(runId) as { status: string } | undefined;
      const status: SkillRunStatus =
        run?.status === 'completed' ? 'ok' :
        run?.status === 'cancelled' ? 'cancelled' : 'error';

      const tally = db.prepare(
        `SELECT COUNT(*) AS calls, COALESCE(SUM(status='error'), 0) AS errors
         FROM tool_receipts WHERE run_id=?`
      ).get(runId) as { calls: number; errors: number } | undefined;

      const skillId = skillRow.skill_id;
      recordSkillRun({
        skillId,
        slug: skill.slug,
        runId,
        sessionId,
        goal,
        status,
        matchedVia,
        toolCalls: tally?.calls ?? 0,
        toolErrors: tally?.errors ?? 0,
        durationMs: Date.now() - startMs,
      });
    } catch (err) {
      console.warn('[Artha] recordSkillInvocation failed (non-critical):', err);
    }
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
      matchedVia: 'invoke',
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
      matchedVia: 'invoke',
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
  /** Run-event-log wrapper around the ReAct loop body: registers the run as
   *  active, runs the 10 s heartbeat / 60 s stall watchdog for its lifetime,
   *  records an `error` event if the body throws, holds the keep-awake
   *  blocker (when the user enabled it) and registers with the global kill
   *  switch (the stop hotkey is held only while some run is active, and a
   *  press cancels this run through the same path as the chat's Stop button).
   *  Everything is released in `finally`. Only bookkeeping — the loop's own
   *  status / verification logic lives untouched in the body. */
  private async runReactLoop(args: Parameters<AgentOrchestrator['runReactLoopBody']>[0]): Promise<void> {
    markRunActive({ runId: args.runId, workflowId: args.workflowId, sessionId: args.sessionId });
    // Tell the renderer which run backs this workflow so it can resubscribe
    // to the run's event log from its last seq after a reload.
    if (!args.silent) this.emit('run:started', { runId: args.runId, workflowId: args.workflowId, sessionId: args.sessionId });
    const stopMonitor = startRunMonitor(args.runId);
    const awake = noteRunStarted(args.runId);
    try {
      const s = JSON.parse((getDb().prepare(`SELECT settings_json FROM users WHERE user_id='default'`).get() as { settings_json?: string } | undefined)?.settings_json ?? '{}');
      if (typeof s.desktop_stop_shortcut === 'string' && s.desktop_stop_shortcut) getKillSwitch()?.setAccelerator(s.desktop_stop_shortcut);
    } catch { /* settings are optional */ }
    const untrack = trackRun({
      workflowId: args.workflowId, runId: args.runId, sessionId: args.sessionId,
      // Only the global kill switch calls this (the chat Stop button goes
      // straight to cancelWorkflow), so record it in the run event log.
      cancel: () => {
        recordRunEvent(args.runId, 'status', { source: 'kill_switch', reason: 'stopped_by_user' });
        this.cancelWorkflow(args.workflowId);
      },
    });
    try {
      await this.runReactLoopBody(args);
    } catch (err) {
      recordRunEvent(args.runId, 'error', { message: err instanceof Error ? err.message : String(err) });
      throw err;
    } finally {
      untrack();
      noteRunEnded(awake);
      stopMonitor();
      markRunInactive(args.runId);
    }
  }

  private async runReactLoopBody(args: {
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
    // The act loop is the 'agent' role unless the caller asked for another
    // phase's routing (e.g. a tool_args-typed capability run).
    const loopTask: TaskType = args.taskType ?? 'agent';
    // `let`: escalation (agent/escalation.ts) may switch the model mid-run.
    let llm = getActiveLLMClient(args.modelOverride, loopTask);
    let loopModel = resolveRunModel(args.modelOverride, loopTask);
    // Renderer-facing emit gate. Silent child loops still persist to SQLite.
    const emit = (channel: string, data?: unknown): void => {
      // Run event log: mirror lifecycle channels (status / tool call / tool
      // result) into the persisted timeline — silent child loops included.
      const runEv = runEventFromChannel(channel, data);
      if (runEv) recordRunEvent(args.runId, runEv.kind, runEv.payload);
      if (!args.silent) this.emit(channel, data);
    };

    const depth = args.depth ?? 0;
    // Effective tool scope for THIS loop = parent's scope ∩ this skill's allowlist
    // (empty allowlist = all tools). This is what enforces permission monotonicity
    // for composed sub-capabilities; a top-level run has no parent so it's just
    // the skill's own allowlist.
    // Advisory (auto-matched / default) skills contribute NO filter — see
    // SkillToolScope. Only explicitly invoked skills restrict the tool set.
    const ownAllowed = effectiveAllowedTools(args.skill);
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
    // MCP tools are offered by relevance (mcp/toolBudget.ts): built-ins always,
    // a server's tools when the goal names it / it already worked in this chat /
    // the skill allowlists it. A discarded turn restores the full set (below).
    const budget = selectToolsForRun({
      builtIn: this.registry.getBuiltInToolSchemas(),
      servers: this.registry.getMcpServerTools(),
      goal: args.goal,
      recentlyUsed: this.mcpUsedBySession.get(args.sessionId) ?? new Set<string>(),
      allowlist: effectiveAllowed,
    });
    const toolsPruned = budget.withheld.some(w => w.reason === 'irrelevant');
    let toolsRestored = false;
    let modelEscalated = false;
    const extraTools = [
      ...MEMORY_TOOL_SCHEMAS,
      // Structured mid-run questions (agent/askUser.ts). Offered everywhere —
      // unattended runs get an immediate fail-closed "unanswered" result.
      ASK_USER_TOOL_SCHEMA,
      // Desktop control (mouse/keyboard/screenshot) is opt-in and dangerous, so
      // it's only offered to the model when the user has enabled it in Settings.
      ...(this.desktopControlEnabled() ? DESKTOP_TOOL_SCHEMAS : []),
      // Composable sub-capabilities — let this run delegate a self-contained
      // step to a trusted, pre-scoped capability (bounded by depth + scope).
      ...(mayDelegate ? getSubcapabilityToolSchemas() : []),
      // Persistent goals (bodhi/goals.ts) are a top-level concern: a nested
      // capability works for its parent's goal and must not set its own.
      ...(depth === 0 ? GOAL_TOOL_SCHEMAS : []),
    ];
    let tools = [...filterToolsByAllowlist(budget.tools, effectiveAllowed), ...extraTools];
    const fullTools = [...filterToolsByAllowlist(budget.full, effectiveAllowed), ...extraTools];

    const messages = args.messages;
    const mutations: TrackedMutation[] = [];
    // Verify-before-claim tallies: every executed tool call, and how many of
    // them errored. When ALL of a run's tool calls failed, the final prose is
    // annotated deterministically — the model cannot talk its way past it.
    let toolCallsTotal = 0;
    let toolCallErrors = 0;
    // Blocked calls are NOT failures of the tool — they are policy refusals
    // (unattended runs auto-block confirm-tier tools). Counted separately so a
    // scheduled run that was blocked can say so instead of reporting success.
    let toolCallsBlocked = 0;
    // Sanitized, bounded per-call evidence for the independent goal check
    // (bodhi/goalEvaluator.ts). Short summaries only — never raw payloads.
    const goalEvidence: Array<Omit<EvaluatorEvidence, 'id'>> = [];
    const MAX_GOAL_EVIDENCE = 30;
    // Stop-gate feedback rounds already spent on an unmet goal this run.
    let goalRounds = 0;
    /** Which terminal path the loop actually took — drives the end-of-run
     *  notification so it can never claim completion for a stopped run. */
    let terminalOutcome: 'succeeded' | 'failed' | 'timed_out' | 'cancelled' | 'interrupted' = 'interrupted';
    const reasoningSteps: ReasoningStep[] = [];
    // Resolved once for the whole loop: showReasoningEnabled() hits SQLite, so it
    // must not be called per token inside the throttled onReasoning callback.
    const showReasoning = this.showReasoningEnabled();
    const persistStep = this.makeStepRecorder(args.runId);
    // Every agent_steps row also lands in the run event log as a lightweight
    // `step` marker (tool calls/results carry their own detailed events).
    // Returns the persisted step_id (used for file checkpoints / rewind).
    const recordStep: typeof persistStep = (idx, kind, payload, snapshot) => {
      const stepId = persistStep(idx, kind, payload, snapshot);
      recordRunEvent(args.runId, 'step', { idx, kind, stepId });
      return stepId;
    };
    let stepIdx = 0;

    // Begin collecting citations for any web_fetch / web_search calls the
    // model makes inside this loop. Drained + emitted at the final response.
    // Capture the previously-active token so a NESTED loop (a sub-capability)
    // restores the parent's token on exit instead of clobbering it to null.
    const prevCitationToken = getActiveCitationToken();
    startCitationCollection(args.workflowId);
    setActiveCitationToken(args.workflowId);

    recordStep(stepIdx++, 'system', {
      note: 'loop start', model: loopModel ?? this.activeModelName(),
      tools: tools.length, toolsWithheld: budget.withheld,
    }, messages);

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
          emit('agent:reasoning', { steps: reasoningSteps, showReasoning });
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

    // Permission mode for this run (agent/modes.ts). A LAN or scheduled run is
    // always 'unattended', whatever the chat's stored mode says.
    const gateRc = getRunContext();
    // One rule for "nobody can answer a prompt" (agent/runContext.ts): LAN and
    // every scheduler trigger. Unattended runs fail closed on asks.
    const gateUnattended = confirmTierMustFailClosed(gateRc);
    const permissionMode = resolveEffectiveMode(
      getSessionMode(args.sessionId),
      this.userSettings().autonomousActions as boolean | undefined,
      gateRc,
    );
    const grantSubjects = this.grantSubjects(args.sessionId, !!gateRc?.lan);
    const rootPaths = (allowedRoots ?? []).map(r => r.path);
    const fsCtx: ToolContext = {
      allowedRoots,
      primaryDir: getSessionPrimaryFolder(args.sessionId),
      ragIndexIds: getSessionRagIndexIds(args.sessionId),
      // Scope CRM/KG writes to the session's project, like memory.
      projectId: this.getSessionProjectId(args.sessionId),
      // Run identity for consequential-action logging (email_send writes its
      // external_actions row against this run so sendWasConfirmed() can see it).
      runId: args.runId,
    };

    let finalEmitted = false;

    // For a SEND-email goal, steer the model to the one reliable tool up front.
    // Small local models otherwise try to hand-drive Gmail's DOM (browser_click
    // on Compose), which times out. If they ignore this, the deterministic
    // rescue at the terminal still finishes the job.
    if (detectsSendIntent(args.goal)) {
      messages.push({
        role: 'system',
        content:
          'This task is to SEND an email. Do it in ONE step: call the email_send tool with ' +
          '"to", "subject" and "body". It delivers the message directly through the user\'s Gmail. ' +
          'Do NOT use browser_navigate or browser_click to open Gmail or click Compose — Gmail\'s ' +
          'interface will not respond to automated clicks and you will fail. Just call email_send.',
      });
    }

    // Backstop for the "narrates instead of acting" failure mode on browser
    // tasks: count browser_* tool calls and how many times we've nudged the
    // model to actually act. When the model tries to finalise with plain prose
    // on a clear web-action request WITHOUT ever having driven the browser, we
    // inject one corrective turn and keep looping instead of accepting the
    // narration. Bounded by MAX_ACT_NUDGES so a genuinely-stuck model still ends.
    let browserToolCalls = 0;
    // Same tally for the filesystem — a file goal that never called fs_* and
    // never mutated is narration, not completion (see shouldNudgeToAct).
    let fsToolCalls = 0;
    let actNudges = 0;
    const MAX_ACT_NUDGES = 2;
    // Send-completion guard: a "send an email" goal is only satisfied by a
    // CONFIRMED send (an external_actions row), never by a draft. Tracks nudges
    // that push the model from email_compose → email_send.
    let sendNudges = 0;
    const MAX_SEND_NUDGES = 2;
    const sendWasConfirmed = (): boolean => {
      // Evidence 1: a confirmed external_action row for this run.
      try {
        const row = db.prepare(
          `SELECT COUNT(*) AS n FROM external_actions WHERE run_id=? AND category='send' AND state='confirmed'`
        ).get(args.runId) as { n: number } | undefined;
        if ((row?.n ?? 0) > 0) return true;
      } catch { /* fall through to tool-result evidence */ }
      // Evidence 2: the email_send tool itself returned sent:true this run. This
      // is the authoritative signal and does NOT depend on external_actions
      // run-id scoping — so a successful send is never re-sent or mis-reported
      // as failed just because its audit row wasn't run-scoped.
      return mutations.some(m => {
        if (m.tool !== 'email_send') return false;
        try { return (JSON.parse(m.result) as { sent?: boolean }).sent === true; } catch { return false; }
      });
    };

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
        terminalOutcome = 'cancelled';
        persistRunFacts(db, args.runId, {
          outcome: 'cancelled', toolCallsTotal, toolCallsFailed: toolCallErrors,
          toolCallsBlocked, mutationsTotal: mutations.length,
          mutationsFailed: mutations.filter(m => !m.success).length,
          errorDetail: 'cancelled_by_user',
        });
        break;
      }

      // Outbox "steer now": at a tool-call boundary (between iterations) of a
      // top-level visible run, inject any messages the user asked to steer
      // with. Never on the first iteration (nothing has happened yet; the drain
      // covers that) and never past a pending approval (the driver checks).
      if (iterations > 1 && !args.silent && depth === 0) {
        try {
          const steered = injectSteerAtBoundary(this.outbox, args.sessionId, messages);
          if (steered.length) {
            recordStep(stepIdx++, 'user', { steer: steered.map(i => ({ id: i.id, content: i.content })) });
            emit('agent:status', 'Taking your new message into account…');
          }
        } catch (err) {
          console.warn('[Artha] outbox steer injection failed (continuing):', err);
        }
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
      // Only forward live reasoning when the user has the disclosure on — saves
      // an IPC message per ~100ms that the renderer would otherwise discard. The
      // model still thinks (think:true is independent); we just don't ship it.
      const onReasoning = showReasoning
        ? (chunk: string) => {
            turnReasoning += chunk;
            const now = Date.now();
            if (now - lastReasonEmit < 100) return;
            lastReasonEmit = now;
            emit('agent:reasoning', {
              steps: [...reasoningSteps, { phase: 'reasoning', content: turnReasoning, context_score: 0 }],
              showReasoning,
            });
          }
        : undefined;
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
        terminalOutcome = 'failed';
        persistRunFacts(db, args.runId, {
          outcome: 'failed', toolCallsTotal, toolCallsFailed: toolCallErrors,
          toolCallsBlocked, mutationsTotal: mutations.length,
          mutationsFailed: mutations.filter(m => !m.success).length,
          errorDetail: m.slice(0, 200),
        });
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
          if (toolCall.function.name.startsWith('fs_')) fsToolCalls++;
          if (toolCall.function.name === 'browser_read_dom') readDomCallIds.add(toolCall.id);
          emit('agent:toolCall', {
            type: 'tool_invoke',
            name: toolCall.function.name,
            args: toolCall.function.arguments,
          });
          const toolStepIdx = stepIdx++;
          const toolStepId = recordStep(toolStepIdx, 'tool_call', {
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
          // Permission-mode gate (agent/modes.ts). Order: forbid > always-
          // confirm floor (email_send) > dry_run > mode rules > active grant >
          // the policy tier. It never returns 'ask' for an unattended run —
          // that becomes 'block', so nothing hangs on a modal nobody sees.
          const gate = await decideToolCall({
            toolName: toolCall.function.name,
            args: parsedArgs,
            mode: permissionMode,
            policy: decision,
            isFloor: isAlwaysConfirmTool(toolCall.function.name),
            attended: !gateUnattended,
            roots: rootPaths,
            planApproved: this.userApprovedWorkflows.has(args.workflowId),
            subjects: grantSubjects,
            connector: this.registry.serverForTool(toolCall.function.name)?.id,
            grants: getGrantStore(),
          });
          let receiptStatus: ReceiptStatus = 'ok';
          /** Overrides the receipt's generic effect text when we know better
           *  (e.g. a desktop action skipped for lack of an app grant). */
          let receiptEffect: string | undefined;
          let policyHandled = false;
          if (gate.action === 'block' && gate.source === 'policy-forbid') {
            toolResult = `Error: Blocked by your tool policy${decision.matchedPattern ? ` (rule "${decision.matchedPattern}")` : ''} — this call was not executed.${decision.note ? ` ${decision.note}` : ''}`;
            toolStatus = 'error'; receiptStatus = 'blocked'; policyHandled = true;
          } else if (gate.action === 'dry_run') {
            toolResult = `Dry run (policy): would call ${toolCall.function.name} with ${JSON.stringify(parsedArgs)}. It was NOT executed — describe this to the user as a preview of what would happen.`;
            receiptStatus = 'skipped'; policyHandled = true;
          } else if (gate.action === 'block') {
            // Mode block (e.g. plan mode before approval) or an ask that nobody
            // can answer (unattended). Not executed; the model is told why so
            // the run reports it instead of claiming the step happened.
            toolResult = `Error: ${toolCall.function.name} was not executed — ${gate.reason}`;
            toolStatus = 'error'; receiptStatus = 'blocked'; policyHandled = true;
          } else if (gate.action === 'ask') {
            // Confirm needs a human to answer; decideToolCall already turned
            // asks on unattended runs (LAN / scheduled) into blocks. NOTE:
            // `silent` does NOT mean unattended — Delegate runs are silent but
            // a desktop user approves via the app-level ToolApprovalModal.
            const approved = await this.requestToolApproval({
              workflowId: args.workflowId, sessionId: args.sessionId,
              toolName: toolCall.function.name, args: parsedArgs,
              note: decision.note || gate.reason,
              allowAlways: gate.source !== 'floor',
              runId: args.runId,
            });
            if (!approved) {
              toolResult = `Error: The user declined this action (${toolCall.function.name}). Do not retry it — continue with the rest of the task, or ask how they'd like to proceed.`;
              toolStatus = 'error'; receiptStatus = 'blocked'; policyHandled = true;
            }
            // approved → fall through to normal execution below.
          } else if (gate.source === 'grant') {
            emit('agent:status', gate.reason);
          }

          if (!policyHandled) {
          try {
            if (toolCall.function.name === ASK_USER_TOOL_NAME) {
              // Resolves THIS tool call with the user's answers (no new turn).
              const rcAsk = getRunContext();
              toolResult = await runAskUser(parsedArgs, {
                unattended: !!rcAsk?.lan || !!rcAsk?.unattended,
                runId: args.runId, workflowId: args.workflowId, sessionId: args.sessionId,
                hub: getInteractionHub(),
              });
            } else if (isMemoryTool(toolCall.function.name)) {
              toolResult = invokeMemoryTool(toolCall.function.name, parsedArgs, args.sessionId);
            } else if (isDesktopTool(toolCall.function.name)) {
              // Per-app grant: resolve the app this action lands in and make
              // sure the user has allowed Artha to control it (Once / Always
              // for this project / Deny). Unattended runs skip and report.
              const rcDesk = getRunContext();
              const deskGate = await gateDesktopAction({
                store: this.appGrants,
                resolveApp: resolveDesktopTargetApp,
                confirm: (q) => this.requestAppGrant({
                  workflowId: args.workflowId, sessionId: args.sessionId,
                  toolName: toolCall.function.name, args: parsedArgs,
                  appName: q.appName, alwaysAllowed: q.alwaysAllowed,
                  alwaysConfirm: q.reason === 'always_confirm',
                }),
                nowSec: () => Math.floor(Date.now() / 1000),
              }, {
                toolName: toolCall.function.name, args: parsedArgs,
                sessionId: args.sessionId, projectId: this.getSessionProjectId(args.sessionId),
                unattended: !!rcDesk?.lan || !!rcDesk?.unattended,
              });
              if (!deskGate.proceed) {
                toolResult = deskGate.message;
                toolStatus = 'error';
                receiptStatus = deskGate.status;
                receiptEffect = deskGate.status === 'skipped'
                  ? `Skipped — ${deskGate.appName} not approved for desktop control (unattended run)`
                  : `Blocked — user did not allow control of ${deskGate.appName}`;
                // An unattended skip is a refusal, not a tool failure: count it
                // with blocked calls so the run's honest status says so.
                if (deskGate.status === 'skipped') toolCallsBlocked++;
              } else if (isCancelled()) {
                // Stop arrived while the grant prompt was open — don't act.
                toolResult = 'Error: stopped_by_user — the user stopped Artha before this desktop action ran.';
                toolStatus = 'error'; receiptStatus = 'blocked'; receiptEffect = 'Stopped by user — not executed.';
              } else {
                // Artha is about to drive the REAL cursor/keyboard — paint the
                // full-screen "Artha is in control" overlay so the takeover is
                // obvious. Auto-hides shortly after the last desktop action.
                noteDesktopControlActive();
                toolResult = await invokeDesktopTool(toolCall.function.name, parsedArgs);
              }
            } else if (isGoalTool(toolCall.function.name)) {
              // goal_set / goal_update — persisted goal state; goal_set may
              // pause for the user's approval (see invokeGoalTool).
              toolResult = await this.invokeGoalTool(toolCall.function.name, parsedArgs, {
                workflowId: args.workflowId, sessionId: args.sessionId, userGoal: args.goal,
              });
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
              // Per-call identity: durable undo + file checkpoints are
              // attributed to this exact step so a rewind can target it.
              toolResult = await this.registry.invokeTool(toolCall.function.name, parsedArgs, {
                ...fsCtx, sessionId: args.sessionId, stepId: toolStepId, stepIdx: toolStepIdx,
              });
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

          // Classify what the call ACTUALLY did by inspecting the result,
          // rather than trusting the `Error:` prose convention. This is
          // upstream of receipts, tallies, run facts, the verified summary
          // and skill success rates, so it is the one place worth getting
          // right (shipped-surface audit, top-5 item 1).
          const outcome = classifyToolResult(toolCall.function.name, toolResult, {
            thrown: toolStatus === 'error',
            blocked: receiptStatus === 'blocked',
          });
          // A partial batch is neither a clean success nor a clean failure;
          // reflect it in the status the UI and evidence chain both read.
          if (outcome.status !== 'succeeded') toolStatus = 'error';

          toolCallsTotal++;
          if (isFailure(outcome)) toolCallErrors++;
          if (outcome.status === 'succeeded') {
            const owner = this.registry.serverForTool(toolCall.function.name);
            if (owner) {
              const used = this.mcpUsedBySession.get(args.sessionId) ?? new Set<string>();
              used.add(owner.id);
              this.mcpUsedBySession.set(args.sessionId, used);
            }
          }
          if (receiptStatus === 'blocked') toolCallsBlocked++;
          if (depth === 0 && !isGoalTool(toolCall.function.name)) {
            goalEvidence.push({
              kind: 'tool_result',
              status: outcome.status,
              summary: `${toolCall.function.name}: ${toolResult.replace(/\s+/g, ' ').slice(0, 240)}`,
            });
            if (goalEvidence.length > MAX_GOAL_EVIDENCE) goalEvidence.shift();
          }

          // Anti-hallucination: only count a mutation as having happened when
          // it FULLY succeeded — blocked, dry-run and partial batches (e.g.
          // 1 of 50 files moved) must never be reported as done.
          if (MUTATION_TOOLS.has(toolCall.function.name)) {
            mutations.push({
              tool: toolCall.function.name,
              args: parsedArgs,
              result: toolResult,
              success: receiptStatus === 'ok' && countsAsCompletedMutation(outcome),
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
            effect: receiptEffect,
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
            // Model-facing copy is budgeted (see toolResultBudget.ts); the audit
            // log, receipts and the live UI above all keep the full result.
            content: clampToolResult(toolResult),
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
            // The status was computed three lines above and persisted to
            // agent_steps, but dropped here — so the live ExecutionLog
            // rendered EVERY result, including errors, with a green check
            // (audit C6). It travels now.
            status: toolStatus,
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
          fsToolCalls,
          mutationCount: mutations.length,
          nudges: actNudges,
          maxNudges: MAX_ACT_NUDGES,
          content: rawContent,
        })) {
          if (streamedLive) emit('agent:streamReset');
          actNudges++;
          const webNarrated = detectsWebAction(args.goal) && browserToolCalls === 0;
          const fsNames = tools.map(t => t.function.name).filter(n => n.startsWith('fs_')).join(', ');
          messages.push({
            role: 'system',
            content: webNarrated
              ? `You replied with words but did NOT call any browser tool, so nothing actually happened. ` +
                `The user asked you to act on a website ("${args.goal.slice(0, 200)}"). ` +
                `Do it now by calling tools — browser_navigate to the page, browser_read_dom to find the real ` +
                `fields and buttons, browser_type to fill them, browser_click to submit — and verify the result. ` +
                `Do not describe the steps; perform them. Only call browser_request_user if you hit a real login/captcha/2FA wall.`
              : `You replied with words but did NOT call any filesystem tool, so nothing actually happened on disk. ` +
                `The user asked you to act on their files ("${args.goal.slice(0, 200)}"). ` +
                `Do it now by calling tools${fsNames ? ` — available: ${fsNames}` : ''}: list the source folder, ` +
                `perform the move/copy/rename/delete, then list the destination to verify. ` +
                `Do not describe the steps; perform them. Ask a question only if a path is genuinely ambiguous.`,
          });
          recordStep(stepIdx++, 'system', { note: 'act-nudge', nudge: actNudges });
          emptyCount = 0;
          continue;
        }

        // Backstop: the goal was to SEND, but no send has been confirmed — the
        // model likely drafted (email_compose) and stopped. Push it to actually
        // send. This is what turns "drafted" into "delivered" instead of a
        // false completion.
        if (shouldNudgeToSend({
          goal: args.goal,
          sendConfirmed: sendWasConfirmed(),
          nudges: sendNudges,
          maxNudges: MAX_SEND_NUDGES,
          content: rawContent,
        })) {
          if (streamedLive) emit('agent:streamReset');
          sendNudges++;
          messages.push({
            role: 'system',
            content:
              `You have NOT sent the email yet. The user asked you to SEND it ` +
              `("${args.goal.slice(0, 160)}"). Call the email_send tool NOW with the recipient, ` +
              `subject and body — it actually delivers the message through the user's own Gmail in ` +
              `Artha's browser (they approve once, then it sends). Do not just describe it; call ` +
              `email_send. If it returns login_required, tell the user to sign in to Gmail in Artha's ` +
              `browser once, then it will work.`,
          });
          recordStep(stepIdx++, 'system', { note: 'send-nudge', nudge: sendNudges });
          emptyCount = 0;
          continue;
        }

        // ── Goal stop gate ─────────────────────────────────────────────────
        // A final answer is a CLAIM of completion. When this session has an
        // open goal, an independent evaluator decides from evidence whether
        // its condition is met (bodhi/goalEvaluator.ts): met → goal completed;
        // unmet → back to work with the gaps (bounded); otherwise the run ends
        // as "needs you" with the gaps listed. The model can't skip this.
        let goalNote: string | null = null;
        // A stopped run (chat Stop or the global kill switch) never reaches the
        // evaluator: stop/kill must never mark a goal completed. The run is
        // recorded as cancelled further down; the goal stays open.
        const stoppedNow = (): boolean => isCancelled() || wasStoppedByUser(args.workflowId);
        if (depth === 0 && !stoppedNow()) {
          const gate = await this.runGoalStopGate({
            runId: args.runId, sessionId: args.sessionId, goal: args.goal,
            finalAnswer: rawContent, mutations, goalEvidence, goalRounds,
            toolCallsTotal, toolCallErrors, actorModel: loopModel,
            stopped: stoppedNow,
          });
          if (gate) {
            recordRunEvent(args.runId, 'status', {
              source: 'goal_gate', action: gate.action, gaps: gate.gaps, round: goalRounds,
            });
          }
          if (gate?.action === 'continue' && gate.feedback) {
            if (streamedLive) emit('agent:streamReset');
            goalRounds++;
            messages.push({ role: 'system', content: gate.feedback });
            recordStep(stepIdx++, 'system', { note: 'goal-gate', action: 'continue', round: goalRounds, gaps: gate.gaps });
            emit('agent:status', 'Goal not met yet — continuing…');
            emptyCount = 0;
            continue;
          }
          if (gate) {
            recordStep(stepIdx++, 'system', { note: 'goal-gate', action: gate.action, gaps: gate.gaps });
            goalNote = gate.note;
          }
        }

        let finalText: string;

        if (mutations.length > 0) {
          // The user-facing text is a verified summary, not the model's prose.
          finalText = await this.generateVerifiedSummary(args.goal, mutations);
        } else {
          // (mutation-free path — annotated below if every tool call failed)
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

        // Verify-before-claim backstop: if the model called tools and EVERY
        // one of them failed (and nothing mutated — that path already gets the
        // verified summary), its prose cannot be trusted to admit it. Append a
        // deterministic caution derived from the tool tallies, not the model.
        if (mutations.length === 0 && toolCallsTotal > 0 && toolCallErrors === toolCallsTotal) {
          finalText = `${finalText}\n\n⚠️ Heads up: every tool call in this run failed (${toolCallErrors}/${toolCallsTotal}), so the answer above isn't grounded in real results. Treat it as unverified.`;
        }
        // A file-action goal that ends with NOTHING mutated is not done, however
        // confident the prose sounds. State that deterministically (the model's
        // text often reads like a completed task). Skipped when the model is
        // asking a genuine clarifying question.
        const fileGoalUnfulfilled =
          detectsFileAction(args.goal) && !detectsWebAction(args.goal) &&
          !mutations.some(m => m.success) && !rawContent.includes('?');
        if (fileGoalUnfulfilled) {
          finalText = `${finalText}\n\n⚠️ Nothing was changed on disk in this run — no file was moved, copied, created or deleted. The task is NOT complete.`;
        }

        // Send task: if no send was CONFIRMED (the model drafted, flailed on
        // Gmail's DOM, or narrated a fake "sent"), Artha finishes the job
        // deterministically — extract the fields and call email_send itself.
        let det: { sent: boolean; to: string | null; reason?: string } = { sent: false, to: null };
        if (detectsSendIntent(args.goal) && !sendWasConfirmed()) {
          det = await this.deterministicEmailSend(
            { goal: args.goal, workflowId: args.workflowId, sessionId: args.sessionId, runId: args.runId },
            recordStep, stepIdx++,
          );
        }
        // Recompute AFTER the deterministic attempt — email_send logs its own
        // confirmed external_action, so this reflects whether it actually sent.
        const sendUnfulfilled = detectsSendIntent(args.goal) && !sendWasConfirmed();
        if (!sendUnfulfilled && det.sent) {
          // Deterministic send succeeded — the model's prose is irrelevant now.
          finalText = `✅ Email sent${det.to ? ` to ${det.to}` : ''} through your Gmail (confirmed by Gmail's “Message sent”).`;
        } else if (sendUnfulfilled) {
          // Discard the model's prose (it often falsely claims "sent") and state
          // deterministically what happened.
          const triedToSend = det.to !== null || mutations.some(m => m.tool === 'email_send');
          finalText =
            `❌ The email was not sent — nothing was delivered.\n\n` +
            (det.reason === 'declined'
              ? `You declined the send, so nothing went out. `
              : triedToSend
                ? `I tried to send it but couldn't confirm delivery — this usually means you're not signed ` +
                  `in to Gmail in Artha's browser. `
                : `I couldn't determine the recipient to send to. `) +
            `To send it: open Artha's browser, sign in to Gmail once, then ask me again — I'll deliver it ` +
            `through your Gmail (you approve once, then I send it).`;
        }

        // Deterministic goal outcome line — written by the gate, not the model.
        if (goalNote) finalText = `${finalText}\n\n${goalNote}`;

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

        // Acceptance criteria: check the run's CONCRETE claims (the paths it
        // said it wrote/moved) against reality on disk, so "Completed —
        // verified" has to be earned. A run that claims a file it never
        // produced now fails verification instead of showing a green check.
        // Model-independent and best-effort — never breaks the run.
        try {
          // Authoritative paths the run registered as artifacts (docs_generate
          // writes these), cross-checking the text-parsed tool results.
          let artifactPaths: string[] = [];
          try {
            artifactPaths = (db.prepare(
              `SELECT file_path FROM artifacts WHERE session_id=?`
            ).all(args.sessionId) as { file_path: string }[]).map(a => a.file_path);
          } catch { /* artifacts are best-effort evidence */ }

          const crit = recordAcceptanceCriteria(db, {
            runId: args.runId,
            sessionId: args.sessionId,
            goal: args.goal,
            mutations,
            artifactPaths,
            exists: (p: string) => fs.existsSync(p),
          });
          if (crit.recorded > 0) {
            recordStep(stepIdx++, 'system', {
              note: 'acceptance-criteria',
              recorded: crit.recorded, passed: crit.passed,
              failed: crit.failed, unverified: crit.truncated,
            });
          }
        } catch { /* bookkeeping must never break a run */ }
        if (isCancelled() || wasStoppedByUser(args.workflowId)) {
          // The user hit Stop (chat button or global kill switch) while the
          // final turn was in flight. A stopped run is NEVER completed, even if
          // the model produced a wrap-up — record it as cancelled.
          this.cancelledWorkflows.delete(args.workflowId);
          db.prepare(`UPDATE agent_runs SET status='cancelled' WHERE run_id=?`).run(args.runId);
          db.prepare(`UPDATE agent_states SET status='cancelled' WHERE workflow_id=?`).run(args.workflowId);
          terminalOutcome = 'cancelled';
          persistRunFacts(db, args.runId, {
            outcome: 'cancelled', toolCallsTotal, toolCallsFailed: toolCallErrors,
            toolCallsBlocked, mutationsTotal: mutations.length,
            mutationsFailed: mutations.filter(m => !m.success).length,
            errorDetail: wasStoppedByUser(args.workflowId) ? 'stopped_by_user' : 'cancelled_by_user',
          });
        } else if (sendUnfulfilled) {
          // A requested send never happened — this is NOT a completion. Report
          // it honestly so Delegate can't show a green "completed".
          db.prepare(`UPDATE agent_runs SET status='failed' WHERE run_id=?`).run(args.runId);
          db.prepare(`UPDATE agent_states SET status='failed' WHERE workflow_id=?`).run(args.workflowId);
          terminalOutcome = 'failed';
          persistRunFacts(db, args.runId, {
            outcome: 'failed', toolCallsTotal, toolCallsFailed: toolCallErrors,
            toolCallsBlocked, mutationsTotal: mutations.length,
            mutationsFailed: mutations.filter(m => !m.success).length,
            errorDetail: 'email_not_sent',
          });
        } else if (fileGoalUnfulfilled) {
          // The user asked for a change on disk and none happened (attempted
          // mutations all failed, or none were attempted). Never record that as
          // a success — the founder's completion doctrine: system-verified only.
          db.prepare(`UPDATE agent_runs SET status='failed' WHERE run_id=?`).run(args.runId);
          db.prepare(`UPDATE agent_states SET status='failed' WHERE workflow_id=?`).run(args.workflowId);
          terminalOutcome = 'failed';
          persistRunFacts(db, args.runId, {
            outcome: 'failed', toolCallsTotal, toolCallsFailed: toolCallErrors,
            toolCallsBlocked, mutationsTotal: mutations.length,
            mutationsFailed: mutations.filter(m => !m.success).length,
            errorDetail: 'file_action_not_performed',
          });
        } else {
        // `status='completed'` means ONLY that the executor finished. Whether
        // the user's objective was achieved is decided later, from the facts
        // persisted below (bodhi/taskModel.deriveTaskStatus) — never here.
        db.prepare(`UPDATE agent_runs SET status='completed' WHERE run_id=?`).run(args.runId);
        db.prepare(`UPDATE agent_states SET status='completed' WHERE workflow_id=?`).run(args.workflowId);
        terminalOutcome = 'succeeded';
        persistRunFacts(db, args.runId, {
            outcome: 'succeeded', toolCallsTotal, toolCallsFailed: toolCallErrors,
            toolCallsBlocked, mutationsTotal: mutations.length,
            mutationsFailed: mutations.filter(m => !m.success).length,
            errorDetail: null,
          });
        }
        // Evidence: one sanitized record per mutation actually attempted.
        for (const m of mutations) {
          recordEvidence(db, {
            runId: args.runId, kind: 'tool_result', ref: m.tool,
            status: m.success ? 'succeeded' : 'failed',
            summary: `${m.tool} ${m.success ? 'succeeded' : 'failed'}`,
          });
        }
        finalEmitted = true;
        break;

      } else {
        // Escalate before spending a strike on a plain re-ask: restore withheld
        // MCP tools after a discarded turn, or step up one model size. Each
        // remedy fires at most once per run (agent/escalation.ts).
        let ladder: string[] = [];
        if (!modelEscalated && !args.modelOverride && loopTask === 'agent') {
          try {
            const ri = agentRouteInput(db);
            const capB = resolveAgentRoute(db).capB;
            // A cloud pick runs on cloud by the user's choice; routing never
            // moves it to or from local, and neither does escalation.
            if (ri.userPick && !ri.userPick.isLocal) throw new Error('cloud pick: no escalation');
            ladder = escalationLadder({
              current: loopModel, candidates: ri.candidates, capB,
              knownBadToolCalls: ri.knownBadToolCalls,
              userLocalPick: ri.userPick?.isLocal ? ri.userPick.name : null,
            });
          } catch { /* no ladder — fall through to the nudge */ }
        }
        const step = nextEscalation({ discarded: !!msg.discarded, toolsPruned, toolsRestored, modelEscalated, ladder });
        if (step?.kind === 'restore-tools') {
          toolsRestored = true;
          tools = fullTools;
          const added = budget.withheld.filter(w => w.reason === 'irrelevant').map(w => w.server).join(', ');
          messages.push({
            role: 'system',
            content: `Additional tools are now available for this task (from: ${added}). The full tool list is: ${tools.map(t => t.function.name).join(', ')}. Continue by calling one of them with valid arguments.`,
          });
          recordStep(stepIdx++, 'system', { note: 'escalate-tools', restored: added, tools: tools.length });
          emit('agent:status', 'Offering more tools and retrying…');
          continue;
        }
        if (step?.kind === 'switch-model') {
          modelEscalated = true;
          const from = loopModel;
          try {
            llm = getActiveLLMClient(step.model);
            loopModel = step.model;
            recordStep(stepIdx++, 'system', { note: 'escalate-model', from, to: step.model, discarded: !!msg.discarded });
            emit('agent:status', `Switching to ${step.model} to finish this task…`);
            emit('agent:modelRouted', {
              model: step.model, source: 'auto', userPick: null, capB: 0,
              reason: `${from ?? 'The routed model'} produced no usable output, so Artha stepped up to ${step.model} for the rest of this task.`,
            });
            messages.push({
              role: 'system',
              content: `The previous attempt produced no usable output. Continue the task now: call one of the available tools with valid arguments, or if no tool applies, answer plainly.`,
            });
            continue;
          } catch (err) {
            console.warn('[Artha] model escalation failed (continuing on current model):', err);
          }
        }
        emptyCount++;
        if (emptyCount < 3) {
          // Empty turn. On Ollama this almost always means the model called a
          // tool that was not offered, so the runtime discarded the whole reply
          // (`discarded`). Silently re-asking just reproduces it; name the cause
          // and the real tool list so the next turn can succeed.
          const available = tools.map(t => t.function.name).join(', ');
          messages.push({
            role: 'system',
            content:
              `Your last reply produced no usable output` +
              (msg.discarded
                ? ` — you generated a response but the runtime discarded it, which happens when a reply calls a tool that is NOT available in this run.`
                : `.`) +
              ` The ONLY tools available are: ${available}. Continue the task by calling one of these with valid arguments. ` +
              `If none of them can do what is needed, say so plainly in one sentence.`,
          });
          recordStep(stepIdx++, 'system', { note: 'empty-reply-nudge', discarded: !!msg.discarded, empty: emptyCount });
        }
        if (emptyCount >= 3) {
          recordStep(stepIdx++, 'final', { reason: 'stall' });
          db.prepare(`UPDATE agent_runs SET status='failed' WHERE run_id=?`).run(args.runId);
          terminalOutcome = 'failed';
          persistRunFacts(db, args.runId, {
            outcome: 'failed', toolCallsTotal, toolCallsFailed: toolCallErrors,
            toolCallsBlocked, mutationsTotal: mutations.length,
            mutationsFailed: mutations.filter(m => !m.success).length,
            errorDetail: 'stall',
          });
          break;
        }
      }
    }

    if (!finalEmitted && iterations >= 60) {
      recordStep(stepIdx++, 'final', { reason: 'max_iterations' });
      db.prepare(`UPDATE agent_runs SET status='failed' WHERE run_id=?`).run(args.runId);
      // Hitting the iteration cap is PARTIAL work, not a clean failure — the
      // outcome distinction is what lets the projection say so honestly.
      terminalOutcome = 'timed_out';
      persistRunFacts(db, args.runId, {
            outcome: 'timed_out', toolCallsTotal, toolCallsFailed: toolCallErrors,
            toolCallsBlocked, mutationsTotal: mutations.length,
            mutationsFailed: mutations.filter(m => !m.success).length,
            errorDetail: 'max_iterations',
          });
    }

    // Restore the parent loop's citation token (null at the top level). A bare
    // setActiveCitationToken(null) here would silence the parent's web/browser
    // citation collection after it delegated to a sub-capability.
    setActiveCitationToken(prevCitationToken);

    // Notify when a long run ends (> 10 s) — but say what ACTUALLY happened.
    // This sat outside every status branch, so a user who pressed Stop, or
    // whose run stalled or errored, still got "task complete" (audit C3).
    if (args.startMs && Date.now() - args.startMs > 10_000) {
      const g = args.goal;
      const goalSnippet = g.length > 60 ? g.slice(0, 57) + '…' : g;
      const title =
        terminalOutcome === 'succeeded'   ? 'Artha — run finished'
        : terminalOutcome === 'cancelled' ? 'Artha — task stopped'
        : terminalOutcome === 'timed_out' ? 'Artha — task hit its limit'
        : terminalOutcome === 'failed'    ? 'Artha — task failed'
        :                                   'Artha — run ended';
      // "finished" ≠ "your objective is done": verification happens elsewhere.
      sendNotification(title, goalSnippet);
    }

    // Terminal run event: records that the LOOP ended and the outcome it
    // recorded. Not a completion claim — task completion is verified from
    // evidence in bodhi/, never from this event.
    recordRunEvent(args.runId, 'done', { outcome: terminalOutcome });
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
      pinnedModel: row.pinned_model ?? null,
      // Invoked by name by the parent run → its allowlist is a real boundary.
      toolScope: 'restrict',
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
    const childPin = this.resolvePinnedModel(args.skill.pinnedModel);
    const childModel = childPin || this.activeModelName();
    db.prepare(`
      INSERT INTO agent_runs (run_id, session_id, workflow_id, parent_run_id, goal, model, status)
      VALUES (?, ?, ?, ?, ?, ?, 'running')
    `).run(runId, childSessionId, workflowId, args.parentRunId, args.input, childModel);

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

    const startMs = Date.now();
    try {
      await this.runReactLoop({
        workflowId,
        runId,
        sessionId: childSessionId,
        goal: args.input,
        messages,
        skill: args.skill,
        modelOverride: childPin ?? undefined,
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
      // A composed sub-capability is a real skill execution — record it (tagged
      // 'invoke') so the dashboard reflects delegated work too. Tool counts use
      // the CHILD runId, so they never double-count against the parent skill.
      // Done before the session is dropped, but it reads by run_id, which (with
      // the agent_run row + receipts) survives the delete below.
      this.recordSkillInvocation(args.skill, 'invoke', runId, childSessionId, args.input, startMs);
      // Drop the throwaway session (cascades its messages); the agent_run row and
      // its receipts persist so the sub-task stays auditable and in lineage.
      try { db.prepare(`DELETE FROM chat_sessions WHERE session_id=?`).run(childSessionId); } catch { /* ignore */ }
    }
  }

  /** Dispatch goal_set / goal_update. Never throws — rejections come back as
   *  an `Error:` tool result the model can react to. goal_set needs the
   *  user's approval (existing tool-approval modal) unless the user's own
   *  message already stated this outcome; unattended runs fail closed. */
  private async invokeGoalTool(
    name: string,
    parsedArgs: Record<string, unknown>,
    ctx: { workflowId: string; sessionId: string; userGoal: string },
  ): Promise<string> {
    const db = getDb();
    try {
      if (name === 'goal_update') {
        const g = modelUpdateGoal(db, ctx.sessionId, { status: parsedArgs.status, reason: parsedArgs.reason });
        return JSON.stringify({ ok: true, goal_id: g.goalId, status: g.status, reason: g.blockedReason });
      }
      const objective = typeof parsedArgs.objective === 'string' ? parsedArgs.objective : '';
      const condition = typeof parsedArgs.condition === 'string' ? parsedArgs.condition : '';
      if (!objective.trim() || !condition.trim()) {
        return 'Error: goal_set needs both "objective" and "condition".';
      }
      // Fail fast (before prompting the user) if a goal already exists.
      if (getOpenGoal(db, ctx.sessionId)) {
        createGoal(db, { sessionId: ctx.sessionId, objective, condition }); // throws the clear GoalError
      }
      if (!userStatedOutcome(ctx.userGoal, objective, condition)) {
        const rc = getRunContext();
        if (rc?.lan || rc?.unattended) {
          return 'Error: goal_set needs the user\'s approval, but this run is unattended, so no goal was set.';
        }
        const approved = await this.requestToolApproval({
          workflowId: ctx.workflowId, sessionId: ctx.sessionId, toolName: 'goal_set',
          args: { objective, condition },
          note: 'Artha wants to make this the goal for this task. It will keep working until an independent check confirms the condition from evidence.',
        });
        if (!approved) return 'Error: The user declined this goal. Do not set it again; continue with the task as asked.';
      }
      const g = createGoal(db, { sessionId: ctx.sessionId, objective, condition });
      return JSON.stringify({
        ok: true, goal_id: g.goalId, status: g.status,
        note: 'Goal recorded. When you finish, an independent check will verify the condition from evidence.',
      });
    } catch (err) {
      if (err instanceof GoalError) return `Error: ${err.message}`;
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  /** The judge for the goal evaluator: a separate, tool-less completion call.
   *  Prefers a different model from the actor when the router resolves one
   *  for another phase, so the checker isn't the same model grading itself. */
  private goalJudge(actorModel: string | null): JudgeFn | null {
    let taskType: TaskType = 'synthesis';
    for (const t of ['plan', 'synthesis'] as TaskType[]) {
      const m = resolveRunModel(undefined, t);
      if (m && m !== actorModel) { taskType = t; break; }
    }
    let client: ReturnType<typeof getActiveLLMClient>;
    try { client = getActiveLLMClient(undefined, taskType); } catch { return null; }
    return async (msgs) => {
      const resp = await client.complete(msgs); // no tools offered — judgement only
      return resp.choices[0]?.message?.content ?? '';
    };
  }

  /** Run the stop gate for a session's open goal. Returns null when there is
   *  no goal to gate (none, or paused by the user). Never throws. */
  private async runGoalStopGate(a: {
    runId: string; sessionId: string; goal: string; finalAnswer: string;
    mutations: TrackedMutation[]; goalEvidence: Array<Omit<EvaluatorEvidence, 'id'>>;
    goalRounds: number; toolCallsTotal: number; toolCallErrors: number; actorModel: string | null;
    /** True once the user stopped the run. Checked again after the (async)
     *  judge call so a stop that lands mid-evaluation can't complete the goal. */
    stopped?: () => boolean;
  }): Promise<{ action: 'complete' | 'continue' | 'needs_review'; gaps: string[]; feedback?: string; note: string | null } | null> {
    try {
      const db = getDb();
      const goal = getOpenGoal(db, a.sessionId);
      if (!goal || goal.status === 'paused') return null;
      if (goal.status === 'blocked') {
        // The model (or an earlier gate) said it can't proceed — honest, not a
        // false completion. Surface the reason and end as needs review — the
        // reason becomes a prose criterion so the run can't project as verified.
        try {
          const taskId = ensureRunTask(db, { runId: a.runId, sessionId: a.sessionId, goal: a.goal });
          addGoalGapCriteria(db, taskId, 'awaiting_user_review', [`Blocked: ${goal.blockedReason ?? 'no reason given'}`]);
        } catch { /* bookkeeping must never break a run */ }
        return { action: 'needs_review', gaps: [], note: `⏸️ Goal blocked — needs you: ${goal.blockedReason ?? 'no reason given'}` };
      }
      // Deterministic criteria from the run's concrete claims, checked on disk.
      const criteria = deriveCriteriaFromMutations(a.mutations).map(d => ({
        description: d.description, required: d.required,
        outcome: evaluateCriterion(d, (p: string) => fs.existsSync(p)),
      }));
      const verdict = await evaluateGoal({
        objective: goal.objective, condition: goal.condition,
        runFacts: {
          toolCallsTotal: a.toolCallsTotal, toolCallsFailed: a.toolCallErrors,
          mutationsTotal: a.mutations.length, mutationsFailed: a.mutations.filter(m => !m.success).length,
        },
        criteria,
        evidence: numberEvidence(a.goalEvidence),
        finalAnswer: a.finalAnswer,
      }, this.goalJudge(a.actorModel));
      if (a.stopped?.()) return null; // stopped while judging — never complete
      const r = applyStopGate(db, {
        goal, verdict, roundsUsed: a.goalRounds, runId: a.runId, sessionId: a.sessionId, objective: a.goal,
      });
      const gapList = r.gaps.map(g => `- ${g}`).join('\n');
      const note = r.action === 'complete'
        ? `🎯 Goal met — confirmed by an independent check: ${goal.condition}`
        : r.action === 'needs_review'
          ? verdict.verdict === 'unmet'
            ? `⚠️ Goal not met after ${MAX_GOAL_FEEDBACK_ROUNDS} more attempts — needs you. Still missing:\n${gapList}`
            : `⚠️ Goal could not be verified automatically — needs your review.${gapList ? `\n${gapList}` : ''}`
          : null;
      return { action: r.action, gaps: r.gaps, feedback: r.feedback, note };
    } catch (err) {
      console.warn('[Artha] goal stop gate skipped:', (err as Error)?.name ?? 'Error');
      return null;
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

  /** Extract {to, subject, body} from a natural-language send request. Small
   *  models are good at THIS (extraction) even when they're bad at choosing the
   *  right tool — so we let the model do only the part it's reliable at, then
   *  send deterministically. Returns null if no valid recipient is present. */
  private async extractEmailFields(goal: string): Promise<{ to: string; subject: string; body: string } | null> {
    try {
      const llm = getActiveLLMClient(undefined, 'plan');
      const resp = await llm.complete([
        { role: 'system', content:
          'Extract the email the user wants to send. Respond with ONLY a JSON object and nothing else: ' +
          '{"to":"<recipient email address, or empty string>","subject":"<subject line>","body":"<message body>"}.' },
        { role: 'user', content: goal },
      ]);
      let text = (resp.choices[0]?.message?.content ?? '').trim();
      text = text.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
      const m = text.match(/\{[\s\S]*\}/);
      if (!m) return null;
      const j = JSON.parse(m[0]) as { to?: string; subject?: string; body?: string };
      const to = (j.to ?? '').trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return null;
      return { to, subject: String(j.subject ?? ''), body: String(j.body ?? '') };
    } catch { return null; }
  }

  /** Deterministic email send: Artha finishes a send task itself instead of
   *  hoping a small model calls email_send. Extract → user approval → deliver.
   *  email_send writes its own external_actions row, so sendWasConfirmed()
   *  reflects the result. Never throws. */
  private async deterministicEmailSend(
    args: { goal: string; workflowId: string; sessionId: string; runId: string },
    recordStep: (idx: number, kind: string, payload: unknown) => void,
    stepIdx: number,
  ): Promise<{ sent: boolean; to: string | null; reason?: string }> {
    // Deterministic first (no model): parse the fields straight from the goal.
    // Only fall back to an LLM for genuinely free-form phrasing — so a structured
    // "email X, subject "Y", body "Z"" works identically on ANY model, or none.
    const fields = parseEmailFieldsFromGoal(args.goal) ?? await this.extractEmailFields(args.goal);
    if (!fields) return { sent: false, to: null, reason: 'no recipient could be extracted' };
    recordStep(stepIdx, 'system', { note: 'deterministic-send', to: fields.to });
    const approved = await this.requestToolApproval({
      workflowId: args.workflowId, sessionId: args.sessionId,
      toolName: 'email_send', args: fields,
      note: `Send this email to ${fields.to} through your Gmail.`,
      runId: args.runId,
    });
    if (!approved) return { sent: false, to: fields.to, reason: 'declined' };
    try {
      const result = await this.registry.invokeTool('email_send', fields, { runId: args.runId });
      let sent = false;
      try { sent = (JSON.parse(result) as { sent?: boolean }).sent === true; } catch { /* non-JSON = error string */ }
      return { sent, to: fields.to, reason: sent ? undefined : result.slice(0, 160) };
    } catch (e) {
      return { sent: false, to: fields.to, reason: e instanceof Error ? e.message : String(e) };
    }
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
    // Returns the new step_id so a tool call can attribute its undo entry
    // and file checkpoints to the exact step (rewindRunToStep target).
    return (
      idx: number,
      kind: string,
      payload: unknown,
      snapshot?: OpenAI.ChatCompletionMessageParam[]
    ): string => {
      const stepId = crypto.randomUUID();
      try {
        insert.run(
          stepId,
          runId,
          idx,
          kind,
          JSON.stringify(payload),
          snapshot ? JSON.stringify(snapshot) : null,
        );
      } catch (err) {
        console.warn('[Artha] step record failed:', err);
      }
      return stepId;
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

  /** A skill's pinned model, but only if it's still a configured model. Returns
   *  null when there's no pin OR the pinned model has since been removed — so a
   *  stale pin (e.g. the model was uninstalled) gracefully falls back to the
   *  router/active model instead of failing every run. The pin itself is left in
   *  the DB, so reinstalling the model re-activates it. */
  private resolvePinnedModel(pinned: string | null | undefined): string | null {
    if (!pinned) return null;
    try {
      const exists = getDb()
        .prepare(`SELECT 1 FROM llm_models WHERE ollama_name=? LIMIT 1`)
        .get(pinned);
      if (exists) return pinned;
      console.warn(`[Artha] skill pinned model "${pinned}" is not installed — falling back to router.`);
    } catch { /* fall through to null */ }
    return null;
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
   *  Capped at 20 entries so very long sessions don't blow the context window.
   *  DESC + reverse: grab the 20 MOST RECENT rows, then restore chronological
   *  order (plain ASC LIMIT would return the oldest 20 — the start of the chat,
   *  not its tail). */
  /** Last 20 turns of the session, oldest first. When `currentGoal` is given,
   *  the trailing copy of the user's current request (persisted before the run
   *  started) is dropped so callers can append the goal once, not twice. */
  private getSessionHistory(sessionId: string, currentGoal?: string): OpenAI.ChatCompletionMessageParam[] {
    const db = getDb();
    const rows = db.prepare(
      `SELECT sender_type, content FROM messages
       WHERE session_id=? ORDER BY timestamp DESC LIMIT 20`
    ).all(sessionId) as { sender_type: string; content: string }[];
    const history = rows.reverse().map(r => ({
      role: r.sender_type === 'user' ? 'user' : 'assistant',
      content: r.content,
    } as OpenAI.ChatCompletionMessageParam));
    return dropEchoedGoal(history, currentGoal);
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
