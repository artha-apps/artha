/**
 * DesktopControlPanel — enable/disable native desktop control (mouse, keyboard,
 * screen capture) and verify screen capture works. Desktop control is opt-in:
 * the agent only sees these tools while the toggle is on.
 */
import { useEffect, useState } from 'react';
import { Monitor, AlertTriangle, Camera, Loader } from 'lucide-react';

// Reference list of tools exposed when desktop control is enabled — shown at the
// bottom of the panel so users know exactly what they’re granting the agent access to.
const TOOLS: { name: string; desc: string }[] = [
  { name: 'desktop_screenshot',      desc: 'Capture the full screen as an image.' },
  { name: 'desktop_click',           desc: 'Move the mouse to (x, y) and click (left/right/double).' },
  { name: 'desktop_type',            desc: 'Type a string of text at the current focus.' },
  { name: 'desktop_key',             desc: 'Press a key or shortcut, e.g. "cmd+c".' },
  { name: 'desktop_move_mouse',      desc: 'Move the cursor without clicking.' },
  { name: 'desktop_find_on_screen',  desc: 'Locate a template image on screen via pixel matching.' },
  { name: 'desktop_get_active_window', desc: "Get the focused window's title and bounds." },
  { name: 'desktop_open_app',        desc: 'Launch or focus a macOS app by name.' },
];

/**
 * Desktop Control panel — opt-in toggle that adds native input control tools
 * (mouse, keyboard, screenshots) to the agent's toolset. Includes a test
 * screenshot button so users can verify macOS screen-recording permission is
 * granted before trusting the agent with UI automation tasks.
 */
export default function DesktopControlPanel() {
  // ── State ──────────────────────────────────────────────────────────────────
  const [enabled, setEnabled] = useState(false);
  // `shot` holds a base64 data-URI rendered in an <img> after a test capture.
  const [shot, setShot] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ── Effects ────────────────────────────────────────────────────────────────
  useEffect(() => {
    // Read the persisted toggle state via `settings:getDesktopControl`.
    window.artha.settings.getDesktopControl().then(setEnabled).catch(() => {});
  }, []);

  // ── Handlers ───────────────────────────────────────────────────────────────

  /** Persist the toggle immediately — no "Save" button needed. */
  const toggle = async () => {
    const next = !enabled;
    setEnabled(next);
    await window.artha.settings.setDesktopControl(next);
  };

  /** Call `desktop:capture` and render the returned base64 PNG inline.
   *  A failure here usually means macOS Screen Recording permission is missing. */
  const testScreenshot = async () => {
    setBusy(true);
    setError(null);
    try {
      const b64 = await window.artha.desktop.capture();
      setShot(`data:image/png;base64,${b64}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="max-w-3xl mx-auto">
        {/* Header */}
        <div className="flex items-center gap-3 mb-6">
          <Monitor size={22} className="text-cyan-400" />
          <div>
            <h2 className="text-lg font-semibold text-artha-text">Desktop Control</h2>
            <p className="text-sm text-artha-muted">Let Artha control native apps via keyboard, mouse, and screen capture</p>
          </div>
        </div>

        {/* Warning */}
        <div className="flex items-start gap-3 p-3 mb-6 rounded-xl bg-yellow-500/10 border border-yellow-500/30 text-sm text-yellow-300">
          <AlertTriangle size={16} className="shrink-0 mt-0.5" />
          <span>When enabled, Artha can move your mouse, type text, and take screenshots. Only enable when you trust the task.</span>
        </div>

        {/* Toggle */}
        <div className="flex items-center justify-between px-4 py-4 mb-6 rounded-xl bg-artha-s2 border border-artha-border">
          <div>
            <p className="text-sm font-semibold text-artha-text">Enable desktop control</p>
            <p className="text-xs text-artha-muted mt-0.5">Adds the desktop tools to the agent’s toolset.</p>
          </div>
          <button
            onClick={toggle}
            role="switch"
            aria-checked={enabled}
            className={`relative w-11 h-6 rounded-full transition-colors shrink-0 ${enabled ? 'bg-cyan-500' : 'bg-white/15'}`}
          >
            <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white transition-transform ${enabled ? 'translate-x-5' : ''}`} />
          </button>
        </div>

        {/* Test screenshot */}
        <div className="mb-6">
          <button
            onClick={testScreenshot}
            disabled={busy}
            className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-cyan-600 hover:bg-cyan-500 disabled:opacity-40 disabled:cursor-not-allowed text-artha-text text-sm font-medium transition-colors"
          >
            {busy ? <Loader size={15} className="animate-spin" /> : <Camera size={15} />}
            Test Screenshot
          </button>
          {error && (
            <div className="mt-3 px-4 py-3 rounded-xl bg-red-500/10 border border-red-500/30 text-sm text-red-400">{error}</div>
          )}
          {shot && (
            <img src={shot} alt="Screen capture" className="mt-3 rounded-xl border border-artha-border max-w-full" />
          )}
        </div>

        {/* Tool list */}
        <h3 className="text-sm font-semibold text-gray-300 mb-3">Available tools</h3>
        <div className="space-y-2">
          {TOOLS.map(t => (
            <div key={t.name} className="flex items-start gap-3 px-4 py-3 rounded-xl bg-artha-s2 border border-artha-border">
              <code className="text-xs text-cyan-400 font-mono shrink-0 mt-0.5">{t.name}</code>
              <span className="text-xs text-artha-muted">{t.desc}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
