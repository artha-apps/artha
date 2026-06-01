/**
 * Control overlay — the "Artha has taken control of your screen" indicator.
 *
 * Desktop control (tools/desktop.ts) moves the user's REAL mouse and types REAL
 * keys, so the moment Artha takes over we paint an unmistakable, full-screen
 * frame so the user always knows the machine is being driven by the agent — and
 * isn't startled by a cursor moving on its own.
 *
 * The overlay is a frameless, transparent, always-on-top, CLICK-THROUGH window
 * covering the primary display: a glowing accent border + a pill. Click-through
 * (`setIgnoreMouseEvents`) is essential — it must never intercept Artha's own
 * clicks or block the user. It shows on the first desktop action and auto-hides
 * a couple seconds after the last one (so a sequence of actions keeps it up
 * without flicker).
 */
import { BrowserWindow, screen } from 'electron';

let overlay: BrowserWindow | null = null;
let hideTimer: ReturnType<typeof setTimeout> | null = null;
/** How long after the last desktop action the overlay lingers before hiding. */
const HIDE_DELAY_MS = 2500;

const OVERLAY_HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;height:100%;background:transparent;overflow:hidden;
    -webkit-user-select:none;cursor:default;}
  /* Glowing frame hugging the screen edges. */
  .frame{position:fixed;inset:0;border:4px solid #0035ED;border-radius:10px;
    box-shadow:inset 0 0 22px 4px rgba(0,53,237,.55);
    animation:pulse 1.8s ease-in-out infinite;}
  @keyframes pulse{0%,100%{opacity:.9}50%{opacity:.45}}
  .pill{position:fixed;top:14px;left:50%;transform:translateX(-50%);
    display:flex;align-items:center;gap:8px;
    padding:8px 16px;border-radius:9999px;
    background:rgba(10,22,40,.92);color:#fff;
    font:600 13px/1.2 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
    box-shadow:0 6px 24px rgba(0,0,0,.35);white-space:nowrap;}
  .dot{width:8px;height:8px;border-radius:50%;background:#0035ED;
    box-shadow:0 0 8px 2px rgba(0,53,237,.8);animation:pulse 1.2s ease-in-out infinite;}
</style></head><body>
  <div class="frame"></div>
  <div class="pill"><span class="dot"></span>🤖 Artha is in control — performing actions on your screen</div>
</body></html>`;

function ensureOverlay(): BrowserWindow {
  if (overlay && !overlay.isDestroyed()) return overlay;
  const { bounds } = screen.getPrimaryDisplay();
  overlay = new BrowserWindow({
    x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height,
    transparent: true,
    frame: false,
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    focusable: false,        // never steal focus from the app Artha is driving
    show: false,
    backgroundColor: '#00000000',
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  // Click-through: the overlay must not catch any mouse events.
  overlay.setIgnoreMouseEvents(true);
  // Sit above normal app windows (incl. full-screen apps) while Artha drives.
  overlay.setAlwaysOnTop(true, 'screen-saver');
  overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlay.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(OVERLAY_HTML));
  overlay.on('closed', () => { overlay = null; });
  return overlay;
}

/** Signal that a desktop-control action is running: show the overlay now and
 *  (re)arm the auto-hide. Called before each desktop tool invocation. */
export function noteDesktopControlActive(): void {
  try {
    const win = ensureOverlay();
    // Re-fit to the current primary display in case it changed.
    const { bounds } = screen.getPrimaryDisplay();
    win.setBounds(bounds);
    if (!win.isVisible()) win.showInactive(); // show without taking focus
    win.setAlwaysOnTop(true, 'screen-saver');
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = setTimeout(hideControlOverlay, HIDE_DELAY_MS);
  } catch {
    /* overlay is best-effort — never let it break a desktop action */
  }
}

/** Hide the overlay (Artha released control / session ended). */
export function hideControlOverlay(): void {
  if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
  try { if (overlay && !overlay.isDestroyed() && overlay.isVisible()) overlay.hide(); }
  catch { /* ignore */ }
}
