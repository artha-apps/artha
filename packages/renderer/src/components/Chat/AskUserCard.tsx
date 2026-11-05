/**
 * AskUserCard — inline card for the agent's `ask_user` tool.
 *
 * The run is paused INSIDE the tool call; submitting answers resolves that
 * same call (no new chat turn), Cancel resolves it as `declined`. Rendered in
 * the Chat thread and in Delegate via <AskUserCards/>.
 */
import { useState } from 'react';
import { HelpCircle, Check, X } from 'lucide-react';
import { useInteractionsStore } from '../../stores/interactions';
import {
  toggleOption, canSubmit, buildAnswers, questionsOf,
  type AskDraft, type PendingInteraction,
} from '../../lib/askCard';

/** One pending ask_user interaction. */
function AskUserCard({ interaction, elsewhere }: { interaction: PendingInteraction; elsewhere?: boolean }) {
  const questions = questionsOf(interaction);
  const removeInteraction = useInteractionsStore(s => s.removeInteraction);
  const [drafts, setDrafts] = useState<Record<string, AskDraft>>(
    () => Object.fromEntries(questions.map(q => [q.id, { selected: [], custom: '' }])),
  );
  const [busy, setBusy] = useState(false);

  /** Send the decision; drop the card optimistically (the resolved event
   *  would remove it anyway). */
  const send = async (status: 'answered' | 'declined') => {
    setBusy(true);
    try {
      await window.artha.agent.respondInteraction(
        interaction.id, status, status === 'answered' ? buildAnswers(questions, drafts) : undefined,
      );
    } finally {
      removeInteraction(interaction.id);
    }
  };

  return (
    <div className="rounded-2xl border border-artha-accent/40 bg-artha-surface p-4 shadow-soft text-sm" role="group" aria-label="Artha has a question">
      <div className="flex items-center gap-2 mb-3">
        <HelpCircle size={15} className="text-artha-accent" />
        <span className="font-semibold text-artha-text">Artha needs your input to continue</span>
        {elsewhere && <span className="ml-auto text-[11px] text-artha-muted">from another task</span>}
      </div>
      <div className="space-y-4">
        {questions.map(q => {
          const d = drafts[q.id] ?? { selected: [], custom: '' };
          return (
            <fieldset key={q.id}>
              <legend className="text-artha-text mb-2">
                {q.question}
                {q.multi && <span className="ml-2 text-[11px] text-artha-muted">(choose any)</span>}
              </legend>
              <div className="flex flex-wrap gap-2">
                {q.options.map(o => {
                  const on = d.selected.includes(o.label);
                  return (
                    <button
                      key={o.label}
                      type="button"
                      aria-pressed={on}
                      title={o.description}
                      disabled={busy}
                      onClick={() => setDrafts(prev => ({ ...prev, [q.id]: toggleOption(d, q, o.label) }))}
                      className={`text-left px-3 py-1.5 rounded-lg border text-xs transition-colors ${
                        on ? 'border-artha-accent bg-artha-accent/12 text-artha-text'
                          : 'border-artha-border text-artha-muted hover:border-artha-muted hover:text-artha-text'}`}
                    >
                      <span className="font-medium">{o.label}</span>
                      {o.description && <span className="block text-[11px] text-artha-subtle">{o.description}</span>}
                    </button>
                  );
                })}
              </div>
              {q.allow_custom && (
                <input
                  value={d.custom}
                  disabled={busy}
                  onChange={e => setDrafts(prev => ({ ...prev, [q.id]: { ...d, custom: e.target.value } }))}
                  placeholder="Or type your own answer…"
                  className="mt-2 w-full px-3 py-1.5 rounded-lg border border-artha-border bg-artha-bg text-xs text-artha-text focus:outline-none focus:border-artha-accent"
                />
              )}
            </fieldset>
          );
        })}
      </div>
      <div className="flex justify-end gap-2 mt-4">
        <button
          type="button"
          disabled={busy}
          onClick={() => void send('declined')}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-artha-border text-xs text-artha-muted hover:text-artha-text"
        >
          <X size={12} /> Cancel
        </button>
        <button
          type="button"
          disabled={busy || !canSubmit(questions, drafts)}
          onClick={() => void send('answered')}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-artha-accent text-artha-on-accent text-xs font-medium disabled:opacity-50"
        >
          <Check size={12} /> Answer
        </button>
      </div>
    </div>
  );
}

/** All pending ask_user cards. Every pending question is shown wherever the
 *  user is — a run blocked on a hidden card would wait forever (parallel
 *  sub-tasks and delegated runs use their own sessions). Cards from a session
 *  other than `sessionId` are labelled so they are not mistaken for this chat. */
export default function AskUserCards({ sessionId }: { sessionId?: string | null }) {
  const asks = useInteractionsStore(s => s.asks);
  if (asks.length === 0) return null;
  return (
    <div className="space-y-3">
      {asks.map(a => (
        <AskUserCard
          key={a.id}
          interaction={a}
          elsewhere={sessionId !== undefined && a.payload?.sessionId !== sessionId}
        />
      ))}
    </div>
  );
}
