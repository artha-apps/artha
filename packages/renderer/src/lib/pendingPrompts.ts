/**
 * Which approval prompt the modal should show.
 *
 * Approval prompts wait until the user answers; they never time out. The app
 * has ONE modal, so two things must hold or a run could wait forever with
 * nothing on screen:
 *   - a prompt stays up until the main process says it is settled (another
 *     run ending must not clear it), and
 *   - when the shown prompt is settled, the next one still waiting is shown.
 *
 * The main process is the source of truth: `listPendingInteractions()` returns
 * every interaction that can still be answered, oldest first. This module is
 * the pure decision; App.tsx applies it.
 */
import type { ToolApprovalRequest } from '../stores/chat';

/** The slice of a pending interaction this needs. */
export interface PendingInteractionLike {
  id: string;
  kind: string;
  payload: unknown;
}

/**
 * The prompt to show given what is on screen (`current`) and what the main
 * process says is still waiting (`pending`, oldest first):
 *   - `current` is still waiting → keep it (same object, so nothing re-renders);
 *   - otherwise the oldest waiting approval, or null when none is.
 * A confirm's interaction id is its approvalId.
 */
export function approvalPromptToShow(
  current: ToolApprovalRequest | null,
  pending: PendingInteractionLike[],
): ToolApprovalRequest | null {
  const confirms = pending.filter(i => i.kind === 'confirm');
  if (current && confirms.some(c => c.id === current.approvalId)) return current;
  for (const c of confirms) {
    const p = c.payload as Partial<ToolApprovalRequest> | null;
    // Only a payload the modal can render and answer.
    if (p && typeof p.approvalId === 'string' && typeof p.toolName === 'string') return p as ToolApprovalRequest;
  }
  return null;
}
