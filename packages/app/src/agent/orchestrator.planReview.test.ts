/**
 * Orchestrator-level plan review tests (AgentOrchestrator.reviewPlan):
 *   - Accept with step comments sends those comments to the PLANNER (the
 *     revision prompt the LLM actually receives), then re-asks with a revised
 *     plan instead of executing;
 *   - Reject ends the workflow as 'cancelled' (cancelled-by-user) and never
 *     writes 'completed' or starts execution;
 *   - the plan's unified interaction is settled either way;
 *   - an accepted plan runs once, and a duplicate accept does nothing (R3 #3);
 *   - an approved plan runs inside the RunContext it was parked under, so a
 *     LAN or resumed run keeps its actor, isolation and resume guard after
 *     the host approves it from IPC (R2 #5, R1 #4).
 * Heavy collaborators (Electron, SQLite, LLM, MCP) are faked; the SQL the
 * orchestrator runs is captured for assertions.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { state } = vi.hoisted(() => ({
  state: {
    runs: [] as Array<{ sql: string; args: unknown[] }>,
    llmCalls: [] as Array<Array<{ role: string; content: unknown }>>,
    planReply: '' as string,
  },
}));

vi.mock('electron', () => ({ app: { getPath: () => '/tmp' }, BrowserWindow: class {}, Notification: class {} }));
const notify = vi.hoisted(() => ({ sendNotification: vi.fn(), focused: false }));
vi.mock('../notify', () => ({ sendNotification: notify.sendNotification, appHasFocus: () => notify.focused }));
vi.mock('../db/schema', () => ({
  getDb: () => ({
    prepare: (sql: string) => ({
      run: (...args: unknown[]) => { state.runs.push({ sql, args }); return { changes: 1 }; },
      get: () => undefined,
      all: () => [],
    }),
  }),
}));
vi.mock('../llm/client', () => ({
  getActiveLLMClient: () => ({
    complete: async (messages: Array<{ role: string; content: unknown }>) => {
      state.llmCalls.push(messages);
      return { choices: [{ message: { content: state.planReply } }] };
    },
  }),
  resolveRunModel: () => null,
}));
vi.mock('../mcp/registry', () => ({
  MCPRegistry: { getInstance: () => ({ getBuiltInToolSchemas: () => [], getMcpServerTools: () => [] }) },
}));
vi.mock('../skills/registry', () => ({
  SkillRegistry: { getInstance: () => ({ filterTools: (t: unknown) => t }) },
  toActive: (x: unknown) => x,
}));

import { AgentOrchestrator, APPROVAL_NUDGE_MS, type AgentPlan } from './orchestrator';
import { getInteractionHub } from './interactions';
import { runWithContext, getRunContext, type RunContext } from './runContext';

/** Fake window capturing every renderer event. */
function makeOrchestrator() {
  const events: Array<[string, unknown]> = [];
  const win = {
    isDestroyed: () => false,
    webContents: { isDestroyed: () => false, send: (c: string, d: unknown) => events.push([c, d]) },
  };
  const orch = new AgentOrchestrator(win as never);
  return { orch, events };
}

/** Seed a paused plan exactly as handleMessage would leave it. */
function seedPlan(orch: AgentOrchestrator, revisions = 0): AgentPlan {
  const plan: AgentPlan = {
    workflowId: 'wf-1', sessionId: 's-1', goal: 'Tidy my desktop',
    steps: [
      { index: 0, description: 'List files in ~/Desktop', toolName: 'fs_list_directory', status: 'pending' },
      { index: 1, description: 'Delete old screenshots', toolName: 'fs_delete_file', status: 'pending' },
    ] as AgentPlan['steps'],
    requiresApproval: true,
    revisions,
  };
  (orch as unknown as { activePlans: Map<string, AgentPlan> }).activePlans.set(plan.workflowId, plan);
  (orch as unknown as { pausePlanForReview: (p: AgentPlan) => void }).pausePlanForReview(plan);
  return plan;
}

beforeEach(() => {
  state.runs = []; state.llmCalls = [];
  state.planReply = JSON.stringify({
    steps: [
      { index: 0, description: 'List files in ~/Desktop', toolName: 'fs_list_directory' },
      { index: 1, description: 'Move old screenshots to ~/Desktop/Archive', toolName: 'fs_move_batch' },
    ],
    requiresApproval: true,
  });
});

describe('AgentOrchestrator.reviewPlan', () => {
  it('step comments reach the planner revision prompt, and the revised plan is asked again', async () => {
    const { orch, events } = makeOrchestrator();
    const plan = seedPlan(orch);
    const execute = vi.spyOn(orch as unknown as { executePlan: () => Promise<string> }, 'executePlan');
    const firstInteraction = plan.interactionId!;

    await orch.reviewPlan('wf-1', {
      decision: 'accept_with_comments',
      comments: [{ step_index: 1, original_text: 'Delete old screenshots', comment: 'Archive them, do not delete' }],
    });

    // The planner was called with the comment inside its user message.
    expect(state.llmCalls).toHaveLength(1);
    const userMsg = state.llmCalls[0].at(-1)!;
    expect(userMsg.role).toBe('user');
    expect(String(userMsg.content)).toContain('Step 2 ("Delete old screenshots"): Archive them, do not delete');

    // Not executed — re-asked with the revised steps and the ORIGINAL goal.
    expect(execute).not.toHaveBeenCalled();
    const readies = events.filter(([c]) => c === 'agent:planReady').map(([, p]) => p as AgentPlan);
    expect(readies).toHaveLength(2);
    expect(readies[1].revisions).toBe(1);
    expect(readies[1].goal).toBe('Tidy my desktop');
    expect(readies[1].steps[1].description).toContain('Archive');

    // First interaction answered; a new pending one exists for the revision.
    expect(getInteractionHub().isLive(firstInteraction)).toBe(false);
    expect(getInteractionHub().isLive(readies[1].interactionId!)).toBe(true);
    await orch.reviewPlan('wf-1', { decision: 'reject' }); // clean up
  });

  it('reject ends the run cancelled-by-user and never completed', async () => {
    const { orch, events } = makeOrchestrator();
    const plan = seedPlan(orch);
    const execute = vi.spyOn(orch as unknown as { executePlan: () => Promise<string> }, 'executePlan');

    await orch.reviewPlan('wf-1', { decision: 'reject', reason: 'Wrong folder' });

    expect(execute).not.toHaveBeenCalled();
    const statusWrites = state.runs.filter(r => /UPDATE agent_states SET status/.test(r.sql));
    expect(statusWrites.map(r => r.args[0])).toContain('cancelled');
    expect(state.runs.some(r => r.args.includes('completed'))).toBe(false);
    expect(state.runs.some(r => /status='completed'/.test(r.sql))).toBe(false);
    const tokens = events.filter(([c]) => c === 'agent:token').map(([, t]) => String(t)).join('');
    expect(tokens).toContain('Plan cancelled by user: Wrong folder');
    expect(events.some(([c]) => c === 'agent:streamEnd')).toBe(true);
    expect(getInteractionHub().isLive(plan.interactionId!)).toBe(false);
  });

  it('legacy approvePlan(false) is also recorded as cancelled', async () => {
    const { orch } = makeOrchestrator();
    seedPlan(orch);
    await orch.approvePlan('wf-1', false);
    expect(state.runs.filter(r => /UPDATE agent_states SET status/.test(r.sql)).map(r => r.args[0])).toContain('cancelled');
  });

  it('a reject via the unified interaction channel routes to the same path', async () => {
    const { orch } = makeOrchestrator();
    const plan = seedPlan(orch);
    getInteractionHub().respond(plan.interactionId!, 'declined');
    await vi.waitFor(() => {
      expect(state.runs.filter(r => /UPDATE agent_states SET status/.test(r.sql)).map(r => r.args[0])).toContain('cancelled');
    });
  });

  it('runs an accepted plan once; a duplicate accept does nothing (R3 #3)', async () => {
    const { orch } = makeOrchestrator();
    seedPlan(orch);
    const execute = vi.spyOn(orch as unknown as { executePlan: () => Promise<string> }, 'executePlan')
      .mockResolvedValue('done');
    await orch.reviewPlan('wf-1', { decision: 'accept' });
    await orch.approvePlan('wf-1', true);
    await orch.reviewPlan('wf-1', { decision: 'accept' });
    expect(execute).toHaveBeenCalledTimes(1);
    expect((orch as unknown as { activePlans: Map<string, AgentPlan> }).activePlans.has('wf-1')).toBe(false);
  });

  it('an approved plan executes inside the RunContext it was parked under (R2 #5, R1 #4)', async () => {
    const { orch } = makeOrchestrator();
    const lanCtx: RunContext = {
      actor: 'lan:teammate', lan: true, unattended: true,
      resume: { fromRunId: 'r0', confirmedActionIds: ['A1'] },
    };
    // Parked from inside the LAN run…
    runWithContext(lanCtx, () => { seedPlan(orch); });
    let seen: RunContext | undefined;
    vi.spyOn(orch as unknown as { executePlan: () => Promise<string> }, 'executePlan')
      .mockImplementation(async () => { seen = getRunContext(); return 'done'; });

    // …approved later from an IPC handler with NO run context.
    expect(getRunContext()).toBeUndefined();
    await orch.reviewPlan('wf-1', { decision: 'accept' });

    expect(seen).toBe(lanCtx);
    expect(seen?.resume?.confirmedActionIds).toEqual(['A1']);
  });

  it('a comment that revised the plan reaches the EXECUTOR, not just the plan card (live QA 2026-11-13)', async () => {
    const { orch } = makeOrchestrator();
    seedPlan(orch);
    await orch.reviewPlan('wf-1', {
      decision: 'accept_with_comments',
      comments: [{ step_index: 1, original_text: 'Delete old screenshots', comment: 'Archive them, do not delete' }],
    });
    // The user now accepts the REVISED plan with a plain accept.
    let executed: AgentPlan | undefined;
    vi.spyOn(orch as unknown as { executePlan: (p: AgentPlan) => Promise<string> }, 'executePlan')
      .mockImplementation(async (p) => { executed = p; return 'done'; });
    await orch.reviewPlan('wf-1', { decision: 'accept' });

    expect(executed).toBeDefined();
    expect(executed!.steps[1].description).toContain('Archive');
    expect(executed!.revisionComments).toEqual([
      { step_index: 1, original_text: 'Delete old screenshots', comment: 'Archive them, do not delete' },
    ]);
  });

  it('labels the plan card with where the run came from', () => {
    const { orch } = makeOrchestrator();
    const open = vi.spyOn(getInteractionHub(), 'open');
    runWithContext({ actor: 'lan:teammate', lan: true }, () => { seedPlan(orch); });
    const payload = open.mock.calls.at(-1)![0].payload as { origin: string; actor?: string };
    expect(payload.origin).toBe('lan');
    expect(payload.actor).toBe('lan:teammate');
    open.mockRestore();
    void orch.reviewPlan('wf-1', { decision: 'reject' });
  });
});

describe('approval prompts wait until answered (founder decision 2026-11-13)', () => {
  type Req = {
    workflowId: string; sessionId: string; toolName: string; args: Record<string, unknown>; note: string;
    onId?: (id: string) => void; onNotAsked?: () => void;
  };
  const ask = (orch: AgentOrchestrator, req: Req) =>
    (orch as unknown as { requestToolApproval: (r: Req) => Promise<boolean> }).requestToolApproval(req);
  const base = { sessionId: 's-1', toolName: 'fs_copy_file', args: {}, note: 'n' };
  /** Resolves to the settled value, or 'pending' if the promise has not settled. */
  const stateOf = (p: Promise<boolean>) => Promise.race([p, Promise.resolve('pending' as const)]);

  beforeEach(() => { notify.sendNotification.mockClear(); notify.focused = false; });
  afterEach(() => { vi.useRealTimers(); });

  it('is still waiting after hours, and continues when the user finally approves', async () => {
    vi.useFakeTimers();
    const { orch } = makeOrchestrator();
    let id = '';
    const p = ask(orch, { ...base, workflowId: 'wf-a', onId: x => { id = x; } });
    await vi.advanceTimersByTimeAsync(3 * 60 * 60_000);      // far past the old 2-minute limit
    expect(await stateOf(p)).toBe('pending');
    expect(getInteractionHub().isLive(id)).toBe(true);        // still answerable, still listed
    expect(getInteractionHub().listPending().map(i => i.id)).toContain(id);
    orch.respondToolApproval(id, true);
    expect(await p).toBe(true);
    expect(getInteractionHub().isLive(id)).toBe(false);
  });

  it('a real "no" declines it', async () => {
    const { orch } = makeOrchestrator();
    let id = ''; const onNotAsked = vi.fn();
    const p = ask(orch, { ...base, workflowId: 'wf-b', onId: x => { id = x; }, onNotAsked });
    orch.respondToolApproval(id, false);
    expect(await p).toBe(false);
    expect(onNotAsked).not.toHaveBeenCalled();
  });

  it('Stop releases a waiting prompt — nothing else would, now that it never times out', async () => {
    const { orch } = makeOrchestrator();
    let id = '';
    const p = ask(orch, { ...base, workflowId: 'wf-c', onId: x => { id = x; } });
    orch.cancelWorkflow('wf-c');
    expect(await p).toBe(false);
    expect(getInteractionHub().isLive(id)).toBe(false);
  });

  it('Stop on a run also releases a prompt raised by its sub-capability loop (own workflow id)', async () => {
    const { orch } = makeOrchestrator();
    const parents = (orch as unknown as { workflowParents: Map<string, string> }).workflowParents;
    parents.set('wf-child', 'wf-parent');
    parents.set('wf-grandchild', 'wf-child');
    const child = ask(orch, { ...base, workflowId: 'wf-child' });
    const grandchild = ask(orch, { ...base, workflowId: 'wf-grandchild' });
    const unrelated = ask(orch, { ...base, workflowId: 'wf-other' });
    let otherId = '';
    const other2 = ask(orch, { ...base, workflowId: 'wf-other', onId: x => { otherId = x; } });

    orch.cancelWorkflow('wf-parent');
    expect(await child).toBe(false);
    expect(await grandchild).toBe(false);
    expect(await stateOf(unrelated)).toBe('pending');          // another run's prompt is untouched
    orch.cancelWorkflow('wf-other');
    expect(await unrelated).toBe(false);
    expect(await other2).toBe(false);
    expect(getInteractionHub().isLive(otherId)).toBe(false);
  });

  it('a run nobody is watching is never asked: refused up front, not parked', async () => {
    const { orch } = makeOrchestrator();
    for (const ctx of [{ actor: 'scheduler', lan: false, unattended: true }, { actor: 'lan:teammate', lan: true }] as RunContext[]) {
      const before = getInteractionHub().livePending().length;
      const onNotAsked = vi.fn(); const onId = vi.fn();
      const approved = await runWithContext(ctx, () => ask(orch, { ...base, workflowId: 'wf-u', onId, onNotAsked }));
      expect(approved).toBe(false);
      expect(onNotAsked).toHaveBeenCalledTimes(1);
      expect(onId).not.toHaveBeenCalled();                     // no prompt was created at all
      expect(getInteractionHub().livePending().length).toBe(before);
    }
  });

  it('tells the user once that it is waiting, only when Artha is not the focused app', async () => {
    vi.useFakeTimers();
    const { orch } = makeOrchestrator();
    let id = '';
    notify.focused = true;                                     // they are looking at the prompt
    const p = ask(orch, { ...base, workflowId: 'wf-n', onId: x => { id = x; } });
    await vi.advanceTimersByTimeAsync(APPROVAL_NUDGE_MS * 3);
    expect(notify.sendNotification).not.toHaveBeenCalled();
    notify.focused = false;                                    // they switched away
    await vi.advanceTimersByTimeAsync(APPROVAL_NUDGE_MS);
    expect(notify.sendNotification).toHaveBeenCalledTimes(1);
    expect(notify.sendNotification.mock.calls[0][0]).toBe('Artha is waiting for your approval');
    expect(String(notify.sendNotification.mock.calls[0][1])).toContain('fs_copy_file');
    await vi.advanceTimersByTimeAsync(60 * 60_000);            // an hour later: still just the one
    expect(notify.sendNotification).toHaveBeenCalledTimes(1);
    orch.respondToolApproval(id, true);
    expect(await p).toBe(true);
  });

  it('answering before the nudge means no notification at all', async () => {
    vi.useFakeTimers();
    const { orch } = makeOrchestrator();
    let id = '';
    const p = ask(orch, { ...base, workflowId: 'wf-q', onId: x => { id = x; } });
    await vi.advanceTimersByTimeAsync(APPROVAL_NUDGE_MS - 1000);
    orch.respondToolApproval(id, true);
    expect(await p).toBe(true);
    await vi.advanceTimersByTimeAsync(APPROVAL_NUDGE_MS * 4);
    expect(notify.sendNotification).not.toHaveBeenCalled();
  });
});
