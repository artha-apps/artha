/**
 * Pure view logic for the Delegate header's goal chip — kept out of the
 * component so the wording rules are unit-testable without a DOM.
 */

/** The goal fields the chip needs (subset of preload's GoalView). */
export interface GoalChipInput {
  status: 'active' | 'paused' | 'blocked' | 'completed' | 'terminated';
  blockedReason: string | null;
  elapsedMs: number;
}

/** Which control buttons the chip offers for a status. */
export interface GoalChipControls {
  pause: boolean;
  resume: boolean;
  stop: boolean;
}

/** Short status label. "Needs you" for blocked — that's what it means to the user. */
export function goalStatusLabel(status: GoalChipInput['status']): string {
  switch (status) {
    case 'active': return 'Active';
    case 'paused': return 'Paused';
    case 'blocked': return 'Needs you';
    case 'completed': return 'Met — verified';
    case 'terminated': return 'Stopped';
  }
}

/** Controls per status. Finished goals (completed/terminated) offer none, and
 *  there is deliberately no "mark done" control anywhere. */
export function goalControls(status: GoalChipInput['status']): GoalChipControls {
  const open = status === 'active' || status === 'paused' || status === 'blocked';
  return {
    pause: status === 'active',
    resume: status === 'paused' || status === 'blocked',
    stop: open,
  };
}

/** Compact elapsed time: 45s, 12m, 1h 05m. */
export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, '0')}m`;
}
