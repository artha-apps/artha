/**
 * SettingsPanel — general app preferences.
 *
 * Currently exposes:
 *   - Notifications toggle (OS-level alerts for task completion)
 *
 * Settings are stored in the `users.settings_json` blob via the
 * `settings:{get,set}` IPC channels.
 */
import { useEffect, useState } from 'react';
import { Bell, BellOff } from 'lucide-react';

/**
 * Loose shape of the settings blob — the index signature lets the same `toggle`
 * helper handle future boolean keys without a per-key type narrowing.
 */
interface AppSettings {
  notifications_enabled?: boolean;
  [key: string]: unknown;
}

/** General preferences panel — loads on mount, persists each change immediately. */
export default function SettingsPanel() {
  // ── State ──────────────────────────────────────────────────────────────────
  const [settings, setSettings] = useState<AppSettings>({});
  const [loading, setLoading] = useState(true);
  // Disables the toggle while a write is in flight to prevent double-tap races.
  const [saving, setSaving] = useState(false);

  // ── Effects ────────────────────────────────────────────────────────────────
  // Fetch the full settings blob once on mount via the `settings:get` IPC channel.
  useEffect(() => {
    window.artha.settings.get().then((s: AppSettings) => {
      setSettings(s);
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

  // Treat absence of the key as "on" — notifications are opt-out, not opt-in.
  const notificationsOn = settings.notifications_enabled !== false;

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

            {/* Notifications toggle */}
            <div className="flex items-center justify-between px-4 py-3.5 rounded-xl bg-artha-s2 border border-artha-border">
              <div className="flex items-center gap-3">
                {notificationsOn
                  ? <Bell size={16} className="text-artha-accent shrink-0" />
                  : <BellOff size={16} className="text-artha-muted shrink-0" />}
                <div>
                  <p className="text-sm text-artha-text">Native notifications</p>
                  <p className="text-xs text-artha-muted mt-0.5">
                    Show an OS alert when a long task or scheduled job completes.
                  </p>
                </div>
              </div>
              <button
                disabled={saving}
                onClick={() => toggle('notifications_enabled', !notificationsOn)}
                className={`relative w-10 h-5.5 rounded-full transition-colors shrink-0 disabled:opacity-50 ${notificationsOn ? 'bg-artha-accent' : 'bg-artha-border'}`}
                style={{ minWidth: '2.5rem', height: '1.375rem' }}
                aria-pressed={notificationsOn}
                title={notificationsOn ? 'Disable notifications' : 'Enable notifications'}
              >
                <span
                  className="absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform"
                  style={{ transform: notificationsOn ? 'translateX(1.125rem)' : 'translateX(0)' }}
                />
              </button>
            </div>

          </div>
        )}
      </div>
    </div>
  );
}
