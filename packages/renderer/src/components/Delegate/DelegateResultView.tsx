/**
 * DelegateResultView — the final, user-facing output of a completed delegation:
 * a prose summary, the files Artha generated, and suggested next actions.
 *
 * Files are display-only in the MVP (the mock engine names them but doesn't
 * write to disk). When Delegate is wired to the real engine, each file maps to
 * an `artifacts` row and these become openable.
 */
import { useState } from 'react';
import { CheckCircle2, ClipboardCheck, FileText, FileSpreadsheet, Presentation, StickyNote, ArrowRight, ChevronRight, Check, X, HelpCircle } from 'lucide-react';
import type { DelegateResult, DelegateResultFile } from '../../services/delegateService';
import { tabTheme } from '../../lib/tabTheme';

type Criterion = { description: string; outcome: string; predicate: string | null; required: boolean };
type Evidence = { kind: string; status: string; summary: string };

/** Small pass/fail/pending marker for a criterion outcome. */
function OutcomeIcon({ outcome }: { outcome: string }) {
  if (outcome === 'passed') return <Check size={12} className="text-artha-accent shrink-0" />;
  if (outcome === 'failed') return <X size={12} className="text-artha-danger shrink-0" />;
  return <HelpCircle size={12} className="text-artha-warn shrink-0" />;
}

/** Collapsible "why is this verified?" panel — lazy-loads the run's evidence. */
function EvidencePanel({ runId }: { runId: string }) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<{ criteria: Criterion[]; evidence: Evidence[]; empty: boolean } | null>(null);
  const [loading, setLoading] = useState(false);

  const toggle = async () => {
    const next = !open;
    setOpen(next);
    if (next && !data && window.artha?.delegate?.evidence) {
      setLoading(true);
      try { setData(await window.artha.delegate.evidence(runId)); } catch { /* best-effort */ }
      setLoading(false);
    }
  };

  return (
    <div className="mb-4 border-t border-artha-border pt-3">
      <button onClick={() => void toggle()} className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-artha-subtle font-semibold hover:text-artha-text transition-colors">
        <ChevronRight size={12} className={`transition-transform ${open ? 'rotate-90' : ''}`} />
        Evidence
      </button>
      {open && (
        <div className="mt-2 space-y-2">
          {loading && <p className="text-xs text-artha-muted">Loading…</p>}
          {data?.empty && (
            <p className="text-xs text-artha-muted">
              No machine-checkable evidence for this task — that's why it asks for your review rather than reporting itself verified.
            </p>
          )}
          {data && data.criteria.length > 0 && (
            <ul className="space-y-1">
              {data.criteria.map((c, i) => (
                <li key={i} className="flex items-start gap-2 text-xs text-artha-text">
                  <span className="mt-0.5"><OutcomeIcon outcome={c.outcome} /></span>
                  <span>{c.description} <span className="text-artha-subtle">({c.outcome})</span></span>
                </li>
              ))}
            </ul>
          )}
          {data && data.evidence.length > 0 && (
            <ul className="space-y-1 pt-1">
              {data.evidence.map((e, i) => (
                <li key={i} className="text-[11px] text-artha-muted">• {e.summary || `${e.kind}: ${e.status}`}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

/** Pick an icon for a result file by its coarse kind. */
function fileIcon(kind: DelegateResultFile['kind']) {
  switch (kind) {
    case 'sheet': return FileSpreadsheet;
    case 'slides': return Presentation;
    case 'note': return StickyNote;
    default: return FileText; // doc / pdf / anything else
  }
}

export default function DelegateResultView(
  { result, onDecide, runId }: { result: DelegateResult; onDecide?: (d: 'accepted' | 'rejected') => void; runId?: string | null },
) {
  const theme = tabTheme('delegate');

  // The honest state comes from the backend projection (bodhi/delegateOutcome).
  // verified === true → system-evidenced completion (green). Otherwise the run
  // finished but was NOT machine-verified → "ready for your review" (amber). The
  // mock engine omits these; fall back to the not-verified framing.
  const verified = result.verified === true;
  const label = result.outcomeLabel ?? 'Ready for your review';
  // Offer Accept/Reject only for a genuinely reviewable result (not verified,
  // and the host wired a handler). Accepting is what turns review into an
  // honest "Completed" — a recorded human sign-off, not a model claim.
  const canDecide = !verified && !!onDecide;

  return (
    <div className="rounded-xl border border-artha-border bg-artha-surface p-4">
      <div className="flex items-center gap-2 mb-3">
        {verified
          ? <CheckCircle2 size={16} style={{ color: theme.accent }} />
          : <ClipboardCheck size={16} className="text-artha-warn" />}
        <h2 className="text-sm font-semibold text-artha-text">{label}</h2>
        <span className="ml-auto px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide bg-artha-warn/15 text-artha-warn">
          Beta
        </span>
      </div>

      {/* Honest outcome line, straight from the evidence-based projection —
          never a green check implying proof we don't have. */}
      <div
        className={`mb-3 px-3 py-2 rounded-lg text-xs leading-relaxed text-artha-text border ${
          verified
            ? 'bg-artha-accent/10 border-artha-accent/25'
            : 'bg-artha-warn/10 border-artha-warn/25'
        }`}
      >
        <span className="font-medium">
          {result.outcomeMessage
            ?? 'The run finished — completion is not verified.'}
        </span>{' '}
        {result.requiredAction && (
          <span className="text-artha-muted">{result.requiredAction}</span>
        )}
        {!result.outcomeMessage && (
          <span className="text-artha-muted">
            Delegate reports what the agent did, not proof that your objective was met. Open
            Workflows → Runs to inspect the actual tool calls and results.
          </span>
        )}
      </div>

      {/* Accept / request-changes on a reviewable result. Accept records a
          human sign-off (approval_granted) → the task honestly becomes
          Completed; Request changes keeps it open for a follow-up. */}
      {canDecide && (
        <div className="flex items-center gap-2 mb-4">
          <button
            onClick={() => onDecide!('accepted')}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold text-white transition-colors"
            style={{ backgroundColor: theme.accent }}
          >
            <CheckCircle2 size={13} /> Accept result
          </button>
          <button
            onClick={() => onDecide!('rejected')}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-artha-muted border border-artha-border hover:text-artha-text hover:border-artha-muted transition-colors"
          >
            Request changes
          </button>
        </div>
      )}

      {/* Inspectable evidence — WHY this is (or isn't) verified. */}
      {runId && <EvidencePanel runId={runId} />}

      {/* Summary — the model's own words. Labelled as such so it is never
          mistaken for a system-verified statement of outcome. */}
      <h3 className="text-[10px] uppercase tracking-wider text-artha-subtle font-semibold mb-1">
        Agent summary
      </h3>
      <p className="text-sm text-artha-text leading-relaxed mb-4">{result.summary}</p>

      {/* Generated files */}
      {result.files.length > 0 && (
        <div className="mb-4">
          <h3 className="text-[10px] uppercase tracking-wider text-artha-subtle font-semibold mb-2">
            Generated files
          </h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {result.files.map((f) => {
              const Icon = fileIcon(f.kind);
              return (
                <div
                  key={f.name}
                  className="flex items-center gap-2.5 p-2.5 rounded-lg border border-artha-border bg-artha-surface2/40"
                >
                  <Icon size={16} style={{ color: theme.accent }} className="shrink-0" />
                  <span className="text-sm text-artha-text truncate">{f.name}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Next actions */}
      {result.nextActions.length > 0 && (
        <div>
          <h3 className="text-[10px] uppercase tracking-wider text-artha-subtle font-semibold mb-2">
            Next actions
          </h3>
          <ul className="space-y-1.5">
            {result.nextActions.map((a) => (
              <li key={a} className="flex items-center gap-2 text-sm text-artha-muted">
                <ArrowRight size={13} style={{ color: theme.accent }} className="shrink-0" />
                {a}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
