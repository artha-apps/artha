/**
 * Scheduled runs on the shared orchestrator (scheduler/scheduledRunner.ts):
 *   - every fire uses the ONE app-wide orchestrator, never a new instance;
 *   - the global kill switch cancels a scheduled run through that instance's
 *     cancel path (the same path chat uses) and marks it stopped_by_user;
 *   - the run still executes unattended, so confirm-tier tools and the
 *     email_send floor are blocked by the real permission gate;
 *   - with no orchestrator ready, the run is refused (fail closed).
 *
 * The orchestrator itself needs Electron + better-sqlite3, so a small fake
 * stands in for it and mirrors what runReactLoop does: trackRun() with a
 * cancel callback that routes to cancelWorkflow().
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createScheduledRunner, SCHEDULED_RUN_CONTEXT, type ScheduledRunOrchestrator } from './scheduledRunner';
import { runWithContext, getRunContext, confirmTierMustFailClosed, type RunContext } from '../agent/runContext';
import { installKillSwitch, trackRun, triggerStop, wasStoppedByUser, __resetDesktopRuntimeForTests } from '../desktop/runtime';
import { decideToolCall, resolveEffectiveMode, type ToolCallGateInput } from '../agent/modes';
import { InMemoryGrantStore } from '../bodhi/grants';

/** Fake orchestrator: each handleMessage registers with the kill switch and
 *  waits until cancelWorkflow (or finish) settles it, like the real loop. */
class FakeOrchestrator implements ScheduledRunOrchestrator {
  calls: Array<{ sessionId: string; prompt: string; ctx: RunContext | undefined }> = [];
  cancelled: string[] = [];
  private pending = new Map<string, () => void>();
  /** Hook run inside the turn (inside the per-run context). */
  inTurn: (() => Promise<void>) | null = null;

  async handleMessage(sessionId: string, prompt: string): Promise<unknown> {
    const workflowId = `wf-${sessionId}`;
    this.calls.push({ sessionId, prompt, ctx: getRunContext() });
    if (this.inTurn) await this.inTurn();
    const untrack = trackRun({ workflowId, runId: `run-${sessionId}`, sessionId, cancel: () => this.cancelWorkflow(workflowId) });
    try {
      await new Promise<void>(resolve => this.pending.set(workflowId, resolve));
    } finally { untrack(); }
    return undefined;
  }
  cancelWorkflow(workflowId: string): void {
    this.cancelled.push(workflowId);
    this.pending.get(workflowId)?.();
    this.pending.delete(workflowId);
  }
  finishAll(): void { for (const id of [...this.pending.keys()]) { this.pending.get(id)!(); this.pending.delete(id); } }
}

function installFakeKillSwitch() {
  installKillSwitch({
    register: vi.fn(() => true), unregister: vi.fn(), rejectDesktopActions: vi.fn(() => 0),
    hideOverlay: vi.fn(), setBrowserDrivingToUser: vi.fn(), recordStopReceipt: vi.fn(),
  }, 'Control+Alt+Shift+.');
}

let seq = 0;
const runnerFor = (orch: FakeOrchestrator | null) => {
  const getOrchestrator = vi.fn(() => orch);
  const createSession = vi.fn(() => `s${++seq}`);
  return { getOrchestrator, createSession, run: createScheduledRunner({ getOrchestrator, runWithContext, createSession }) };
};

/** Let the runner reach trackRun inside the fake turn. */
const tick = () => new Promise(r => setTimeout(r, 0));

beforeEach(() => __resetDesktopRuntimeForTests());

describe('scheduled runner uses the shared orchestrator', () => {
  it('every fire (cron, folder, webhook) goes to the same instance', async () => {
    const orch = new FakeOrchestrator();
    const { run, getOrchestrator, createSession } = runnerFor(orch);
    const a = run('daily digest');
    const b = run('new file arrived', { scopeFolder: '/tmp/in' });
    await tick();
    orch.finishAll();
    await expect(a).resolves.toEqual({ sessionId: expect.any(String) });
    await b;
    expect(getOrchestrator).toHaveBeenCalledTimes(2);
    expect(orch.calls.map(c => c.prompt)).toEqual(['daily digest', 'new file arrived']);
    expect(createSession).toHaveBeenLastCalledWith('new file arrived', { scopeFolder: '/tmp/in' });
  });

  it('the kill switch cancels a scheduled run via the shared cancelWorkflow', async () => {
    installFakeKillSwitch();
    const orch = new FakeOrchestrator();
    const { run } = runnerFor(orch);
    const p = run('scheduled task');
    await tick();
    const wf = `wf-${orch.calls[0].sessionId}`;

    const report = triggerStop();
    expect(report?.stoppedWorkflows).toEqual([wf]);
    expect(orch.cancelled).toEqual([wf]);
    expect(wasStoppedByUser(wf)).toBe(true);
    await expect(p).resolves.toEqual({ sessionId: orch.calls[0].sessionId });
  });

  it('runs unattended: confirm-tier tools and the email_send floor stay blocked', async () => {
    const orch = new FakeOrchestrator();
    const decisions: string[] = [];
    // Same inputs the orchestrator's per-call gate derives from the run context.
    orch.inTurn = async () => {
      const rc = getRunContext();
      const base: ToolCallGateInput = {
        toolName: 'web_fetch', args: {}, mode: resolveEffectiveMode('auto', true, rc),
        policy: { tier: 'confirm' } as ToolCallGateInput['policy'], isFloor: false,
        attended: !confirmTierMustFailClosed(rc), roots: [], planApproved: false,
        subjects: [], grants: new InMemoryGrantStore(),
      };
      decisions.push((await decideToolCall(base)).action);
      decisions.push((await decideToolCall({ ...base, toolName: 'email_send', isFloor: true })).action);
    };
    const { run } = runnerFor(orch);
    const p = run('send the report');
    await tick(); await tick();
    orch.finishAll();
    await p;
    expect(orch.calls[0].ctx).toEqual(SCHEDULED_RUN_CONTEXT);
    expect(decisions).toEqual(['block', 'block']);
    // The context is per-run: nothing leaks outside the scheduled turn.
    expect(getRunContext()).toBeUndefined();
  });

  it('refuses to run without the shared orchestrator (never builds its own)', async () => {
    const { run, createSession } = runnerFor(null);
    await expect(run('x')).rejects.toThrow(/not ready/);
    expect(createSession).not.toHaveBeenCalled();
  });
});
