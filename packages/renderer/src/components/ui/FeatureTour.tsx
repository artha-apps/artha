/**
 * FeatureTour — the beautiful, full-screen slideshow that auto-launches the
 * first time a user opens each top-level feature tab (Chat / Workflows / Code /
 * Delegate). Content lives in `tours.ts`; first-run tracking lives in the store
 * (`activeTour` + `seenGuides`). Re-openable from the TabBar "?".
 *
 * Each tour is a few glanceable slides: a "what is this" intro, concrete
 * numbered steps, and a "try this" payoff. Navigate with the buttons, the
 * progress dots, or the keyboard (← / → / Enter / Esc).
 */
import { useEffect, useState } from 'react';
import { X, ArrowLeft, ArrowRight } from 'lucide-react';
import { useChatStore } from '../../stores/chat';
import { TOURS } from './tours';

export function FeatureTour() {
  const { activeTour, closeTour } = useChatStore();
  const [i, setI] = useState(0);

  // Restart at the first slide each time a tour opens.
  useEffect(() => { setI(0); }, [activeTour]);

  // Keyboard navigation, live only while a tour is open. Re-bound per slide so
  // the handler closes over the current index.
  useEffect(() => {
    if (!activeTour) return;
    const count = TOURS[activeTour].slides.length;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); closeTour(true); }
      else if (e.key === 'ArrowRight' || e.key === 'Enter') {
        e.preventDefault();
        setI(p => {
          if (p >= count - 1) { closeTour(true); return p; }
          return p + 1;
        });
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        setI(p => Math.max(0, p - 1));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [activeTour, closeTour]);

  if (!activeTour) return null;
  const tour = TOURS[activeTour];
  const slide = tour.slides[i];
  const Icon = slide.icon;
  const isLast = i === tour.slides.length - 1;
  const accent = tour.accent;

  const next = () => (isLast ? closeTour(true) : setI(i + 1));
  const back = () => setI(Math.max(0, i - 1));

  return (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center p-6 bg-black/55 backdrop-blur-sm animate-fade-up"
      onClick={() => closeTour(true)}
    >
      <div
        className="relative w-full max-w-md surface-raised overflow-hidden animate-scale-in"
        onClick={e => e.stopPropagation()}
      >
        {/* Skip */}
        <button
          onClick={() => closeTour(true)}
          aria-label="Skip tour"
          className="absolute top-3 right-3 z-10 text-artha-subtle hover:text-artha-text transition-colors p-1.5 rounded-md hover:bg-artha-surface2"
        >
          <X size={16} />
        </button>

        {/* Hero — accent-tinted, with the slide's icon in a glowing ring */}
        <div
          className="px-7 pt-9 pb-6 text-center"
          style={{ background: `radial-gradient(120% 100% at 50% 0%, ${accent}22, transparent 70%)` }}
        >
          <div
            className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl border"
            style={{ background: `${accent}1a`, borderColor: `${accent}55`, boxShadow: `0 0 24px ${accent}33` }}
          >
            <Icon size={26} style={{ color: accent }} />
          </div>
          <div className="text-[10px] font-semibold uppercase tracking-[0.18em]" style={{ color: accent }}>
            {tour.title} · {slide.kicker}
          </div>
          <h2 className="mt-1.5 text-lg font-semibold text-artha-text">{slide.title}</h2>
          {i === 0 && <p className="mt-1 text-xs text-artha-muted">{tour.tagline}</p>}
        </div>

        {/* Body — paragraph or numbered steps */}
        <div className="px-7 pb-6 min-h-[132px]">
          {slide.body && (
            <p className="text-[13.5px] leading-relaxed text-artha-text/90">{slide.body}</p>
          )}
          {slide.steps && (
            <ol className="space-y-2.5">
              {slide.steps.map((step, n) => (
                <li key={n} className="flex items-start gap-3">
                  <span
                    className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold tabular-nums"
                    style={{ background: `${accent}1f`, color: accent }}
                  >
                    {n + 1}
                  </span>
                  <span className="text-[13.5px] leading-snug text-artha-text/90">{step}</span>
                </li>
              ))}
            </ol>
          )}
        </div>

        {/* Footer — progress dots + nav */}
        <div className="flex items-center justify-between border-t border-artha-border bg-artha-surface2/40 px-5 py-3.5">
          <div className="flex items-center gap-1.5">
            {tour.slides.map((_, n) => (
              <button
                key={n}
                onClick={() => setI(n)}
                aria-label={`Go to slide ${n + 1}`}
                className="h-1.5 rounded-full transition-all"
                style={
                  n === i
                    ? { width: 18, background: accent }
                    : { width: 6, background: 'rgb(var(--artha-border-strong))' }
                }
              />
            ))}
          </div>

          <div className="flex items-center gap-2">
            {i > 0 && (
              <button onClick={back} className="btn-ghost px-2.5 py-1.5 text-xs">
                <ArrowLeft size={13} /> Back
              </button>
            )}
            <button
              onClick={next}
              className="inline-flex items-center gap-1.5 rounded-lg px-3.5 py-1.5 text-xs font-semibold transition-all active:scale-[0.97]"
              style={{ background: accent, color: '#1a1408' }}
            >
              {isLast ? 'Get started' : <>Next <ArrowRight size={13} /></>}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
