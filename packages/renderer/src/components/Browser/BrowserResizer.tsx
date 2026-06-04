/**
 * BrowserResizer — the draggable vertical divider between the chat pane and the
 * in-app browser pane. Rendered as a sibling immediately to the LEFT of
 * BrowserPane so it sits in renderer-only space: the native BrowserView overlays
 * the pane itself, so a handle placed *inside* the pane would be behind the
 * native layer and never receive clicks.
 *
 * On drag it only updates store state (`browserWidth` + `isResizing`).
 * BrowserPane reacts: it consumes `browserWidth` for its width, and while
 * `isResizing` is true it detaches the native BrowserView so the renderer keeps
 * receiving the mouse-move stream (the native view would otherwise swallow it
 * the moment the cursor passed over the page).
 */
import { useBrowserStore, MIN_BROWSER_W, MIN_CHAT_W } from '../../stores/browser';

/** Thin grab-bar; widens its hit area beyond the visible line for easier aim. */
export default function BrowserResizer() {
  const setBrowserWidth = useBrowserStore(s => s.setBrowserWidth);
  const setResizing = useBrowserStore(s => s.setResizing);

  const onMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = useBrowserStore.getState().browserWidth;
    setResizing(true);
    // Cursor/selection feedback for the whole window during the drag.
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    const onMove = (ev: MouseEvent) => {
      // The browser pane is on the right, so dragging the handle left (smaller
      // clientX) widens it. Clamp so neither pane drops below its usable floor.
      const delta = startX - ev.clientX;
      const max = Math.max(MIN_BROWSER_W, window.innerWidth - MIN_CHAT_W);
      const next = Math.min(max, Math.max(MIN_BROWSER_W, startW + delta));
      setBrowserWidth(next);
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      setResizing(false); // BrowserPane re-attaches the native view at the final width
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize browser pane"
      onMouseDown={onMouseDown}
      className="group relative w-px shrink-0 cursor-col-resize bg-artha-border hover:bg-artha-accent/60 transition-colors"
      title="Drag to resize"
    >
      {/* Invisible, wider hit area so the user doesn't have to land on a 1px line. */}
      <div className="absolute inset-y-0 -left-1.5 -right-1.5" />
    </div>
  );
}
