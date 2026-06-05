/**
 * Bodhi — Capabilities.
 *
 * The universal execution unit of the platform. A **Capability** is anything
 * Bodhi can invoke to do work: today every capability is backed by a Skill
 * (a playbook + tool allowlist), but the contract is deliberately wider so an
 * autonomous **Agent** can later implement the *same* interface. That single
 * shared contract — `invoke(capability, input, context)` — is what makes
 * "promote a Skill to an Agent" a flag, not a rewrite.
 *
 *   Skill  = stateless capability (instructions + tool scope).
 *   Agent  = a capability with autonomy (own loop, memory, sub-tasks) — future.
 *
 * Everything here that doesn't touch the DB is pure and unit-tested
 * (`capabilities.test.ts`). The DB-backed registry takes a `SkillSource` so it
 * can be exercised with a fake in tests.
 */
import type { Skill, ActiveSkill, SkillResolution } from '../skills/registry';

/** How a capability is currently realised. `agent` is reserved for the future
 *  autonomous unit; it will implement this same interface. */
export type CapabilityKind = 'skill' | 'agent';

/** A unit of work Bodhi can route to and invoke. */
export interface Capability {
  /** Stable id — the underlying skill slug today. */
  id: string;
  name: string;
  description: string;
  icon: string;
  kind: CapabilityKind;
  /** Tool allowlist (exact name, or a prefix ending in "_"). Empty = all tools. */
  tools: string[];
  /** The skill slug backing this capability (when kind === 'skill'). */
  skillSlug?: string;
}

/** Everything a capability needs to run, scoped to one task/session. Mirrors the
 *  context the orchestrator already threads through a run (session, project,
 *  sandbox roots) so the executor can hand it straight to the ReAct loop. */
export interface CapabilityContext {
  sessionId: string;
  projectId?: string | null;
  /** Folder/file roots the capability is hard-sandboxed to (session_scopes). */
  allowedRoots?: string[];
  /** Optional model override (e.g. forced by the router for this task type). */
  modelOverride?: string;
}

/** The outcome of an invocation. `runId` ties the result back to its
 *  `agent_run` (see tasks.ts) so callers can pull the full step trace for
 *  execution tracking / verification. */
export interface CapabilityResult {
  status: 'completed' | 'failed' | 'awaiting_approval';
  /** User-facing output text. */
  output: string;
  /** The agent_run this invocation produced, when executed through the loop. */
  runId?: string;
  /** File paths produced (artifacts), if any. */
  artifacts?: string[];
  error?: string;
}

/**
 * THE universal contract. Anything that can do work implements this — the
 * orchestrator-backed executor today, autonomous agents tomorrow. Surfaces
 * (Chat / Code / Workflow / Delegate) call `invoke()`; they never embed
 * planning or routing themselves.
 */
export interface CapabilityExecutor {
  invoke(capability: Capability, input: string, ctx: CapabilityContext): Promise<CapabilityResult>;
}

/** The minimal slice of `SkillRegistry` the capability layer needs. Declared as
 *  an interface so tests can inject a fake without a database. `SkillRegistry`
 *  structurally satisfies it. */
export interface SkillSource {
  listEnabled(): Skill[];
  getBySlug(slug: string): Skill | undefined;
  resolve(message: string): Promise<SkillResolution>;
}

/** Pure projection: a DB skill row → a Capability. Tolerates a missing or
 *  malformed allowlist (treated as "all tools"). */
export function skillToCapability(skill: Skill): Capability {
  let tools: string[] = [];
  try {
    const parsed = JSON.parse(skill.allowed_tools_json);
    if (Array.isArray(parsed)) tools = parsed.filter((x): x is string => typeof x === 'string');
  } catch {
    /* empty allowlist = all tools */
  }
  return {
    id: skill.slug,
    name: skill.name,
    description: skill.description,
    icon: skill.icon,
    kind: skill.kind === 'agent' ? 'agent' : 'skill',
    tools,
    skillSlug: skill.slug,
  };
}

/** Pure projection: a resolved `ActiveSkill` → a Capability (used when the
 *  registry resolves a goal to a skill via Bodhi's routing). */
export function activeSkillToCapability(skill: ActiveSkill): Capability {
  return {
    id: skill.slug,
    name: skill.name,
    description: '',
    icon: skill.icon,
    kind: skill.kind === 'agent' ? 'agent' : 'skill',
    tools: skill.allowedTools,
    skillSlug: skill.slug,
  };
}

/**
 * Registry + router over the available capabilities. Wraps the existing
 * `SkillRegistry` so there is exactly ONE source of truth for capabilities —
 * no parallel "agents" table to drift out of sync. `select()` reuses the
 * skill resolver (explicit "/slug" or description auto-match), so capability
 * selection and skill matching can never diverge.
 */
export class CapabilityRegistry {
  constructor(private readonly skills: SkillSource) {}

  /** All currently usable capabilities. */
  list(): Capability[] {
    return this.skills.listEnabled().map(skillToCapability);
  }

  /** Look up one capability by id (slug). */
  get(id: string): Capability | null {
    const skill = this.skills.getBySlug(id);
    return skill ? skillToCapability(skill) : null;
  }

  /** Route a goal to the single best-fit capability, or null to handle it
   *  directly. Delegates to the skill resolver so routing logic lives in one
   *  place. */
  async select(goal: string): Promise<Capability | null> {
    const { skill } = await this.skills.resolve(goal);
    return skill ? activeSkillToCapability(skill) : null;
  }
}
