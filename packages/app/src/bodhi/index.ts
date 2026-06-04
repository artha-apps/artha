/**
 * Bodhi — the intelligence layer of Artha.
 *
 * Bodhi is INTERNAL and INVISIBLE to users: there is no "Bodhi" surface, brand,
 * or string in the UI. It is the engineering namespace that unifies the pieces
 * that understand the user and decide + run work — orchestration, context,
 * memory, routing, planning, capabilities, and tasks — behind one import path.
 *
 *   Artha = the product / application.   Bodhi = how it thinks.
 *
 * Staged refactor: this barrel re-exports the existing modules (which still live
 * in agent/, llm/, router/, tools/, skills/) so all NEW code imports from
 * `../bodhi` and the namespace is the single source of truth from day one.
 * Physically relocating those files under bodhi/ is a later, purely mechanical
 * step — call sites already pointed at `bodhi` won't change when it happens.
 *
 * The genuinely new, unifying pieces — the universal `invoke(capability, …)`
 * contract and the `Task` (= agent_run) entity — live in this folder.
 */

// ── New unifying layers (live here) ──────────────────────────────────────────
export * from './capabilities';
export * from './tasks';
export { OrchestratorCapabilityExecutor } from './executor';
export { OPERATOR_PLAYBOOK, buildOperatorSkill } from './operator';

// ── Orchestration (today: agent/orchestrator.ts) ─────────────────────────────
export {
  AgentOrchestrator,
} from '../agent/orchestrator';
export type {
  ReasoningStep,
  WorkflowStep,
  Attachment,
  AgentPlan,
  ClarifyRequest,
} from '../agent/orchestrator';

// ── Context assembly (today: agent/contextGather.ts) ─────────────────────────
export { gatherContext } from '../agent/contextGather';
export type { GatheredContext } from '../agent/contextGather';

// ── Memory (today: tools/memory.ts) ──────────────────────────────────────────
export {
  MEMORY_TOOL_SCHEMAS,
  isMemoryTool,
  invokeMemoryTool,
  getMemoryContext,
} from '../tools/memory';

// ── Model router (today: router/benchmark.ts). TaskType is re-exported from the
//    LLM client below to avoid a duplicate-symbol clash (both declare it). ─────
export {
  runBenchmark,
  listProfiles,
  listOverrides,
  setOverride,
} from '../router/benchmark';
export type { BenchmarkReport } from '../router/benchmark';

// ── LLM client + the canonical TaskType (today: llm/client.ts) ───────────────
export { getActiveLLMClient, LLMClient } from '../llm/client';
export type { TaskType, StreamedMessage, LLMConfig } from '../llm/client';

// ── Capability source: Skills (today: skills/registry.ts) ────────────────────
export { SkillRegistry } from '../skills/registry';
export type { Skill, ActiveSkill, SkillResolution, SkillInput } from '../skills/registry';
