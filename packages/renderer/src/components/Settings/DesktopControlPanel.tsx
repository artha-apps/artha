/**
 * DesktopControlPanel — enable/disable native desktop control (mouse, keyboard,
 * screen capture) and verify screen capture works. Desktop control is opt-in:
 * the agent only sees these tools while the toggle is on.
 */
import { useEffect, useState } from 'react';
import { Monitor, AlertTriangle, Camera, Loader } from 'lucide-react';
import KeepAwakeSettings from './KeepAwakeSettings';

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
  // Global stop shortcut (Electron accelerator). `shortcutDraft` is the
  // editable field; `shortcutSaved` is what the main process actually bound.
  const [shortcutDraft, setShortcutDraft] = useState('');
  const [shortcutSaved, setShortcutSaved] = useState('');

  // ── Effects ────────────────────────────────────────────────────────────────
  useEffect(() => {
    // Read the persisted toggle state via `settings:getDesktopControl`.
    window.artha.settings.getDesktopControl().then(setEnabled).catch(() => {});
    window.artha.settings.getDesktopStopShortcut()
      .then((s) => { setShortcutDraft(s); setShortcutSaved(s); })
      .catch(() => {});
  }, []);

  /** Persist the stop shortcut; an empty field restores the default. The main
   *  process echoes the accelerator it will actually use. */
  const saveShortcut = async () => {
    const bound = await window.artha.settings.setDesktopStopShortcut(shortcutDraft.trim());
    setShortcutDraft(bound);
    setShortcutSaved(bound);
  };

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
          <Monitor size={22} className="text-artha-accent" />
          <div>
            <h2 className="text-lg font-semibold text-artha-text">Desktop Control</h2>
            <p className="text-sm text-artha-muted">Let Artha control native apps via keyboard, mouse, and screen capture</p>
          </div>
        </div>

        {/* Warning */}
        <div className="flex items-start gap-3 p-3 mb-6 rounded-xl bg-artha-warn/10 border border-artha-warn/30 text-sm text-artha-warn">
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
            className={`relative w-11 h-6 rounded-full transition-colors shrink-0 ${enabled ? 'bg-artha-accent' : 'bg-artha-text/15'}`}
          >
            <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white transition-transform ${enabled ? 'translate-x-5' : ''}`} />
          </button>
        </div>

        {/* Stop shortcut + per-app grants explainer */}
        <div className="px-4 py-4 mb-6 rounded-xl bg-artha-s2 border border-artha-border space-y-3">
          <div>
            <p className="text-sm font-semibold text-artha-text">Stop shortcut</p>
            <p className="text-xs text-artha-muted mt-0.5">
              Works from any app while Artha is running a task: stops every run and any queued mouse or keyboard
              action. A click or key press already under way finishes first, and typing stops within a few
              characters. A stopped task is never marked complete. Leave blank for the default (Ctrl+Option+Shift+Period).
            </p>
          </div>
          <div className="flex gap-2">
            <input
              value={shortcutDraft}
              onChange={(e) => setShortcutDraft(e.target.value)}
              placeholder="Control+Alt+Shift+."
              className="flex-1 px-3 py-2 rounded-lg bg-artha-bg border border-artha-border text-sm font-mono text-artha-text"
            />
            <button
              onClick={saveShortcut}
              disabled={shortcutDraft.trim() === shortcutSaved}
              className="px-4 py-2 rounded-lg bg-artha-accent hover:bg-artha-accent-hover disabled:opacity-40 disabled:cursor-not-allowed text-artha-on-accent text-sm font-medium transition-colors"
            >
              Save
            </button>
          </div>
          <p className="text-xs text-artha-muted">
            Artha also asks before controlling each app (Once, or Always for this project for 30 days). Terminal,
            iTerm, System Settings, Keychain Access and password managers always ask. Scheduled tasks skip apps you
            haven’t approved.
          </p>
        </div>

        {/* Test screenshot */}
        <div className="mb-6">
          <button
            onClick={testScreenshot}
            disabled={busy}
            className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-artha-accent hover:bg-artha-accent-hover disabled:opacity-40 disabled:cursor-not-allowed text-artha-on-accent text-sm font-medium transition-colors"
          >
            {busy ? <Loader size={15} className="animate-spin" /> : <Camera size={15} />}
            Test Screenshot
          </button>
          {error && (
            <div className="mt-3 px-4 py-3 rounded-xl bg-artha-danger/10 border border-artha-danger/30 text-sm text-artha-danger">{error}</div>
          )}
          {shot && (
            <img src={shot} alt="Screen capture" className="mt-3 rounded-xl border border-artha-border max-w-full" />
          )}
        </div>

        {/* Power: keep the machine awake while a task runs (independent of desktop control). */}
        <KeepAwakeSettings />

        {/* Tool list */}
        <h3 className="text-sm font-semibold text-artha-muted mb-3">Available tools</h3>
        <div className="space-y-2">
          {TOOLS.map(t => (
            <div key={t.name} className="flex items-start gap-3 px-4 py-3 rounded-xl bg-artha-s2 border border-artha-border">
              <code className="text-xs text-artha-accent font-mono shrink-0 mt-0.5">{t.name}</code>
              <span className="text-xs text-artha-muted">{t.desc}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
