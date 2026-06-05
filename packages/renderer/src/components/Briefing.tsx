/**
 * Briefing — opt-in "since you were last here" digest, shown once on launch.
 *
 * Off by default (toggle in Settings → General). When enabled and there's
 * activity since the last seen briefing, a quiet bottom-left card summarises
 * recent runs / file changes / new artifacts / contacts / memories and links to
 * Workflows ▸ Runs. Dismissing (or following the link) stamps "seen now" so the
 * next briefing only covers what's new. Renders nothing when disabled/empty.
 */
import { useEffect, useState } from 'react';
import { Sparkles, X, ArrowUpRight } from 'lucide-react';
import { useChatStore } from '../stores/chat';

interface BriefingData {
  since: number; runs: number; failedRuns: number; filesChanged: number;
  newArtifacts: number; newMemories: number; newContacts: number; hasActivity: boolean;
}

export default function Briefing() {
  const openWorkflows = useChatStore(s => s.openWorkflows);
  const [b, setB] = useState<BriefingData | null>(null);

  useEffect(() => {
    let cancelled = false;
    window.artha.settings.get()
      .then((s: { briefingsEnabled?: boolean }) => {
        if (!s?.briefingsEnabled) return;
        return window.artha.briefing.get().then(br => { if (!cancelled && br.hasActivity) setB(br); });
      })
      .catch(() => { /* fresh DB / disabled — nothing to show */ });
    return () => { cancelled = true; };
  }, []);

  if (!b) return null;

  const dismiss = () => { window.artha.briefing.markSeen().catch(() => {}); setB(null); };

  const parts: string[] = [];
  if (b.runs) parts.push(`${b.runs} run${b.runs > 1 ? 's' : ''}`);
  if (b.filesChanged) parts.push(`${b.filesChanged} file${b.filesChanged > 1 ? 's' : ''} changed`);
  if (b.newArtifacts) parts.push(`${b.newArtifacts} new file${b.newArtifacts > 1 ? 's' : ''}`);
  if (b.newContacts) parts.push(`${b.newContacts} new contact${b.newContacts > 1 ? 's' : ''}`);
  if (b.newMemories) parts.push(`${b.newMemories} ${b.newMemories > 1 ? 'memories' : 'memory'}`);

  return (
    <div className="fixed bottom-4 left-4 z-[58] max-w-sm rounded-xl bg-artha-surface border border-artha-border shadow-lifted p-4 text-sm animate-fade-up">
      <div className="flex items-start gap-3">
        <Sparkles size={16} className="text-artha-accent shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <p className="text-artha-text font-medium">Since you were last here</p>
          <p className="text-artha-muted text-xs mt-0.5 leading-snug">
            {parts.join(' · ')}
            {b.failedRuns > 0 && <span className="text-artha-danger"> · {b.failedRuns} failed</span>}
          </p>
          <div className="flex items-center gap-3 mt-2">
            <button onClick={() => { openWorkflows('runs'); dismiss(); }} className="inline-flex items-center gap-1 text-xs text-artha-accent hover:underline">
              View runs <ArrowUpRight size={11} />
            </button>
            <button onClick={dismiss} className="text-xs text-artha-muted hover:text-artha-text transition-colors">Dismiss</button>
          </div>
        </div>
        <button onClick={dismiss} aria-label="Dismiss briefing" className="text-artha-muted hover:text-artha-text shrink-0 transition-colors"><X size={14} /></button>
      </div>
    </div>
  );
}
