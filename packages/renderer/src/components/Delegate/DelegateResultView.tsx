/**
 * DelegateResultView — the final, user-facing output of a completed delegation:
 * a prose summary, the files Artha generated, and suggested next actions.
 *
 * Files are display-only in the MVP (the mock engine names them but doesn't
 * write to disk). When Delegate is wired to the real engine, each file maps to
 * an `artifacts` row and these become openable.
 */
import { CheckCircle2, FileText, FileSpreadsheet, Presentation, StickyNote, ArrowRight } from 'lucide-react';
import type { DelegateResult, DelegateResultFile } from '../../services/delegateService';
import { tabTheme } from '../../lib/tabTheme';

/** Pick an icon for a result file by its coarse kind. */
function fileIcon(kind: DelegateResultFile['kind']) {
  switch (kind) {
    case 'sheet': return FileSpreadsheet;
    case 'slides': return Presentation;
    case 'note': return StickyNote;
    default: return FileText; // doc / pdf / anything else
  }
}

export default function DelegateResultView({ result }: { result: DelegateResult }) {
  const theme = tabTheme('delegate');

  return (
    <div className="rounded-xl border border-artha-border bg-artha-surface p-4">
      <div className="flex items-center gap-2 mb-3">
        <CheckCircle2 size={16} style={{ color: theme.accent }} />
        <h2 className="text-sm font-semibold text-artha-text">Result</h2>
        <span className="ml-auto px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide bg-artha-warn/15 text-artha-warn">
          Beta
        </span>
      </div>

      {/* Honest verification limitation. Delegate reports that a run ENDED; it
          cannot yet verify that the objective was achieved (Phase A.5 in
          progress). Stating this is better than a green check that implies
          proof we do not have. */}
      <div className="mb-3 px-3 py-2 rounded-lg bg-artha-warn/10 border border-artha-warn/25 text-xs leading-relaxed text-artha-text">
        <span className="font-medium">The run finished — completion is not verified.</span>{' '}
        <span className="text-artha-muted">
          Delegate reports what the agent did, not proof that your objective was met. Check the
          output below, and open Workflows → Runs to inspect the actual tool calls and results.
        </span>
      </div>

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
