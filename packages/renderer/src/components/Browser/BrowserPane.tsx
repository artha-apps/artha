/**
 * BrowserPane — right-side resizable column that *appears* to host a
 * browser. In reality the BrowserView lives in Electron's main process and
 * we just measure this DOM region and forward the rectangle so the native
 * view overlays exactly the empty area below the toolbar.
 *
 * Bounds sync is the only tricky bit: we re-tell main any time the pane
 * resizes (window resize, layout shifts) using a ResizeObserver. When the
 * pane unmounts or closes, we detach so the BrowserView vanishes.
 */
import { useCallback, useEffect, useRef } from 'react';
import { useBrowserStore, MIN_BROWSER_W, MIN_CHAT_W } from '../../stores/browser';
import { useChatStore } from '../../stores/chat';
import BrowserToolbar from './BrowserToolbar';
import HandoffBanner from './HandoffBanner';

/** Props for BrowserPane.
 *  @param onClose - Called when the user dismisses the pane; App.tsx reacts by
 *  showing ExecutionLog in its place. BrowserPane's cleanup effect calls
 *  `browser.detach()` so the native BrowserView is hidden at the same time. */
interface Props {
  onClose: () => void;
}

export default function BrowserPane({ onClose }: Props) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const { state, setState } = useBrowserStore();
  // Width of this pane in the chat|browser split — driven by the draggable
  // BrowserResizer to its left. The chat pane flexes to fill the remainder.
  const browserWidth = useBrowserStore(s => s.browserWidth);
  const isResizing = useBrowserStore(s => s.isResizing);
  const setBrowserWidth = useBrowserStore(s => s.setBrowserWidth);
  const crashed = state.crashed;
  // Artha is driving the page when the agent is streaming and hasn't handed the
  // wheel to the user (handoff has its own banner) or crashed.
  const isStreaming = useChatStore(s => s.isStreaming);
  const agentDriving = isStreaming && !state.awaitingHandoff && !crashed;

  // Measure the viewport rect and forward it so the native BrowserView overlays
  // exactly this region. Stable identity so the effects below don't re-run.
  const pushBounds = useCallback(() => {
    const el = viewportRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    void window.artha.browser.attach({
      x: Math.round(r.left),
      y: Math.round(r.top),
      width: Math.max(0, Math.round(r.width)),
      height: Math.max(0, Math.round(r.height)),
    });
  }, []);

  // Push the viewport rectangle to main on every layout change — EXCEPT while
  // the divider is being dragged (the native view is detached then; re-pushing
  // would re-attach it and let it swallow the mouse-move stream).
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const onLayout = () => { if (!useBrowserStore.getState().isResizing) pushBounds(); };
    onLayout();
    const ro = new ResizeObserver(onLayout);
    ro.observe(el);
    window.addEventListener('resize', onLayout);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', onLayout);
      void window.artha.browser.detach();
    };
  }, [pushBounds]);

  // While dragging the divider, detach the native view so the renderer keeps
  // receiving mouse-move events; re-attach it at the final width on release.
  useEffect(() => {
    if (isResizing) void window.artha.browser.detach();
    else pushBounds();
  }, [isResizing, pushBounds]);

  // Keep the persisted width usable if the window gets smaller than the saved
  // split (e.g. reopened on a smaller display) — never let the browser pane
  // crowd the chat below its floor.
  useEffect(() => {
    const clamp = () => {
      const max = Math.max(MIN_BROWSER_W, window.innerWidth - MIN_CHAT_W);
      if (useBrowserStore.getState().browserWidth > max) setBrowserWidth(max);
    };
    clamp();
    window.addEventListener('resize', clamp);
    return () => window.removeEventListener('resize', clamp);
  }, [setBrowserWidth]);

  // Subscribe to state pushes from main so the toolbar reflects what the
  // agent is doing in real time.
  useEffect(() => {
    void window.artha.browser.getState().then((s) => setState(s as never));
    const off = window.artha.browser.onState((s) => setState(s as never));
    return () => { off(); };
  }, [setState]);

  return (
    <aside
      className="flex flex-col shrink-0 bg-artha-surface relative"
      style={{ width: browserWidth }}
    >
      <BrowserToolbar onClose={onClose} />
      {/* The viewport area — the native BrowserView is positioned to overlay
          this rect from the main process. Background is a subtle pattern so
          it's obvious when the BrowserView hasn't attached yet (debug aid). */}
      <div ref={viewportRef} className="flex-1 bg-artha-bg relative">
        <HandoffBanner />
        {/* "Artha is driving this page" — distinct from the handoff banner
            (which is when the wheel is handed to the user). Sits above the
            native BrowserView so it's visible over the page. */}
        {agentDriving && (
          <div className="pointer-events-none absolute inset-0 z-[5] ring-2 ring-inset ring-artha-accent/70">
            <div className="absolute top-2 left-1/2 -translate-x-1/2 flex items-center gap-2 px-3 py-1.5 rounded-full bg-artha-accent text-artha-on-accent text-[11px] font-medium shadow-glow">
              <span className="w-1.5 h-1.5 rounded-full bg-white animate-pulse" />
              🤖 Artha is browsing this page
            </div>
          </div>
        )}
        {/* Recovery overlay — the native BrowserView is blank after a renderer
            crash that survived the auto-reload, so cover the pane and offer a
            deliberate retry. Rendered above the (now-empty) native view. */}
        {crashed && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-artha-bg text-center px-8">
            <div className="max-w-sm">
              <div className="text-4xl mb-3">💥</div>
              <h2 className="text-[15px] font-semibold text-artha-text mb-1.5">
                This page crashed
              </h2>
              <p className="text-[13px] leading-relaxed text-artha-muted mb-5">
                The browser tab’s process stopped unexpectedly
                {crashed.reason && crashed.reason !== 'crashed'
                  ? ` (${crashed.reason})`
                  : ''}
                . Reloading usually fixes it.
              </p>
              <button
                onClick={() => void window.artha.browser.recover()}
                className="px-4 py-2 rounded-md bg-artha-accent text-artha-on-accent text-[13px] font-medium hover:opacity-90 transition"
              >
                Reload page
              </button>
            </div>
          </div>
        )}
      </div>
    </aside>
  );
}
