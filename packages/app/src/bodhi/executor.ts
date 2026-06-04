/**
 * Bodhi — the orchestrator-backed CapabilityExecutor.
 *
 * This is the one concrete implementation of the universal
 * `invoke(capability, input, context)` contract today: it runs a capability by
 * driving the existing `AgentOrchestrator` (the proven ReAct loop), so Delegate
 * and any other surface execute through the SAME engine as Chat — no parallel
 * orchestration. The run is tracked as a Task (`agent_runs`); the result is read
 * back from that Task + its persisted final message.
 *
 * When autonomous Agents arrive they implement this same interface (a different
 * executor, or a flag on this one) — surfaces calling `invoke()` don't change.
 */
import { getDb } from '../db/schema';
import { SkillRegistry } from '../skills/registry';
import type { AgentOrchestrator } from '../agent/orchestrator';
import type {
  Capability,
  CapabilityContext,
  CapabilityExecutor,
  CapabilityResult,
} from './capabilities';
import { getTask } from './tasks';

export class OrchestratorCapabilityExecutor implements CapabilityExecutor {
  constructor(
    private readonly orchestrator: AgentOrchestrator,
    private readonly skills: SkillRegistry = SkillRegistry.getInstance(),
  ) {}

  async invoke(capability: Capability, input: string, ctx: CapabilityContext): Promise<CapabilityResult> {
    // Resolve the capability's backing skill to an ActiveSkill (playbook + tool
    // scope) via an explicit "/slug" resolution. Capabilities with no skill
    // (future agents) run with no skill active.
    let skill = null;
    if (capability.skillSlug) {
      const resolution = await this.skills.resolve(`/${capability.skillSlug}`);
      skill = resolution.skill;
    }

    let runId: string;
    try {
      runId = await this.orchestrator.runCapability({ sessionId: ctx.sessionId, goal: input, skill });
    } catch (err) {
      return { status: 'failed', output: '', error: err instanceof Error ? err.message : String(err) };
    }

    // Read the outcome from the Task + its final persisted message.
    const task = getTask(runId);
    const status: CapabilityResult['status'] =
      task?.status === 'failed' || task?.status === 'cancelled' ? 'failed' : 'completed';

    const row = getDb()
      .prepare(`SELECT content FROM messages WHERE session_id = ? AND sender_type = 'agent' ORDER BY rowid DESC LIMIT 1`)
      .get(ctx.sessionId) as { content: string } | undefined;

    return { status, output: row?.content ?? '', runId };
  }
}
