/**
 * Pure helpers for the inline ask_user card (components/Chat/AskUserCard.tsx)
 * and the pending-interactions store. No React, no DOM — unit-tested in node.
 */

/** One option offered by the agent. */
export interface AskOptionView { label: string; description?: string }

/** One question as the main process normalised it (agent/askUser.ts). */
export interface AskQuestionView {
  id: string;
  question: string;
  options: AskOptionView[];
  allow_custom: boolean;
  multi: boolean;
}

/** The user's in-progress answer to one question. */
export interface AskDraft { selected: string[]; custom: string }

/** Minimal interaction shape the renderer keeps (mirrors InteractionDTO). */
export interface PendingInteraction {
  id: string;
  kind: 'ask' | 'plan' | 'handoff' | 'confirm';
  run_id: string;
  payload: Record<string, unknown>;
  created_at: number;
}

/** Toggle an option: single-select replaces, multi-select adds/removes. */
export function toggleOption(draft: AskDraft, q: AskQuestionView, label: string): AskDraft {
  const has = draft.selected.includes(label);
  if (!q.multi) return { ...draft, selected: has ? [] : [label] };
  return { ...draft, selected: has ? draft.selected.filter(l => l !== label) : [...draft.selected, label] };
}

/** A card can be submitted once every question has a choice or custom text. */
export function canSubmit(questions: AskQuestionView[], drafts: Record<string, AskDraft>): boolean {
  return questions.every(q => {
    const d = drafts[q.id];
    return !!d && (d.selected.length > 0 || (q.allow_custom && d.custom.trim().length > 0));
  });
}

/** The answer object sent back over `interactions:respond`. */
export function buildAnswers(questions: AskQuestionView[], drafts: Record<string, AskDraft>):
  Record<string, { selected: string[]; custom?: string }> {
  const out: Record<string, { selected: string[]; custom?: string }> = {};
  for (const q of questions) {
    const d = drafts[q.id] ?? { selected: [], custom: '' };
    const custom = q.allow_custom ? d.custom.trim() : '';
    out[q.id] = { selected: d.selected, ...(custom ? { custom } : {}) };
  }
  return out;
}

/** Read questions out of an ask interaction's payload defensively. */
export function questionsOf(i: PendingInteraction): AskQuestionView[] {
  const qs = i.payload?.questions;
  return Array.isArray(qs) ? qs as AskQuestionView[] : [];
}

/** Add (or replace) an interaction in the pending list, oldest first. */
export function upsertPending(list: PendingInteraction[], i: PendingInteraction): PendingInteraction[] {
  const rest = list.filter(x => x.id !== i.id);
  return [...rest, i].sort((a, b) => a.created_at - b.created_at);
}

/** Drop a resolved interaction from the pending list. */
export function removePending(list: PendingInteraction[], id: string): PendingInteraction[] {
  return list.filter(x => x.id !== id);
}
