/**
 * DelegateTaskInput — the goal entry surface for the Delegate room. A large
 * textarea ("What would you like Artha to take care of?") plus the "Delegate"
 * CTA, with a few example goals the user can click to seed the input.
 *
 * This is the empty/idle state of the tab; once a goal is submitted the tab
 * switches to the working view (timeline + plan + result).
 */
import { useState } from 'react';
import { Send } from 'lucide-react';
import { tabTheme } from '../../lib/tabTheme';

/** Illustrative goals — clicking one fills the box (it doesn't auto-submit, so
 *  the user can tweak first). Mirrors the kinds of work Delegate is built for. */
const EXAMPLES = [
  'Research 20 competitors and summarize their positioning.',
  'Prepare a project brief from these files.',
  'Create a workflow to follow up with investor leads.',
  'Review this codebase and suggest improvements.',
  'Plan my product launch tasks.',
];

export default function DelegateTaskInput({ onSubmit }: { onSubmit: (goal: string) => void }) {
  const theme = tabTheme('delegate');
  const [value, setValue] = useState('');

  const submit = () => {
    const trimmed = value.trim();
    if (trimmed) onSubmit(trimmed);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // ⌘/Ctrl+Enter submits, matching the chat composer's muscle memory.
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div className="max-w-2xl mx-auto px-8 py-12">
      {/* Hero */}
      <div className="text-center mb-8">
        <div
          className="inline-flex items-center justify-center w-12 h-12 rounded-2xl mb-4 border"
          style={{ backgroundColor: theme.soft, borderColor: `${theme.accent}4D` }}
        >
          <Send size={20} style={{ color: theme.accent }} />
        </div>
        <h1 className="text-lg font-semibold text-artha-text mb-2">Hand work over to Artha</h1>
        <p className="text-sm text-artha-muted max-w-md mx-auto leading-relaxed">
          Give Artha a goal. It plans, coordinates, and gets it done.
        </p>
      </div>

      {/* Input */}
      <div className="rounded-2xl border border-artha-border bg-artha-surface p-3 shadow-soft">
        <textarea
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={onKeyDown}
          rows={3}
          placeholder="What would you like Artha to take care of?"
          className="w-full resize-none bg-transparent text-sm text-artha-text placeholder:text-artha-subtle focus:outline-none px-2 py-1.5"
          autoFocus
        />
        <div className="flex items-center justify-between mt-2 px-1">
          <span className="text-[11px] text-artha-subtle">⌘↵ to delegate</span>
          <button
            onClick={submit}
            disabled={!value.trim()}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-semibold text-white transition-opacity disabled:opacity-40 hover:opacity-90"
            style={{ backgroundColor: theme.accent }}
          >
            <Send size={14} /> Delegate
          </button>
        </div>
      </div>

      {/* Examples */}
      <div className="mt-8">
        <h2 className="text-[10px] uppercase tracking-wider text-artha-subtle font-semibold mb-3">
          Try delegating
        </h2>
        <div className="flex flex-col gap-2">
          {EXAMPLES.map((ex) => (
            <button
              key={ex}
              onClick={() => setValue(ex)}
              className="text-left px-3 py-2.5 rounded-lg border border-artha-border bg-artha-surface2/40 text-sm text-artha-muted hover:text-artha-text hover:border-artha-muted transition-colors"
            >
              {ex}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
