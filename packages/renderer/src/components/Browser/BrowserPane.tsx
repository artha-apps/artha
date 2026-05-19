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
import { useEffect, useRef } from 'react';
import { useBrowserStore } from '../../stores/browser';
import BrowserToolbar from './BrowserToolbar';
import HandoffBanner from './HandoffBanner';

interface Props {
  onClose: () => void;
}

export default function BrowserPane({ onClose }: Props) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const { setState } = useBrowserStore();

  // Push the viewport rectangle to main on every layout change.
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;

    const push = () => {
      const r = el.getBoundingClientRect();
      const bounds = {
        x: Math.round(r.left),
        y: Math.round(r.top),
        width: Math.max(0, Math.round(r.width)),
        height: Math.max(0, Math.round(r.height)),
      };
      void window.artha.browser.attach(bounds);
    };

    push();

    const ro = new ResizeObserver(push);
    ro.observe(el);
    window.addEventListener('resize', push);

    return () => {
      ro.disconnect();
      window.removeEventListener('resize', push);
      void window.artha.browser.detach();
    };
  }, []);

  // Subscribe to state pushes from main so the toolbar reflects what the
  // agent is doing in real time.
  useEffect(() => {
    void window.artha.browser.getState().then((s) => setState(s as never));
    const off = window.artha.browser.onState((s) => setState(s as never));
    return () => { off(); };
  }, [setState]);

  return (
    <aside className="flex flex-col w-[44%] min-w-[480px] max-w-[820px] border-l border-artha-border bg-artha-surface relative">
      <BrowserToolbar onClose={onClose} />
      {/* The viewport area — the native BrowserView is positioned to overlay
          this rect from the main process. Background is a subtle pattern so
          it's obvious when the BrowserView hasn't attached yet (debug aid). */}
      <div ref={viewportRef} className="flex-1 bg-[#0f1117] relative">
        <HandoffBanner />
      </div>
    </aside>
  );
}
