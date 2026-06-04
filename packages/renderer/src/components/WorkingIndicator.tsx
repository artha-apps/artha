/**
 * WorkingIndicator — the in-app "Artha has the wheel" cue.
 *
 * Whenever the agent is actively working (streaming a response / running tools),
 * we frame the whole window with a soft accent glow and show a "Artha is
 * working…" pill, so it's always obvious the agent is acting on the user's
 * behalf. The screen-takeover overlay (desktop control) and the browser-pane
 * label handle the more specific "took control" cases; this is the baseline.
 */
import { useChatStore } from '../stores/chat';
import { tabTheme } from '../lib/tabTheme';

/** "#RRGGBB" + alpha → rgba() string, for the inline glow colour. */
function withAlpha(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

export default function WorkingIndicator() {
  const isStreaming = useChatStore(s => s.isStreaming);
  const activeTab = useChatStore(s => s.activeTab);
  if (!isStreaming) return null;

  // Glow in the active room's accent so the "Artha is working" cue matches the
  // colour of the surface the user is looking at.
  const accent = tabTheme(activeTab).accent;

  return (
    <>
      {/* Window glow — non-interactive, sits under modals/banners. A 2px inset
          ring + soft inner glow, both in the active room's accent. (One inline
          boxShadow so it doesn't fight Tailwind's ring utility.) */}
      <div
        aria-hidden
        className="pointer-events-none fixed inset-0 z-[45] animate-pulse"
        style={{ boxShadow: `inset 0 0 0 2px ${withAlpha(accent, 0.55)}, inset 0 0 26px 2px ${withAlpha(accent, 0.22)}` }}
      />
      {/* Status pill — bottom-center (clear of the bottom-left/right notices).
          z above modals/picker so "Artha is working" stays visible even when a
          modal (Settings, plan approval) is open; below onboarding (z-100). */}
      <div
        role="status"
        className="pointer-events-none fixed bottom-4 left-1/2 -translate-x-1/2 z-[90] flex items-center gap-2 px-3.5 py-1.5 rounded-full bg-artha-text text-white text-xs font-medium shadow-lifted"
      >
        <span className="w-2 h-2 rounded-full animate-pulse" style={{ backgroundColor: accent }} />
        Artha is working…
      </div>
    </>
  );
}
