/**
 * FeatureGuide — inline expandable "Welcome to X" card that appears at the
 * top of a Settings panel. First-time visitors see it expanded with three
 * sections (What is this · What can you do · Try this first). Once
 * dismissed, the card hides and a "?" affordance in the panel header can
 * re-open it later.
 *
 * Dismissal is per-featureKey, persisted to localStorage via the chat store
 * (`seenGuides` Set). This means a user only ever sees each guide once
 * unless they reopen it explicitly.
 *
 * Usage in a panel:
 *   <FeatureGuide
 *     featureKey="rag"
 *     title="RAG indexes"
 *     summary="Search inside your folders without uploading them."
 *     bullets={['…', '…']}
 *     steps={['Pick a folder…', 'Build the index…', 'Attach it to a chat…']}
 *   />
 */
import { Lightbulb, X, ChevronRight } from 'lucide-react';
import { useChatStore } from '../../stores/chat';

interface FeatureGuideProps {
  /** Stable key for this guide. Used to track dismissal in `seenGuides`. */
  featureKey: string;
  /** Panel title — shown as the card heading. */
  title: string;
  /** One-sentence "what is this" — plain English, ~120 chars. */
  summary: string;
  /** Capabilities — what the user can do with this feature. 2–4 bullets. */
  bullets: string[];
  /** Numbered quickstart — 2–3 concrete steps the user can do right now. */
  steps: string[];
  /** Optional URL for "Learn more →"; opens via the browser. */
  learnMoreUrl?: string;
}

export function FeatureGuide({ featureKey, title, summary, bullets, steps, learnMoreUrl }: FeatureGuideProps) {
  const { seenGuides, dismissGuide, reopenGuide } = useChatStore();
  // When dismissed, collapse to a slim reopen affordance — never strand the
  // guide entirely, since users sometimes want to revisit the intro later.
  if (seenGuides.has(featureKey)) {
    return (
      <button
        onClick={() => reopenGuide(featureKey)}
        className="mb-4 inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border border-artha-border text-xs text-artha-muted hover:text-artha-accent hover:border-artha-accent transition-colors"
      >
        <Lightbulb size={11} />
        <span>Show {title} guide</span>
      </button>
    );
  }

  return (
    <div className="mb-6 rounded-xl border border-artha-border bg-artha-surface shadow-soft overflow-hidden">
      <div className="flex items-start gap-3 px-4 pt-4 pb-3 border-b border-artha-border">
        <div className="w-7 h-7 rounded-lg bg-artha-accent/10 border border-artha-accent/30 flex items-center justify-center shrink-0 mt-0.5">
          <Lightbulb size={14} className="text-artha-accent" />
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="text-sm font-semibold text-artha-text">Welcome to {title}</h3>
          <p className="text-xs text-artha-muted mt-0.5">{summary}</p>
        </div>
        <button
          onClick={() => dismissGuide(featureKey)}
          aria-label="Dismiss this guide"
          className="shrink-0 text-artha-subtle hover:text-artha-text transition-colors p-1 -m-1"
        >
          <X size={14} />
        </button>
      </div>

      <div className="px-4 py-4 grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* What can you do? */}
        <div>
          <div className="text-[10px] uppercase tracking-wider text-artha-subtle font-semibold mb-2">
            What you can do
          </div>
          <ul className="space-y-1.5">
            {bullets.map((b, i) => (
              <li key={i} className="flex items-start gap-2 text-[13px] text-artha-text leading-snug">
                <span className="text-artha-accent mt-1 shrink-0">·</span>
                <span>{b}</span>
              </li>
            ))}
          </ul>
        </div>

        {/* Try this first */}
        <div>
          <div className="text-[10px] uppercase tracking-wider text-artha-subtle font-semibold mb-2">
            Try this first
          </div>
          <ol className="space-y-1.5">
            {steps.map((step, i) => (
              <li key={i} className="flex items-start gap-2 text-[13px] text-artha-text leading-snug">
                <span className="font-mono text-artha-muted text-[11px] mt-0.5 shrink-0 tabular-nums">
                  {String(i + 1).padStart(2, '0')}
                </span>
                <span>{step}</span>
              </li>
            ))}
          </ol>
        </div>
      </div>

      <div className="flex items-center justify-between px-4 py-3 border-t border-artha-border bg-artha-surface2/50">
        <button
          onClick={() => dismissGuide(featureKey)}
          className="text-xs font-medium text-artha-text hover:text-artha-accent transition-colors"
        >
          Got it
        </button>
        {learnMoreUrl && (
          <a
            href={learnMoreUrl}
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-1 text-xs text-artha-muted hover:text-artha-accent transition-colors"
          >
            Learn more <ChevronRight size={11} />
          </a>
        )}
      </div>
    </div>
  );
}

/**
 * GuideReopenButton — small "?" icon to be placed in a panel header so the
 * user can pull a dismissed guide back up. Renders nothing if the guide
 * isn't currently dismissed (no point re-opening what's already visible).
 */
export function GuideReopenButton({ featureKey, label }: { featureKey: string; label?: string }) {
  const { seenGuides, reopenGuide } = useChatStore();
  if (!seenGuides.has(featureKey)) return null;
  return (
    <button
      onClick={() => reopenGuide(featureKey)}
      title={label ?? 'Show the guide for this panel'}
      aria-label={label ?? 'Show guide'}
      className="inline-flex items-center justify-center w-6 h-6 rounded-md border border-artha-border text-artha-muted hover:text-artha-accent hover:border-artha-accent transition-colors text-xs font-semibold"
    >
      ?
    </button>
  );
}
