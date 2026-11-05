/**
 * KeepAwakeSettings — toggles for keeping the computer awake while Artha is
 * running a task. Off by default; the battery toggle only matters when the
 * main one is on. Changes apply immediately (the main process re-evaluates
 * its power-save blocker on every change).
 */
import { useEffect, useState } from 'react';
import { BatteryCharging } from 'lucide-react';

type KeepAwake = { keepAwakeWhileRunning: boolean; keepAwakeOnBattery: boolean };

/** One labelled on/off switch row. */
function SwitchRow(props: { title: string; hint: string; on: boolean; disabled?: boolean; onToggle: () => void }) {
  return (
    <div className={`flex items-center justify-between px-4 py-4 rounded-xl bg-artha-s2 border border-artha-border ${props.disabled ? 'opacity-50' : ''}`}>
      <div>
        <p className="text-sm font-semibold text-artha-text">{props.title}</p>
        <p className="text-xs text-artha-muted mt-0.5">{props.hint}</p>
      </div>
      <button
        onClick={props.onToggle}
        disabled={props.disabled}
        role="switch"
        aria-checked={props.on}
        className={`relative w-11 h-6 rounded-full transition-colors shrink-0 ${props.on ? 'bg-artha-accent' : 'bg-artha-text/15'}`}
      >
        <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white transition-transform ${props.on ? 'translate-x-5' : ''}`} />
      </button>
    </div>
  );
}

export default function KeepAwakeSettings() {
  const [s, setS] = useState<KeepAwake>({ keepAwakeWhileRunning: false, keepAwakeOnBattery: false });

  useEffect(() => {
    window.artha.settings.getKeepAwake().then(setS).catch(() => {});
  }, []);

  /** Persist one field and adopt the main process's resulting state. */
  const update = async (patch: Partial<KeepAwake>) => {
    setS(prev => ({ ...prev, ...patch }));
    try { setS(await window.artha.settings.setKeepAwake(patch)); } catch { /* keep optimistic state */ }
  };

  return (
    <div className="mb-6">
      <div className="flex items-center gap-2 mb-3">
        <BatteryCharging size={16} className="text-artha-accent" />
        <h3 className="text-sm font-semibold text-artha-text">Keep awake while running</h3>
      </div>
      <div className="space-y-2">
        <SwitchRow
          title="Keep the computer awake during tasks"
          hint="Prevents sleep while a task is running; released as soon as it finishes."
          on={s.keepAwakeWhileRunning}
          onToggle={() => update({ keepAwakeWhileRunning: !s.keepAwakeWhileRunning })}
        />
        <SwitchRow
          title="Also on battery"
          hint="Off: on battery the computer may sleep, and an interrupted task is offered for resume."
          on={s.keepAwakeOnBattery}
          disabled={!s.keepAwakeWhileRunning}
          onToggle={() => update({ keepAwakeOnBattery: !s.keepAwakeOnBattery })}
        />
      </div>
    </div>
  );
}
