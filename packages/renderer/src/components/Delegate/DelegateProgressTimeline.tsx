/**
 * DelegateProgressTimeline — the vertical stage tracker for a delegated task.
 *
 * Renders the six user-facing stages of the Delegate flow (understand → gather
 * context → plan → run → review → complete) and derives each stage's state
 * (done / active / paused / pending) from the current `DelegateStatus`. The
 * `awaiting_confirmation` status is shown as a "paused" marker on the run stage
 * so it's obvious Artha is waiting on the user, not stalled.
 */
import { Loader2, Check, Pause, Brain, Database, ListChecks, Cog, SearchCheck, Flag } from 'lucide-react';
import type { DelegateStatus } from '../../services/delegateService';
import { tabTheme } from '../../lib/tabTheme';

interface Stage {
  /** The status the stage becomes "active" on. */
  key: DelegateStatus;
  label: string;
  icon: typeof Brain;
}

/** The ordered stages shown to the user. `awaiting_confirmation`, `idle`, and
 *  `failed` are lifecycle states but not their own rows — they're reflected as
 *  paused/hidden/error states on the rows below. */
const STAGES: Stage[] = [
  { key: 'understanding',      label: 'Understanding request',       icon: Brain },
  { key: 'retrieving_context', label: 'Gathering context',           icon: Database },
  { key: 'planning',           label: 'Planning execution',          icon: ListChecks },
  { key: 'executing',          label: 'Running agents & workflows',  icon: Cog },
  { key: 'reviewing',          label: 'Reviewing output',            icon: SearchCheck },
  { key: 'completed',          label: 'Completed',                   icon: Flag },
];

type StageState = 'done' | 'active' | 'paused' | 'pending' | 'review';

/** The stage a status maps onto. `awaiting_confirmation` rests on `planning`
 *  (planning is finished; we're paused before running). */
function activeStageIndex(status: DelegateStatus): number {
  if (status === 'awaiting_confirmation') return STAGES.findIndex((s) => s.key === 'planning');
  const i = STAGES.findIndex((s) => s.key === status);
  return i;
}

const LAST = STAGES.length - 1;

export default function DelegateProgressTimeline({ status }: { status: DelegateStatus }) {
  const theme = tabTheme('delegate');
  const activeIdx = activeStageIndex(status);
  const paused = status === 'awaiting_confirmation';

  const stateFor = (i: number): StageState => {
    if (status === 'completed') return 'done';
    // needs_review: the run finished but was NOT machine-verified — every stage
    // up to the last is done, and the final stage is 'review' (amber), never a
    // green "Completed".
    if (status === 'needs_review') return i < LAST ? 'done' : 'review';
    if (i < activeIdx) return 'done';
    if (i === activeIdx) return paused ? 'paused' : 'active';
    return 'pending';
  };

  return (
    <div className="rounded-xl border border-artha-border bg-artha-surface p-4">
      <h2 className="text-[10px] uppercase tracking-wider text-artha-subtle font-semibold mb-4">
        Progress
      </h2>
      <ol className="space-y-0.5">
        {STAGES.map((stage, i) => {
          const state = stateFor(i);
          const Icon = stage.icon;
          const isLast = i === STAGES.length - 1;
          return (
            <li key={stage.key} className="flex gap-3">
              {/* Marker + connector rail */}
              <div className="flex flex-col items-center">
                <div
                  className="flex items-center justify-center w-7 h-7 rounded-full border transition-colors"
                  style={
                    state === 'done'
                      ? { backgroundColor: theme.accent, borderColor: theme.accent }
                      : state === 'active' || state === 'paused'
                        ? { borderColor: theme.accent, backgroundColor: theme.soft }
                        : undefined
                  }
                >
                  {state === 'done' ? (
                    <Check size={14} className="text-white" />
                  ) : state === 'active' ? (
                    <Loader2 size={13} className="animate-spin" style={{ color: theme.accent }} />
                  ) : state === 'paused' ? (
                    <Pause size={12} style={{ color: theme.accent }} />
                  ) : state === 'review' ? (
                    <Icon size={13} className="text-artha-warn" />
                  ) : (
                    <Icon size={13} className="text-artha-subtle" />
                  )}
                </div>
                {!isLast && (
                  <div
                    className="w-px flex-1 my-1 min-h-[14px]"
                    style={{ backgroundColor: state === 'done' ? theme.accent : 'rgb(var(--artha-border))' }}
                  />
                )}
              </div>

              {/* Label — the final stage reads "Ready for review" (not
                  "Completed") when the run finished without verification. */}
              <div className={`pb-3 ${isLast ? '' : 'pt-0.5'}`}>
                <span
                  className={`text-sm ${
                    state === 'pending' ? 'text-artha-subtle'
                      : state === 'review' ? 'text-artha-warn font-medium'
                      : 'text-artha-text'
                  } ${state === 'active' ? 'font-medium' : ''}`}
                >
                  {state === 'review' && isLast ? 'Ready for your review' : stage.label}
                </span>
                {state === 'paused' && (
                  <span className="ml-2 text-[11px] text-artha-muted">awaiting your approval</span>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
