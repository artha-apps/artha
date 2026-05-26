/**
 * CloudIntegrationsPanel — connect Google Workspace (Gmail, Calendar, Drive)
 * via an installed-app OAuth flow. A single Google grant covers all three
 * read-only scopes, so the three rows share one connection state.
 */
import { useEffect, useState } from 'react';
import { Link as LinkIcon, ChevronDown, ChevronRight, ExternalLink, AlertTriangle, Loader, Mail, Calendar, HardDrive } from 'lucide-react';

const SERVICES = [
  { id: 'gmail',    label: 'Gmail',           icon: Mail,      desc: 'Read-only access to your messages and threads.' },
  { id: 'calendar', label: 'Google Calendar', icon: Calendar,  desc: 'Read-only access to your events and calendars.' },
  { id: 'drive',    label: 'Google Drive',    icon: HardDrive, desc: 'Read-only access to your files and folders.' },
] as const;

export default function CloudIntegrationsPanel() {
  const [clientId, setClientId] = useState('');
  const [savedClientId, setSavedClientId] = useState('');
  const [connected, setConnected] = useState(false);
  const [setupOpen, setSetupOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refreshStatus = async () => {
    const rows = await window.artha.oauth.getStatus();
    setConnected(rows.some(r => r.provider === 'google'));
  };

  useEffect(() => {
    window.artha.settings.getGoogleClientId().then(id => { setClientId(id); setSavedClientId(id); });
    refreshStatus().catch(() => {});
  }, []);

  // Auto-expand the setup section when there's no client id yet.
  useEffect(() => {
    if (!savedClientId) setSetupOpen(true);
  }, [savedClientId]);

  const saveClientId = async () => {
    await window.artha.settings.setGoogleClientId(clientId.trim());
    setSavedClientId(clientId.trim());
  };

  const connect = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await window.artha.oauth.startFlow('google');
      if (!res.success) setError(res.error ?? 'Connection failed.');
      await refreshStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    setBusy(true);
    setError(null);
    try {
      await window.artha.oauth.revoke('google');
      await refreshStatus();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="max-w-3xl mx-auto">
        {/* Header */}
        <div className="flex items-center gap-3 mb-6">
          <LinkIcon size={22} className="text-cyan-400" />
          <div>
            <h2 className="text-lg font-semibold text-white">Cloud Integrations</h2>
            <p className="text-sm text-artha-muted">Connect Google Workspace so the agent can read your mail, calendar, and files</p>
          </div>
        </div>

        {/* No-client-id warning */}
        {!savedClientId && (
          <div className="flex items-start gap-3 p-3 mb-4 rounded-xl bg-yellow-500/10 border border-yellow-500/30 text-sm text-yellow-300">
            <AlertTriangle size={16} className="shrink-0 mt-0.5" />
            <span>No Google Client ID set yet. Add one in <strong>Setup</strong> below before connecting.</span>
          </div>
        )}

        {/* Setup (collapsible) */}
        <div className="mb-6 rounded-xl bg-artha-s2 border border-artha-border overflow-hidden">
          <button
            onClick={() => setSetupOpen(o => !o)}
            className="w-full flex items-center gap-2 px-4 py-3 text-sm font-medium text-white hover:bg-white/5 transition-colors"
          >
            {setupOpen ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
            Setup
            {savedClientId && <span className="ml-auto text-xs text-green-400">Client ID saved</span>}
          </button>
          {setupOpen && (
            <div className="px-4 pb-4 space-y-3 border-t border-artha-border pt-3">
              <p className="text-xs text-artha-muted leading-relaxed">
                In Google Cloud Console, create an <strong>OAuth 2.0 Client ID → Desktop app</strong> and paste the
                Client ID here. Add <code className="bg-black/30 px-1 rounded font-mono">http://localhost:9742/oauth/callback</code> as
                an authorized redirect URI.
              </p>
              <a
                href="https://console.cloud.google.com/apis/credentials"
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 text-xs text-cyan-400 hover:text-cyan-300"
              >
                <ExternalLink size={12} /> Open Google Cloud Console credentials
              </a>
              <div className="flex gap-2">
                <input
                  value={clientId}
                  onChange={e => setClientId(e.target.value)}
                  placeholder="xxxxxxxx.apps.googleusercontent.com"
                  className="flex-1 px-3 py-2 rounded-lg bg-artha-surface border border-artha-border text-sm text-white placeholder-artha-muted font-mono focus:outline-none focus:border-cyan-500/50"
                />
                <button
                  onClick={saveClientId}
                  disabled={clientId.trim() === savedClientId}
                  className="px-4 py-2 rounded-lg bg-cyan-600 hover:bg-cyan-500 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-medium transition-colors"
                >
                  Save
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Error */}
        {error && (
          <div className="mb-4 px-4 py-3 rounded-xl bg-red-500/10 border border-red-500/30 text-sm text-red-400">
            {error}
          </div>
        )}

        {/* Service rows */}
        <div className="space-y-3">
          {SERVICES.map(({ id, label, icon: Icon, desc }) => (
            <div key={id} className="flex items-center gap-4 px-4 py-4 rounded-xl bg-artha-s2 border border-artha-border">
              <Icon size={20} className="text-artha-muted shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold text-white">{label}</span>
                  <span className={`w-2 h-2 rounded-full ${connected ? 'bg-green-400 shadow-[0_0_6px_rgba(74,222,128,0.7)]' : 'bg-gray-500'}`} />
                  <span className="text-xs text-artha-muted">{connected ? 'Connected' : 'Disconnected'}</span>
                </div>
                <p className="text-xs text-artha-muted mt-0.5">{desc}</p>
              </div>
              {connected ? (
                <button
                  onClick={disconnect}
                  disabled={busy}
                  className="px-3 py-1.5 rounded-lg border border-artha-border text-artha-muted hover:text-white hover:bg-white/5 text-xs font-medium transition-colors disabled:opacity-40"
                >
                  Disconnect
                </button>
              ) : (
                <button
                  onClick={connect}
                  disabled={busy || !savedClientId}
                  title={!savedClientId ? 'Set a Google Client ID first' : 'Connect'}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-cyan-600 hover:bg-cyan-500 disabled:opacity-40 disabled:cursor-not-allowed text-white text-xs font-medium transition-colors"
                >
                  {busy ? <><Loader size={12} className="animate-spin" /> Connecting…</> : 'Connect'}
                </button>
              )}
            </div>
          ))}
        </div>

        <p className="text-center text-[11px] text-artha-muted/50 mt-6">
          One Google sign-in grants all three read-only scopes. Tokens are stored locally and sent only to Google.
        </p>
      </div>
    </div>
  );
}
