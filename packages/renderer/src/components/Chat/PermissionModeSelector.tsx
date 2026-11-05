/**
 * PermissionModeSelector — per-chat permission mode in the chat header.
 *
 * Lets the user choose how much the agent may do in this chat without asking
 * (agent/modes.ts): Ask, Accept edits, Plan, Auto. "Default" clears the stored
 * mode so the chat follows the Autonomous actions setting. Unattended is not
 * selectable — scheduled / LAN runs are always unattended automatically.
 */
import { useEffect, useState } from 'react';
import { ShieldCheck } from 'lucide-react';

/** Selectable modes with a one-line explanation for the tooltip. */
const MODES: { id: 'ask' | 'accept_edits' | 'plan' | 'auto'; label: string; hint: string }[] = [
  { id: 'ask', label: 'Ask', hint: 'Show every plan that changes files before it runs.' },
  { id: 'accept_edits', label: 'Accept edits', hint: 'Edits inside attached folders run; deletes still ask.' },
  { id: 'plan', label: 'Plan', hint: 'Read-only until you approve the plan.' },
  { id: 'auto', label: 'Auto', hint: 'Reversible work runs; deletes and risky calls ask.' },
];

export default function PermissionModeSelector({ sessionId }: { sessionId: string }) {
  const [stored, setStored] = useState<string | null>(null);
  const [defaultMode, setDefaultMode] = useState<string>('auto');

  useEffect(() => {
    let live = true;
    window.artha.session.getMode(sessionId)
      .then(r => { if (live) { setStored(r.stored); setDefaultMode(r.defaultMode); } })
      .catch(() => { /* keep defaults */ });
    return () => { live = false; };
  }, [sessionId]);

  /** Persist the choice; '' = follow the default. */
  const change = async (value: string) => {
    const next = value === '' ? null : (value as 'ask' | 'accept_edits' | 'plan' | 'auto');
    setStored(next);
    try { await window.artha.session.setMode(sessionId, next); } catch { /* reload on next mount */ }
  };

  const current = MODES.find(m => m.id === (stored ?? defaultMode));
  const defaultLabel = MODES.find(m => m.id === defaultMode)?.label ?? defaultMode;

  return (
    <label
      className="flex items-center gap-1.5 px-2 py-1 rounded-md border border-artha-border text-[11px] text-artha-muted"
      title={current?.hint ?? ''}
    >
      <ShieldCheck size={11} className="text-artha-accent" />
      <span className="sr-only">Permission mode</span>
      <select
        value={stored ?? ''}
        onChange={e => change(e.target.value)}
        className="bg-transparent text-[11px] text-artha-text focus:outline-none cursor-pointer"
        aria-label="Permission mode"
      >
        <option value="">Default ({defaultLabel})</option>
        {MODES.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
      </select>
    </label>
  );
}
