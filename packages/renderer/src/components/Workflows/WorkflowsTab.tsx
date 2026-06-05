/**
 * WorkflowsTab — the operational hub. Everything about what Artha *runs* lives
 * here, relocated out of the Settings modal (which is now config-only):
 *
 *   Runs        — recent activity across all surfaces (ActivityPanel)
 *   Scheduled   — cron / one-shot tasks (SchedulerPanel)
 *   Artifacts   — files the agent generated (ArtifactsPanel)
 *   Receipts    — verified per-call audit trail (ReceiptsPanel)
 *   Provenance  — generated-document lineage (ProvenancePanel)
 *   Time Travel — fork any past run from a step (TimeTravelPanel)
 *
 * A horizontal sub-nav switches sections; the active section's existing panel
 * renders verbatim below it. Section is held in the store (`workflowsSection`)
 * so deep-links (e.g. the working-indicator pill) can jump straight to "Runs".
 */
import { Activity, CalendarClock, Archive, ReceiptText, ShieldCheck, History, type LucideIcon } from 'lucide-react';
import { useChatStore, type WorkflowsSection } from '../../stores/chat';
import ActivityPanel from './ActivityPanel';
import SchedulerPanel from '../Settings/SchedulerPanel';
import ArtifactsPanel from '../Settings/ArtifactsPanel';
import ReceiptsPanel from '../Settings/ReceiptsPanel';
import ProvenancePanel from '../Settings/ProvenancePanel';
import TimeTravelPanel from '../Settings/TimeTravelPanel';

interface SectionDef {
  id: WorkflowsSection;
  label: string;
  icon: LucideIcon;
  Panel: React.ComponentType;
}

const SECTIONS: SectionDef[] = [
  { id: 'runs',       label: 'Runs',        icon: Activity,      Panel: ActivityPanel },
  { id: 'scheduled',  label: 'Scheduled',   icon: CalendarClock, Panel: SchedulerPanel },
  { id: 'artifacts',  label: 'Artifacts',   icon: Archive,       Panel: ArtifactsPanel },
  { id: 'receipts',   label: 'Receipts',    icon: ReceiptText,   Panel: ReceiptsPanel },
  { id: 'provenance', label: 'Provenance',  icon: ShieldCheck,   Panel: ProvenancePanel },
  { id: 'timetravel', label: 'Time Travel', icon: History,       Panel: TimeTravelPanel },
];

export default function WorkflowsTab() {
  const { workflowsSection, setWorkflowsSection } = useChatStore();
  const active = SECTIONS.find(s => s.id === workflowsSection) ?? SECTIONS[0];
  const Panel = active.Panel;

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {/* Sub-nav */}
      <div className="flex items-center gap-1 px-4 py-2 border-b border-artha-border bg-artha-surface2/40 overflow-x-auto shrink-0">
        {SECTIONS.map(({ id, label, icon: Icon }) => {
          const isActive = id === active.id;
          return (
            <button
              key={id}
              onClick={() => setWorkflowsSection(id)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium whitespace-nowrap transition-colors
                ${isActive
                  ? 'bg-artha-surface text-artha-text border border-artha-accent/40'
                  : 'text-artha-muted hover:bg-artha-surface hover:text-artha-text border border-transparent'}`}
            >
              <Icon size={13} className={isActive ? 'text-artha-accent' : ''} />
              {label}
            </button>
          );
        })}
      </div>

      {/* Active section — the existing panel, rendered as-is. */}
      <div className="flex flex-1 overflow-hidden">
        <Panel />
      </div>
    </div>
  );
}
