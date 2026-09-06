/**
 * Escalation — what the act loop does when a turn produced nothing.
 *
 * Slice 3 of the agent-routing decision (2026-09-05). Routing picks a fast
 * model and a trimmed tool set up front; this is the recovery path when that
 * bet does not pay off in a run. An empty turn has two common causes on local
 * runtimes, each with a specific fix that beats re-asking the same model:
 *
 *   discarded turn  — the model called a tool that was not offered, so Ollama
 *                     dropped the whole reply. If the tool budget withheld MCP
 *                     tools for this run, offer the FULL set and try again.
 *   empty again     — the model is out of its depth. Step up ONE rung on the
 *                     ladder of installed, tool-capable local models (largest
 *                     eligible first is wrong: the next size up is usually
 *                     enough, and every rung costs latency). The user's own
 *                     oversized local pick is the last rung — slow beats
 *                     failing — but cloud is never a rung.
 *
 * Each remedy is applied at most once per run; after that the loop's existing
 * nudge → stall path takes over, so escalation can only shorten a failure,
 * never extend it. Pure so the policy is unit-tested.
 */
import { modelParamsB } from '../router/agentRouter';

export type EscalationStep =
  | { kind: 'restore-tools' }
  | { kind: 'switch-model'; model: string }
  | null;

export interface EscalationInput {
  /** Runtime discarded the reply (tool call to an unlisted tool). */
  discarded: boolean;
  /** MCP tools were withheld by the budget for this run. */
  toolsPruned: boolean;
  /** Already restored the full tool set once. */
  toolsRestored: boolean;
  /** Already switched model once. */
  modelEscalated: boolean;
  /** Models larger than the current one, smallest first. */
  ladder: string[];
}

export function nextEscalation(i: EscalationInput): EscalationStep {
  if (i.discarded && i.toolsPruned && !i.toolsRestored) return { kind: 'restore-tools' };
  if (!i.modelEscalated && i.ladder.length) return { kind: 'switch-model', model: i.ladder[0] };
  return null;
}

export interface LadderInput {
  current: string | null;
  /** Installed/configured local model tags. */
  candidates: string[];
  /** Agent budget on this machine (billions of params). */
  capB: number;
  knownBadToolCalls: Set<string>;
  /** The picker's model, if local — allowed past the cap as a last rung. */
  userLocalPick: string | null;
}

const EMBEDDING_LIKE = /embed|nomic|bge|e5-/i;

/** Installed local models strictly larger than `current`, ascending by size:
 *  every eligible model within the cap, then the user's oversized local pick
 *  if it is larger still. Unsized tags and known tool-call failures never
 *  appear. Empty when there is nowhere to go. */
export function escalationLadder(i: LadderInput): string[] {
  // No current model, or one whose size the tag does not state (cloud ids,
  // "qwen3.5:latest"): there is no basis for "larger", so no ladder. This is
  // also what keeps a cloud run from ever being escalated onto a local model.
  if (!i.current) return [];
  const floor = modelParamsB(i.current);
  if (!Number.isFinite(floor)) return [];
  const seen = new Set<string>();
  const rungs: { name: string; b: number }[] = [];
  for (const name of i.candidates) {
    if (seen.has(name) || name === i.current) continue;
    seen.add(name);
    if (i.knownBadToolCalls.has(name) || EMBEDDING_LIKE.test(name)) continue;
    const b = modelParamsB(name);
    if (!Number.isFinite(b) || b <= floor || b > i.capB) continue;
    rungs.push({ name, b });
  }
  rungs.sort((a, b) => a.b - b.b);
  const out = rungs.map(r => r.name);
  const pick = i.userLocalPick;
  if (pick && pick !== i.current && !out.includes(pick)) {
    const b = modelParamsB(pick);
    if (Number.isFinite(b) && b > floor && b > i.capB && !i.knownBadToolCalls.has(pick)) out.push(pick);
  }
  return out;
}
