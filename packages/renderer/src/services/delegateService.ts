/**
 * delegateService — the brain behind the Delegate tab.
 *
 * Delegate is a goal-driven execution workspace: the user hands Artha a goal,
 * Artha understands it, retrieves context, plans the work, asks for approval
 * when an action is external/irreversible, then runs it and returns a clean
 * result.
 *
 * This module defines the SHARED TYPES for that flow and a pluggable
 * `DelegateEngine`. The MVP ships `mockDelegateEngine` — it classifies the goal
 * heuristically, produces a tailored plan, and simulates execution with
 * realistic stage transitions. The store talks ONLY to the `delegateEngine`
 * export, so swapping in a real engine (backed by the agent orchestrator,
 * workflows, and local models over `window.artha.*` IPC) is a one-line change
 * here — no UI or store edits required.
 */

// ── Task lifecycle ───────────────────────────────────────────────────────────

/** The full task lifecycle. Drives both the progress timeline and which
 *  section of the Delegate canvas is shown.
 *   idle                 — no task yet (empty state)
 *   understanding        — parsing intent from the user's goal
 *   retrieving_context   — pulling relevant memory/files/projects
 *   planning             — generating the structured plan
 *   awaiting_confirmation— plan has an external/irreversible step; paused
 *   executing            — running the agents/workflows in the plan
 *   reviewing            — checking the produced output
 *   completed            — done; result is ready
 *   failed               — something errored; surfaces the message */
export type DelegateStatus =
  | 'idle'
  | 'understanding'
  | 'retrieving_context'
  | 'planning'
  | 'awaiting_confirmation'
  | 'executing'
  | 'reviewing'
  | 'completed'
  | 'failed';

/** One step in Artha's plan. `tools`/`agent` declare what the step will use so
 *  the user can see HOW the goal gets done before approving. */
export interface DelegatePlanStep {
  index: number;
  description: string;
  /** Built-in tools this step would call (fs_*, web_*, docs_generate, …). */
  tools: string[];
  /** The specialist agent/skill this step routes to, if any. */
  agent?: string;
  /** True when this step performs an external or irreversible action
   *  (sending, publishing, deleting, paying). Drives the approval gate. */
  external?: boolean;
  status: 'pending' | 'running' | 'done' | 'failed';
}

/** The structured plan shown in DelegatePlanView. */
export interface DelegatePlan {
  goal: string;
  /** Plain-language statement of what Artha understood and will do. */
  summary: string;
  steps: DelegatePlanStep[];
  /** What the user gets at the end (a doc, a summary, a set of tasks, …). */
  expectedOutput: string;
  /** True when ANY step is external/irreversible — the UI pauses for approval
   *  (`awaiting_confirmation`) before executing. Safe goals (research,
   *  summarize, draft, analyze, plan) run straight through. */
  requiresApproval: boolean;
}

/** A file Artha produced during execution (mocked for the MVP). */
export interface DelegateResultFile {
  name: string;
  /** Coarse kind for the icon/badge: 'doc' | 'sheet' | 'slides' | 'pdf' | 'note'. */
  kind: string;
}

/** The final, user-facing result shown in DelegateResultView. */
export interface DelegateResult {
  /** A short prose summary of what was accomplished. */
  summary: string;
  /** Generated artifacts (documents, spreadsheets, …). */
  files: DelegateResultFile[];
  /** Suggested next actions the user might take. */
  nextActions: string[];
}

// ── Engine contract ──────────────────────────────────────────────────────────

/** Hooks the engine calls during execution so the UI can animate progress. */
export interface ExecuteHooks {
  /** Advance the lifecycle stage (executing → reviewing → …). */
  onStage: (status: DelegateStatus) => void;
  /** Update a single plan step's status as it runs. */
  onStep: (index: number, status: DelegatePlanStep['status']) => void;
}

/** The pluggable engine. MVP = mock; later = real orchestrator/workflow/model. */
export interface DelegateEngine {
  /** Understand + retrieve context + plan. `onStage` lets the caller animate
   *  the understanding → retrieving_context → planning transitions. */
  plan: (goal: string, onStage: (s: DelegateStatus) => void) => Promise<DelegatePlan>;
  /** Run the (optionally approved) plan and produce the result. */
  execute: (plan: DelegatePlan, hooks: ExecuteHooks) => Promise<DelegateResult>;
}

// ── Mock engine ──────────────────────────────────────────────────────────────

/** Small awaitable delay so the simulated stages feel real, not instant. */
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Coarse goal categories the mock planner recognises. Each maps to a tailored
 *  plan template. `general` is the catch-all. */
type GoalCategory = 'research' | 'brief' | 'workflow' | 'codereview' | 'planning' | 'general';

/** Keyword markers that signal an external/irreversible action — these flip a
 *  plan to require approval (e.g. actually sending follow-ups, not just
 *  drafting them). Drafting/analysing/summarising/planning stay safe. */
const EXTERNAL_MARKERS = /\b(send|email|e-mail|follow[\s-]?up|publish|post|delete|remove|deploy|pay|invoice|message|outreach|contact)\b/i;

/** Heuristically classify the goal so the mock can produce a relevant plan. */
function classify(goal: string): GoalCategory {
  const g = goal.toLowerCase();
  if (/\b(research|competitor|market|compare|positioning|landscape|find out|look up)\b/.test(g)) return 'research';
  if (/\b(brief|summari|digest|condense|key points|report from|from these files|from this)\b/.test(g)) return 'brief';
  if (/\b(workflow|automat|recurring|follow[\s-]?up|every day|schedule|pipeline)\b/.test(g)) return 'workflow';
  if (/\b(code|codebase|refactor|review this repo|repository|pull request|bug)\b/.test(g)) return 'codereview';
  if (/\b(plan|launch|roadmap|tasks|milestones|timeline|backlog)\b/.test(g)) return 'planning';
  return 'general';
}

/** Build the step list + expected-output blurb for a category. Steps mirror the
 *  internal Delegate flow (understand → context → plan → select → execute →
 *  review) at the granularity a user would care about. */
function buildSteps(category: GoalCategory, goal: string): { steps: Omit<DelegatePlanStep, 'status'>[]; expectedOutput: string; summary: string } {
  switch (category) {
    case 'research':
      return {
        summary: 'Research the topic across multiple sources, cross-check the findings, and write up a structured, sourced summary.',
        expectedOutput: 'A sourced summary document with key findings and a comparison table.',
        steps: [
          { index: 0, description: 'Break the goal into focused search queries', tools: ['web_search'], agent: 'Web Research' },
          { index: 1, description: 'Read the most authoritative sources', tools: ['web_fetch'], agent: 'Web Research' },
          { index: 2, description: 'Cross-check surprising claims against a second source', tools: ['web_search', 'web_fetch'], agent: 'Web Research' },
          { index: 3, description: 'Write a structured, cited summary document', tools: ['docs_generate'], agent: 'Report Writer' },
        ],
      };
    case 'brief':
      return {
        summary: 'Read the relevant local files, extract the key points, and draft a clean project brief.',
        expectedOutput: 'A drafted brief (Word document) grounded in your files, with sources attributed.',
        steps: [
          { index: 0, description: 'Locate and read the source files', tools: ['fs_list_directory', 'fs_read_file', 'rag_search'], agent: 'Ask My Files' },
          { index: 1, description: 'Extract the key facts and decisions', tools: ['rag_search'], agent: 'Document Summarizer' },
          { index: 2, description: 'Draft the brief from the extracted material', tools: ['docs_generate'], agent: 'Report Writer' },
        ],
      };
    case 'workflow':
      return {
        summary: 'Design a repeatable workflow for the task and (with your approval) schedule it to run on its own.',
        expectedOutput: 'A defined workflow you can review, plus a scheduled task once approved.',
        steps: [
          { index: 0, description: 'Define the trigger, steps, and success condition', tools: [], agent: 'Workflow Planner' },
          { index: 1, description: 'Draft the follow-up messages', tools: ['docs_generate'], agent: 'Report Writer' },
          { index: 2, description: 'Send the follow-ups to the leads', tools: ['cloud_gmail_send'], agent: 'Outreach', external: true },
          { index: 3, description: 'Schedule the workflow to repeat', tools: ['scheduler_create'], agent: 'Workflow Planner' },
        ],
      };
    case 'codereview':
      return {
        summary: 'Walk the codebase, identify issues and improvement opportunities, and write up concrete suggestions.',
        expectedOutput: 'A review note listing findings by severity with specific, actionable suggestions.',
        steps: [
          { index: 0, description: 'Map the project structure and entry points', tools: ['fs_list_directory', 'fs_read_file'], agent: 'Code' },
          { index: 1, description: 'Read the key modules and look for issues', tools: ['fs_read_file', 'rag_search'], agent: 'Code' },
          { index: 2, description: 'Write up findings and prioritised suggestions', tools: ['docs_generate'], agent: 'Report Writer' },
        ],
      };
    case 'planning':
      return {
        summary: 'Break the goal into a clear, ordered set of tasks with owners and a sensible sequence.',
        expectedOutput: 'A structured task plan with phases, dependencies, and suggested timing.',
        steps: [
          { index: 0, description: 'Clarify the objective and constraints', tools: [], agent: 'Workflow Planner' },
          { index: 1, description: 'Decompose into phases and concrete tasks', tools: [], agent: 'Workflow Planner' },
          { index: 2, description: 'Order tasks and flag dependencies', tools: [], agent: 'Workflow Planner' },
          { index: 3, description: 'Write the plan to a shareable document', tools: ['docs_generate'], agent: 'Report Writer' },
        ],
      };
    default:
      return {
        summary: `Understand the goal, gather what's needed, and produce a clear result for: "${goal}".`,
        expectedOutput: 'A clear written result, plus any files or next actions that apply.',
        steps: [
          { index: 0, description: 'Interpret the goal and what a good result looks like', tools: [], agent: 'Artha' },
          { index: 1, description: 'Gather any context needed from files or the web', tools: ['rag_search', 'web_search'], agent: 'Artha' },
          { index: 2, description: 'Produce and review the result', tools: ['docs_generate'], agent: 'Artha' },
        ],
      };
  }
}

/** Build the mock result for a finished plan, tailored to its category. */
function buildResult(category: GoalCategory, goal: string): DelegateResult {
  switch (category) {
    case 'research':
      return {
        summary: 'Researched the topic, cross-checked the key claims, and compiled the findings into a sourced summary with a comparison table.',
        files: [{ name: 'Research Summary.docx', kind: 'doc' }, { name: 'Comparison.xlsx', kind: 'sheet' }],
        nextActions: ['Skim the comparison table for outliers', 'Ask Artha to turn this into a slide deck', 'Schedule a weekly refresh of this research'],
      };
    case 'brief':
      return {
        summary: 'Read your files, pulled the key points, and drafted a project brief grounded in the source material.',
        files: [{ name: 'Project Brief.docx', kind: 'doc' }],
        nextActions: ['Review the draft and tweak the framing', 'Ask Artha to generate a one-page summary', 'Share the brief with stakeholders'],
      };
    case 'workflow':
      return {
        summary: 'Designed the follow-up workflow and drafted the messages. The sending step is paused pending your approval; nothing was sent.',
        files: [{ name: 'Follow-up Drafts.docx', kind: 'doc' }],
        nextActions: ['Review the drafted messages', 'Approve sending to start the outreach', 'Confirm the schedule cadence'],
      };
    case 'codereview':
      return {
        summary: 'Reviewed the codebase structure and key modules, and wrote up prioritised findings with concrete suggestions.',
        files: [{ name: 'Code Review.docx', kind: 'doc' }],
        nextActions: ['Triage the high-severity findings first', 'Ask Artha to open issues for each finding', 'Re-run the review after fixes'],
      };
    case 'planning':
      return {
        summary: 'Broke the goal into phased tasks with dependencies and suggested timing, and wrote it to a shareable plan.',
        files: [{ name: 'Task Plan.docx', kind: 'doc' }],
        nextActions: ['Assign owners to each task', 'Turn the plan into a scheduled workflow', 'Share the plan with your team'],
      };
    default:
      return {
        summary: `Worked through the goal and produced a result for: "${goal}".`,
        files: [{ name: 'Result.docx', kind: 'doc' }],
        nextActions: ['Review the output', 'Ask Artha for a refinement', 'Save this as a reusable workflow'],
      };
  }
}

/**
 * The MVP engine. Deterministic + simulated: no model is called, but the shape
 * of every value matches what a real engine will return, and the staged delays
 * make the progress timeline meaningful.
 */
export const mockDelegateEngine: DelegateEngine = {
  async plan(goal, onStage) {
    onStage('understanding');
    await wait(700);
    onStage('retrieving_context');
    await wait(700);
    onStage('planning');
    await wait(900);

    const category = classify(goal);
    const { steps, expectedOutput, summary } = buildSteps(category, goal);
    const stepList: DelegatePlanStep[] = steps.map((s) => ({ ...s, status: 'pending' }));
    // Approval is required when the plan itself contains an external step, or
    // the goal text clearly asks for an outbound/irreversible action.
    const requiresApproval = stepList.some((s) => s.external) || EXTERNAL_MARKERS.test(goal);

    return { goal, summary, steps: stepList, expectedOutput, requiresApproval };
  },

  async execute(plan, hooks) {
    hooks.onStage('executing');
    for (const step of plan.steps) {
      hooks.onStep(step.index, 'running');
      await wait(650);
      hooks.onStep(step.index, 'done');
    }
    hooks.onStage('reviewing');
    await wait(800);
    hooks.onStage('completed');
    return buildResult(classify(plan.goal), plan.goal);
  },
};

// ── IPC engine (real execution) ──────────────────────────────────────────────

/** True when running inside the Electron renderer with the delegate bridge. */
function hasDelegateIpc(): boolean {
  return typeof window !== 'undefined'
    && !!(window as unknown as { artha?: { delegate?: { start?: unknown } } }).artha?.delegate?.start;
}

/** How often we poll a running Task, and how long before we give up. */
const POLL_INTERVAL_MS = 1200;
const MAX_POLL_MS = 15 * 60 * 1000; // 15 min ceiling so a hung run can't poll forever

/**
 * The live engine. It keeps the mock's heuristic planner for the plan view +
 * approval gate (so the user still sees + approves before anything runs), but
 * EXECUTES for real through Bodhi.
 *
 * Execution is NON-BLOCKING: it kicks the run off (`delegate.start`) and polls
 * the Task (`delegate.status`) until it terminates, advancing the step markers
 * for live motion. This is why a long run no longer hangs the timeline — the
 * UI stays in "executing" with visible progress and only moves to "reviewing"
 * /"completed" when the Task actually finishes.
 */
export const ipcDelegateEngine: DelegateEngine = {
  plan: (goal, onStage) => mockDelegateEngine.plan(goal, onStage),

  async execute(plan, hooks) {
    hooks.onStage('executing');
    const { runId, sessionId, capability } = await window.artha.delegate.start(plan.goal);
    // eslint-disable-next-line no-console
    console.info(`[Delegate] started run ${runId} (capability: ${capability}) — polling…`);

    const steps = plan.steps;
    let cursor = 0;
    if (steps[cursor]) hooks.onStep(steps[cursor].index, 'running');

    const startedAt = Date.now();
    for (;;) {
      await wait(POLL_INTERVAL_MS);

      let st: Awaited<ReturnType<typeof window.artha.delegate.status>>;
      try {
        st = await window.artha.delegate.status(runId, sessionId);
      } catch {
        // Transient IPC hiccup — keep polling unless we've blown the ceiling.
        if (Date.now() - startedAt > MAX_POLL_MS) throw new Error('Delegate task timed out.');
        continue;
      }

      // eslint-disable-next-line no-console
      console.info(`[Delegate] run ${runId}: ${st.status} (${st.stepCount} steps)`);

      if (st.status === 'completed') {
        // Previously every plan step was force-stamped 'done' here purely
      // because the RUN reached a terminal state — asserting step-level
      // success for steps that were never sent to the backend (audit U1).
        hooks.onStage('reviewing');
        await wait(400);
        hooks.onStage('completed');
        return {
          // Never invent a completion sentence. If the agent produced no
        // output, say so — the renderer must not author the claim (audit U3).
        summary: st.output?.trim()
          || 'The run finished but produced no output, so completion could not be verified.',
          files: st.files ?? [],
          nextActions: [
            'Review the output',
            'Refine the result with a follow-up',
            'Save this as a reusable workflow',
          ],
        };
      }

      if (st.status === 'failed') {
        if (steps[cursor]) hooks.onStep(steps[cursor].index, 'failed');
        throw new Error('Task failed during execution.');
      }

      // NOTE: we deliberately do NOT advance steps on a timer any more.
      // A green check per 1.2s of wall clock asserted per-step success the UI
      // had no evidence for (audit U2). Real per-step state needs the backend
      // step trace; until that is wired, the plan shows as illustrative.

      if (Date.now() - startedAt > MAX_POLL_MS) throw new Error('Delegate task timed out.');
    }
  },
};

/** Resolve the engine at CALL time (not module-load time). Picking it once at
 *  load is fragile: if this module first evaluated before the preload bridge was
 *  live, it would latch onto the mock forever. Checking per call means the real
 *  engine is used as soon as `window.artha.delegate` is present. */
function activeEngine(): DelegateEngine {
  const real = hasDelegateIpc();
  // eslint-disable-next-line no-console
  console.info(`[Delegate] engine = ${real ? 'ipc (real execution)' : 'mock'}`);
  return real ? ipcDelegateEngine : mockDelegateEngine;
}

/**
 * The engine the app uses: the real IPC engine inside Electron, the mock
 * everywhere else (tests / non-Electron). Surfaces/stores import only this, so
 * the choice is invisible to the rest of the app — and is re-evaluated on every
 * call, so a stale module instance can never trap Delegate on the mock.
 */
export const delegateEngine: DelegateEngine = {
  plan: (goal, onStage) => activeEngine().plan(goal, onStage),
  execute: (plan, hooks) => activeEngine().execute(plan, hooks),
};
