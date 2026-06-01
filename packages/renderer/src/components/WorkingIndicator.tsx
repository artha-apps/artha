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

export default function WorkingIndicator() {
  const isStreaming = useChatStore(s => s.isStreaming);
  if (!isStreaming) return null;

  return (
    <>
      {/* Window glow — non-interactive, sits under modals/banners. */}
      <div
        aria-hidden
        className="pointer-events-none fixed inset-0 z-[45] ring-2 ring-inset ring-artha-accent/55 animate-pulse"
        style={{ boxShadow: 'inset 0 0 26px 2px rgba(0,53,237,0.22)' }}
      />
      {/* Status pill — bottom-center (clear of the bottom-left/right notices).
          z above modals/picker so "Artha is working" stays visible even when a
          modal (Settings, plan approval) is open; below onboarding (z-100). */}
      <div
        role="status"
        className="pointer-events-none fixed bottom-4 left-1/2 -translate-x-1/2 z-[90] flex items-center gap-2 px-3.5 py-1.5 rounded-full bg-artha-text text-white text-xs font-medium shadow-lifted"
      >
        <span className="w-2 h-2 rounded-full bg-artha-accent animate-pulse" />
        Artha is working…
      </div>
    </>
  );
}
