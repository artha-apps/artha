/**
 * The approval modal keeps showing a prompt until the main process says it is
 * settled, and then shows the next one still waiting. Prompts wait until
 * answered, so a prompt that drops off the screen would wait forever.
 */
import { describe, it, expect } from 'vitest';
import { approvalPromptToShow } from './pendingPrompts';
import type { ToolApprovalRequest } from '../stores/chat';

const req = (approvalId: string, toolName = 'fs_copy_file'): ToolApprovalRequest => ({
  approvalId, workflowId: `wf-${approvalId}`, sessionId: 's1', toolName, argsPreview: '{}', note: '',
});
const confirm = (r: ToolApprovalRequest) => ({ id: r.approvalId, kind: 'confirm', payload: r });

describe('approvalPromptToShow', () => {
  it('keeps the prompt on screen while it is still waiting (another run ending must not clear it)', () => {
    const a = req('a'); const b = req('b');
    expect(approvalPromptToShow(a, [confirm(a), confirm(b)])).toBe(a);   // same object: no re-render
    expect(approvalPromptToShow(b, [confirm(a), confirm(b)])).toBe(b);   // even if it is not the oldest
  });

  it('when the shown prompt is settled, shows the oldest one still waiting', () => {
    const a = req('a'); const b = req('b'); const c = req('c');
    expect(approvalPromptToShow(a, [confirm(b), confirm(c)])).toEqual(b);
    expect(approvalPromptToShow(null, [confirm(b), confirm(c)])).toEqual(b);
  });

  it('shows nothing when no approval is waiting', () => {
    expect(approvalPromptToShow(req('a'), [])).toBeNull();
    expect(approvalPromptToShow(null, [])).toBeNull();
  });

  it('ignores other kinds of interaction and payloads the modal could not answer', () => {
    const b = req('b');
    const pending = [
      { id: 'q1', kind: 'ask', payload: { questions: [] } },
      { id: 'p1', kind: 'plan', payload: { workflowId: 'wf' } },
      { id: 'broken', kind: 'confirm', payload: { note: 'no ids' } },
      confirm(b),
    ];
    expect(approvalPromptToShow(null, pending)).toEqual(b);
    expect(approvalPromptToShow(null, pending.slice(0, 3))).toBeNull();
  });
});
