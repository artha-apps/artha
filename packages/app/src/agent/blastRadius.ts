/**
 * Pre-Flight Blast-Radius estimation.
 *
 * A plan card that lists step *descriptions* asks the user to approve on faith.
 * This turns the plan into an informed decision by deriving, BEFORE execution,
 * the shape of what it will touch: how many destructive vs additive operations,
 * whether it reaches the network, whether it's reversible, and a rough token
 * cost. It is intentionally HEURISTIC and labelled as an estimate in the UI —
 * honest about being a forecast, not a guarantee.
 *
 * Pure + dependency-free so it can be unit-tested and reused by any surface.
 */
import type { WorkflowStep } from './orchestrator';

/** The estimated impact of a plan, surfaced in the approval card header. */
export interface BlastRadius {
  /** Destructive ops (delete). The number that should make a user look twice. */
  deletions: number;
  /** Files moved/renamed. */
  moves: number;
  /** Files/folders created or written. */
  writes: number;
  /** Whether the plan reaches the network (web/browser tools). */
  touchesWeb: boolean;
  /** Whether the plan hands off to a sub-capability. */
  delegates: boolean;
  /** True when nothing in the plan is destructive (no deletes) — i.e. the plan
   *  is broadly reversible. */
  reversible: boolean;
  /** Rough token estimate for the whole run. Labelled "≈" in the UI. */
  estTokens: number;
  /** One-line human summary, e.g. "3 moves · reaches the web · reversible". */
  summary: string;
}

const DELETE_TOOLS = new Set(['fs_delete_file']);
const MOVE_TOOLS = new Set(['fs_move_file', 'fs_move_batch', 'fs_rename_file']);
const WRITE_TOOLS = new Set(['fs_write_file', 'fs_create_directory', 'fs_copy_file', 'docs_generate']);

/** Does a step (by toolName, or failing that its description text) look like it
 *  belongs to `set`/keywords? Plans don't always populate toolName, so we fall
 *  back to scanning the description. */
function stepHits(step: WorkflowStep, tools: Set<string>, keywords: RegExp): boolean {
  if (step.toolName && tools.has(step.toolName)) return true;
  if (!step.toolName && keywords.test(step.description)) return true;
  return false;
}

/** Estimate the blast radius of a plan from its steps. */
export function estimateBlastRadius(steps: WorkflowStep[], goal = ''): BlastRadius {
  let deletions = 0;
  let moves = 0;
  let writes = 0;
  let touchesWeb = false;
  let delegates = false;

  for (const s of steps) {
    if (stepHits(s, DELETE_TOOLS, /\b(delete|remove|trash|erase)\b/i)) deletions++;
    if (stepHits(s, MOVE_TOOLS, /\b(move|rename|relocate)\b/i)) moves++;
    if (stepHits(s, WRITE_TOOLS, /\b(create|write|generate|save|copy)\b/i)) writes++;
    const tn = s.toolName ?? '';
    if (tn.startsWith('web_') || tn.startsWith('browser_') ||
        (!s.toolName && /\b(web|browser|online|fetch|search|navigate|website)\b/i.test(s.description))) {
      touchesWeb = true;
    }
    if (tn === 'invoke_capability') delegates = true;
  }
  // The goal itself can reveal web intent even when steps are vague.
  if (!touchesWeb && /\b(web|online|google|search the|look up|website|url|http)\b/i.test(goal)) {
    touchesWeb = true;
  }

  // Rough cost model: a base for the system prompt + think phase, plus a
  // per-step allowance (tool round-trips dominate). Web steps cost more (page
  // payloads re-enter context). Deliberately coarse — it's a forecast.
  const estTokens =
    900 +
    steps.length * 1200 +
    (touchesWeb ? 2500 : 0) +
    (delegates ? 3000 : 0);

  const reversible = deletions === 0;

  const parts: string[] = [];
  if (deletions) parts.push(`${deletions} deletion${deletions === 1 ? '' : 's'}`);
  if (moves) parts.push(`${moves} move${moves === 1 ? '' : 's'}`);
  if (writes) parts.push(`${writes} write${writes === 1 ? '' : 's'}`);
  if (touchesWeb) parts.push('reaches the web');
  if (delegates) parts.push('delegates to a capability');
  parts.push(reversible ? 'reversible' : 'NOT reversible');
  const summary = parts.join(' · ');

  return { deletions, moves, writes, touchesWeb, delegates, reversible, estTokens, summary };
}
