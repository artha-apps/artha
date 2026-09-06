/**
 * Auto-approval — when Artha runs a plan without stopping to ask.
 *
 * Founder direction (2026-09-05): Artha should think and make changes without
 * manual intervention. The planner marks plans that move, write or delete
 * files as `requiresApproval`, which used to pause EVERY such plan behind a
 * modal — including a two-file move that is one click to undo. That gate is
 * now decided by the plan's blast radius instead of its category:
 *
 *   auto  — nothing destructive (no deletes) and the estimate says reversible.
 *           Moves, copies, new files/folders and generated docs are tracked by
 *           agent/undo.ts, so the user reviews the outcome, not the intent,
 *           with one-tap revert. The run's card says it ran automatically.
 *   ask   — any delete, or anything the estimator cannot call reversible.
 *           Sends already have their own confirmation (external_actions);
 *           unattended (scheduled) runs already block confirm-tier tools.
 *
 * `users.settings_json.autonomousActions` (default true) turns this off; the
 * Router panel exposes it. Pure so the policy is unit-tested.
 */
import type { BlastRadius } from './blastRadius';

export interface AutoApproveInput {
  /** users.settings_json.autonomousActions (undefined ⇒ default on). */
  autonomous: boolean | undefined;
  blast: Pick<BlastRadius, 'deletions' | 'reversible' | 'moves' | 'writes'> | undefined;
}

export interface AutoApproveDecision {
  auto: boolean;
  /** Shown in the run card / status line. */
  reason: string;
}

export function decideAutoApprove(i: AutoApproveInput): AutoApproveDecision {
  if (i.autonomous === false) return { auto: false, reason: 'Autonomous actions are off — asking first.' };
  if (!i.blast) return { auto: false, reason: 'Could not estimate the impact — asking first.' };
  if (i.blast.deletions > 0) {
    return { auto: false, reason: `Plan deletes ${i.blast.deletions} item${i.blast.deletions === 1 ? '' : 's'} — asking first.` };
  }
  if (!i.blast.reversible) return { auto: false, reason: 'Plan is not reversible — asking first.' };
  const parts: string[] = [];
  if (i.blast.moves) parts.push(`${i.blast.moves} move${i.blast.moves === 1 ? '' : 's'}`);
  if (i.blast.writes) parts.push(`${i.blast.writes} write${i.blast.writes === 1 ? '' : 's'}`);
  const what = parts.length ? parts.join(' · ') : 'no file changes';
  return { auto: true, reason: `Running automatically — ${what}, reversible with Undo.` };
}
