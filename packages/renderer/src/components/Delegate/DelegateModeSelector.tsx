/**
 * DelegateModeSelector — permission mode for the next Delegate task.
 *
 * Delegate approves the plan itself before anything runs, so only the modes
 * that matter after approval are offered: Ask, Accept edits, Auto. "Default"
 * follows the Autonomous actions setting. The choice is applied to the task's
 * backing session when it starts (delegate:start).
 */
import { useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import { getDelegateMode, setDelegateMode } from '../../services/delegateService';

type DelegateMode = 'ask' | 'accept_edits' | 'auto';

export default function DelegateModeSelector() {
  const [mode, setMode] = useState<DelegateMode | null>(getDelegateMode());

  /** Update both the local view and the engine's next-task mode. */
  const change = (value: string) => {
    const next = value === '' ? null : (value as DelegateMode);
    setMode(next);
    setDelegateMode(next);
  };

  return (
    <label className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md border border-artha-border text-[11px] text-artha-muted">
      <ShieldCheck size={11} className="text-artha-accent" />
      <select
        value={mode ?? ''}
        onChange={e => change(e.target.value)}
        className="bg-transparent text-[11px] text-artha-text focus:outline-none cursor-pointer"
        aria-label="Permission mode for this task"
      >
        <option value="">Permissions: Default</option>
        <option value="ask">Permissions: Ask</option>
        <option value="accept_edits">Permissions: Accept edits</option>
        <option value="auto">Permissions: Auto</option>
      </select>
    </label>
  );
}
