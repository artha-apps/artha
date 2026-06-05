/**
 * SettingsPanel — general app preferences.
 *
 * Exposes:
 *   - Notifications toggle (OS-level alerts for task completion)
 *   - Show agent reasoning toggle (the <think>-phase disclosure in chat)
 *   - Anonymous crash reports (Sentry) toggle — opt-out
 *
 * Most settings are stored in the `users.settings_json` blob via the
 * `settings:{get,set}` IPC channels. Sentry uses its own `settings:getSentry`/
 * `settings:setSentry` pair so toggling it can flip the runtime kill-switch
 * immediately (not just at next launch).
 */
import { useEffect, useState } from 'react';
import { Bell, BellOff, Sparkles, ShieldCheck, Power, Newspaper } from 'lucide-react';

/**
 * Loose shape of the settings blob — the index signature lets the same `toggle`
 * helper handle future boolean keys without a per-key type narrowing.
 */
interface AppSettings {
  notifications_enabled?: boolean;
  show_reasoning?: boolean;
  ollama_stop_on_quit?: boolean;
  [key: string]: unknown;
}

/** A single labelled on/off row — extracted so the three toggles share styling. */
function ToggleRow({
  icon, title, description, on, disabled, onToggle,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  on: boolean;
  disabled?: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="flex items-center justify-between px-4 py-3.5 rounded-xl bg-artha-s2 border border-artha-border">
      <div className="flex items-center gap-3">
        <span className="shrink-0">{icon}</span>
        <div>
          <p className="text-sm text-artha-text">{title}</p>
          <p className="text-xs text-artha-muted mt-0.5">{description}</p>
        </div>
      </div>
      <button
        disabled={disabled}
        onClick={onToggle}
        className={`relative shrink-0 rounded-full transition-colors disabled:opacity-50 ${on ? 'bg-artha-accent' : 'bg-artha-border'}`}
        style={{ minWidth: '2.5rem', height: '1.375rem' }}
        aria-pressed={on}
        title={on ? `Disable ${title}` : `Enable ${title}`}
      >
        <span
          className="absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform"
          style={{ transform: on ? 'translateX(1.125rem)' : 'translateX(0)' }}
        />
      </button>
    </div>
  );
}

/** General preferences panel — loads on mount, persists each change immediately. */
export default function SettingsPanel() {
  // ── State ──────────────────────────────────────────────────────────────────
  const [settings, setSettings] = useState<AppSettings>({});
  const [sentryEnabled, setSentryEnabled] = useState(true);
  const [loading, setLoading] = useState(true);
  // Disables toggles while a write is in flight to prevent double-tap races.
  const [saving, setSaving] = useState(false);

  // ── Effects ────────────────────────────────────────────────────────────────
  useEffect(() => {
    Promise.all([
      window.artha.settings.get(),
      window.artha.settings.getSentry(),
    ]).then(([s, sentry]) => {
      setSettings(s as AppSettings);
      setSentryEnabled(sentry.enabled);
      setLoading(false);
    });
  }, []);

  // ── Handlers ───────────────────────────────────────────────────────────────

  /** Write a single boolean key to settings_json and mirror it into local state. */
  const toggle = async (key: keyof AppSettings, value: boolean) => {
    setSaving(true);
    const patch = { [key]: value };
    await window.artha.settings.set(patch);
    setSettings(prev => ({ ...prev, ...patch }));
    setSaving(false);
  };

  /** Sentry uses its own channel so disabling stops transmission immediately. */
  const toggleSentry = async (value: boolean) => {
    setSaving(true);
    await window.artha.settings.setSentry(value);
    setSentryEnabled(value);
    setSaving(false);
  };

  // Defaults treat absence of the key as "on" — these are all opt-out.
  const notificationsOn = settings.notifications_enabled !== false;
  const reasoningOn = settings.show_reasoning !== false;
  // Default OFF: Artha leaves the lightweight Ollama server running for instant
  // restarts (the resident model is always freed on quit regardless).
  const stopOllamaOnQuit = settings.ollama_stop_on_quit === true;
  // Opt-IN (default off): a privacy-first audience shouldn't get proactive
  // surfaces unless they ask for them.
  const briefingsOn = settings.briefingsEnabled === true;

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="max-w-xl mx-auto">
        <div className="mb-6">
          <h2 className="text-lg font-semibold text-artha-text">Settings</h2>
          <p className="text-sm text-artha-muted mt-0.5">General application preferences.</p>
        </div>

        {loading ? (
          <p className="text-sm text-artha-muted">Loading…</p>
        ) : (
          <div className="space-y-3">

            <ToggleRow
              icon={notificationsOn
                ? <Bell size={16} className="text-artha-accent" />
                : <BellOff size={16} className="text-artha-muted" />}
              title="Native notifications"
              description="Show an OS alert when a long task or scheduled job completes."
              on={notificationsOn}
              disabled={saving}
              onToggle={() => toggle('notifications_enabled', !notificationsOn)}
            />

            {/* Show agent reasoning — when off, the <think> phase still runs and
                is still saved, only the in-chat disclosure is hidden. */}
            <ToggleRow
              icon={<Sparkles size={16} className={reasoningOn ? 'text-artha-accent' : 'text-artha-muted'} />}
              title="Show agent reasoning"
              description="Display the agent's step-by-step thinking as an expandable panel while it works. The reasoning still runs when this is off — it's just hidden."
              on={reasoningOn}
              disabled={saving}
              onToggle={() => toggle('show_reasoning', !reasoningOn)}
            />

            {/* Daily briefing — opt-IN. A quiet launch digest of recent activity,
                computed locally from your own data. */}
            <ToggleRow
              icon={<Newspaper size={16} className={briefingsOn ? 'text-artha-accent' : 'text-artha-muted'} />}
              title="Daily briefing"
              description="Show a short 'since you were last here' summary on launch — recent runs, file changes, and new contacts/memory. Off by default; computed entirely on-device."
              on={briefingsOn}
              disabled={saving}
              onToggle={() => toggle('briefingsEnabled', !briefingsOn)}
            />

            {/* Crash reporting (Sentry) — opt-out, no files or conversations. */}
            <ToggleRow
              icon={<ShieldCheck size={16} className={sentryEnabled ? 'text-artha-accent' : 'text-artha-muted'} />}
              title="Send anonymous crash reports"
              description="Helps fix bugs. Only error types and stack traces are sent — never your files, conversations, or file paths."
              on={sentryEnabled}
              disabled={saving}
              onToggle={() => toggleSentry(!sentryEnabled)}
            />

            {/* Local model lifecycle. Artha starts Ollama for you and frees the
                model from memory on quit. The server itself stays running for
                instant restarts unless you turn this on. */}
            <ToggleRow
              icon={<Power size={16} className={stopOllamaOnQuit ? 'text-artha-accent' : 'text-artha-muted'} />}
              title="Fully stop Ollama when I quit"
              description="Artha keeps Ollama running in the background for instant startup and frees the model from memory when you quit. Turn this on to also shut down the Ollama server Artha started (next launch will be a little slower)."
              on={stopOllamaOnQuit}
              disabled={saving}
              onToggle={() => toggle('ollama_stop_on_quit', !stopOllamaOnQuit)}
            />

          </div>
        )}
      </div>
    </div>
  );
}
