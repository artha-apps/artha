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

interface AppSettings {
  notifications_enabled?: boolean;
  [key: string]: unknown;
}

export default function SettingsPanel() {
  const [settings, setSettings] = useState<AppSettings>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    window.artha.settings.get().then((s: AppSettings) => {
      setSettings(s);
      setLoading(false);
    });
  }, []);

  const toggle = async (key: keyof AppSettings, value: boolean) => {
    setSaving(true);
    const patch = { [key]: value };
    await window.artha.settings.set(patch);
    setSettings(prev => ({ ...prev, ...patch }));
    setSaving(false);
  };

  const notificationsOn = settings.notifications_enabled !== false;

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="max-w-xl mx-auto">
        <div className="mb-6">
          <h2 className="text-lg font-semibold text-white">Settings</h2>
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
                  <p className="text-sm text-white">Native notifications</p>
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
