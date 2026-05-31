/**
 * WorkflowsTab — empty state for the Workflows room. A workflow is anything
 * Artha runs on a plan or schedule (daily summaries, batch file moves,
 * scheduled web pulls). Phase 1 ships the surface + two starter CTAs; the
 * real lists (Scheduled / Runs / Artifacts) come in a follow-up — for now
 * those live inside Workspace Settings → Runs & History.
 *
 * Design rationale:
 *   - Define the noun in plain language; users don't know "workflow" by
 *     default.
 *   - Exactly two CTAs (Schedule a task / Repeat a past chat) — the latter
 *     is Artha's unique "conversation → automation" angle.
 *   - No cross-project leakage in the empty state (keeps the privacy story).
 */
import { CalendarClock, RotateCcw, Workflow as WorkflowIcon, ArrowRight } from 'lucide-react';
import { useChatStore } from '../../stores/chat';

/** A starter template the user can adopt with one click. */
interface Template {
  title: string;
  description: string;
  prompt: string;
}

const TEMPLATES: Template[] = [
  {
    title: 'Daily folder digest',
    description: 'Each morning, summarise what changed in the project folder.',
    prompt: 'Every weekday at 9am, scan this project folder for files modified in the last 24 hours and summarise them in one short note.',
  },
  {
    title: 'Backup screenshots',
    description: 'Sweep the Desktop into a dated screenshots folder weekly.',
    prompt: 'Every Sunday at 10am, move new screenshots from my Desktop into a dated folder under ~/Pictures/Screenshots.',
  },
];

/** The Workflows tab canvas. */
export default function WorkflowsTab() {
  const { openWorkspaceSettings } = useChatStore();

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-3xl mx-auto px-8 py-12">

        {/* ── Sub-nav (dot-separated, not nested tabs) ─────────────────── */}
        <div className="flex items-center gap-3 text-[11px] text-artha-subtle mb-10">
          <span className="text-artha-text font-medium">Scheduled</span>
          <span>·</span>
          <span>Runs</span>
          <span>·</span>
          <span>Artifacts</span>
          <span className="ml-auto opacity-70">Coming next — for now these live in Workspace Settings → Runs &amp; History</span>
        </div>

        {/* ── Hero ─────────────────────────────────────────────────────── */}
        <div className="text-center mb-12">
          <div className="inline-flex items-center justify-center w-12 h-12 rounded-2xl bg-artha-accent/10 border border-artha-accent/30 mb-4">
            <WorkflowIcon size={20} className="text-artha-accent" />
          </div>
          <h1 className="text-lg font-semibold text-artha-text mb-2">No workflows yet</h1>
          <p className="text-sm text-artha-muted max-w-md mx-auto leading-relaxed">
            A <span className="text-artha-text">workflow</span> is anything Artha runs on a plan or schedule —
            daily summaries, batch file moves, scheduled web pulls.
          </p>
        </div>

        {/* ── Two CTAs ────────────────────────────────────────────────── */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-12">
          <button
            onClick={() => openWorkspaceSettings('scheduler')}
            className="text-left p-4 rounded-xl border border-artha-border bg-artha-surface hover:border-artha-accent transition-colors group"
          >
            <CalendarClock size={16} className="text-artha-accent mb-2" />
            <h3 className="text-sm font-semibold text-artha-text mb-1">Schedule a task</h3>
            <p className="text-xs text-artha-muted mb-3 leading-relaxed">
              Cron expression or one-shot. The agent runs and pings you when done.
            </p>
            <span className="inline-flex items-center gap-1 text-xs text-artha-accent group-hover:gap-2 transition-all">
              Open scheduler <ArrowRight size={11} />
            </span>
          </button>

          <button
            onClick={() => openWorkspaceSettings('timetravel')}
            className="text-left p-4 rounded-xl border border-artha-border bg-artha-surface hover:border-artha-accent transition-colors group"
          >
            <RotateCcw size={16} className="text-artha-accent mb-2" />
            <h3 className="text-sm font-semibold text-artha-text mb-1">Repeat a past chat</h3>
            <p className="text-xs text-artha-muted mb-3 leading-relaxed">
              Pick a previous conversation and replay it as a scheduled or one-shot run.
            </p>
            <span className="inline-flex items-center gap-1 text-xs text-artha-accent group-hover:gap-2 transition-all">
              Open time travel <ArrowRight size={11} />
            </span>
          </button>
        </div>

        {/* ── Starter templates ────────────────────────────────────────── */}
        <div>
          <h2 className="text-[10px] uppercase tracking-wider text-artha-subtle font-semibold mb-3">
            Starter templates
          </h2>
          <div className="space-y-2">
            {TEMPLATES.map(t => (
              <div
                key={t.title}
                className="p-3 rounded-lg border border-artha-border bg-artha-surface2/40 hover:bg-artha-surface2 transition-colors"
              >
                <h3 className="text-xs font-medium text-artha-text mb-0.5">{t.title}</h3>
                <p className="text-[11px] text-artha-muted leading-relaxed mb-2">{t.description}</p>
                <code className="block text-[10px] text-artha-subtle font-mono leading-relaxed">
                  &ldquo;{t.prompt}&rdquo;
                </code>
              </div>
            ))}
          </div>
          <p className="text-[11px] text-artha-subtle mt-3">
            Templates are illustrative — paste any of these into a chat and ask Artha to schedule it.
          </p>
        </div>
      </div>
    </div>
  );
}
