/**
 * Citations strip — renders below an assistant message that consulted
 * web_fetch / web_search. Clicking a chip opens the source URL in the
 * user's default browser via Electron's setWindowOpenHandler (configured
 * in packages/app/src/main.ts).
 */
import { Globe } from 'lucide-react';
import type { Citation } from '../../stores/chat';

interface Props {
  citations: Citation[];
}

function hostname(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ''); }
  catch { return url; }
}

export default function Citations({ citations }: Props) {
  if (citations.length === 0) return null;

  return (
    <div className="mt-3 pt-3 border-t border-artha-border/40">
      <div className="flex items-center gap-1.5 mb-2 text-[10px] uppercase tracking-wider text-artha-muted/70 font-semibold">
        <Globe size={10} />
        <span>Sources ({citations.length})</span>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {citations.map((c, i) => (
          <a
            key={`${c.url}-${i}`}
            href={c.url}
            target="_blank"
            rel="noreferrer"
            title={c.title || c.url}
            className="group flex items-center gap-1.5 max-w-[260px] px-2 py-1 rounded-md bg-artha-surface border border-artha-border hover:border-artha-accent/40 hover:bg-white/[0.04] transition-colors text-[11px] no-underline"
          >
            <span className="shrink-0 text-artha-muted font-mono">[{i + 1}]</span>
            <span className="truncate text-artha-text group-hover:text-white">
              {c.title || hostname(c.url)}
            </span>
            <span className="shrink-0 text-artha-muted/60 text-[10px]">
              {hostname(c.url)}
            </span>
          </a>
        ))}
      </div>
    </div>
  );
}
