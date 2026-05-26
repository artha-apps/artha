/**
 * LANServerPanel — start/stop the LAN collaboration server and show how to
 * reach it (URL, inline QR, curl/fetch examples). The QR code is rendered from
 * our dependency-free encoder in ../../lib/qrcode.
 */
import { useEffect, useMemo, useState } from 'react';
import { Wifi, Copy, Check, AlertTriangle } from 'lucide-react';
import { qrToSvg } from '../../lib/qrcode';

interface LanStatus { running: boolean; url: string | null; localIp: string | null }

export default function LANServerPanel() {
  const [status, setStatus] = useState<LanStatus>({ running: false, url: null, localIp: null });
  const [autostart, setAutostart] = useState(false);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    window.artha.lan.getStatus().then(setStatus).catch(() => {});
    window.artha.lan.getAutostart().then(setAutostart).catch(() => {});
  }, []);

  const toggleServer = async () => {
    setBusy(true);
    try {
      const next = status.running ? await window.artha.lan.stop() : await window.artha.lan.start();
      setStatus(next);
    } finally {
      setBusy(false);
    }
  };

  const toggleAutostart = async () => {
    const next = !autostart;
    setAutostart(next);
    await window.artha.lan.setAutostart(next);
  };

  const url = status.url ?? '';
  const copyUrl = () => {
    navigator.clipboard.writeText(url);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  // Re-render the QR only when the URL changes.
  const qrSvg = useMemo(() => (url ? qrToSvg(url, { moduleSize: 5, margin: 2 }) : ''), [url]);

  const curlHealth = `curl ${url}/health`;
  const curlChat = `curl -X POST ${url}/chat -d '{"message":"hello"}'`;
  const fetchSnippet = `const res = await fetch("${url}/chat", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ message: "Summarize my notes" }),
});
// NDJSON stream: { type: "token" | "done" | "error", content }
const reader = res.body.getReader();`;

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="max-w-3xl mx-auto">
        {/* Header */}
        <div className="flex items-center gap-3 mb-6">
          <Wifi size={22} className="text-cyan-400" />
          <div>
            <h2 className="text-lg font-semibold text-white">LAN Server</h2>
            <p className="text-sm text-artha-muted">Expose Artha’s agent over your local network so teammates can use it</p>
          </div>
        </div>

        {/* Security notice */}
        <div className="flex items-start gap-3 p-3 mb-6 rounded-xl bg-yellow-500/10 border border-yellow-500/30 text-sm text-yellow-300">
          <AlertTriangle size={16} className="shrink-0 mt-0.5" />
          <span>Anyone on your local network can send messages to your agent while this is on.</span>
        </div>

        {/* Toggle */}
        <div className="flex items-center justify-between px-4 py-4 mb-6 rounded-xl bg-artha-s2 border border-artha-border">
          <div className="flex items-center gap-3">
            <span className={`w-2.5 h-2.5 rounded-full ${status.running ? 'bg-green-400 shadow-[0_0_6px_rgba(74,222,128,0.7)]' : 'bg-gray-500'}`} />
            <div>
              <p className="text-sm font-semibold text-white">Server {status.running ? 'running' : 'stopped'}</p>
              <p className="text-xs text-artha-muted mt-0.5">Listens on port 7842 across your local network.</p>
            </div>
          </div>
          <button
            onClick={toggleServer}
            disabled={busy}
            role="switch"
            aria-checked={status.running}
            className={`relative w-11 h-6 rounded-full transition-colors shrink-0 disabled:opacity-50 ${status.running ? 'bg-cyan-500' : 'bg-white/15'}`}
          >
            <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white transition-transform ${status.running ? 'translate-x-5' : ''}`} />
          </button>
        </div>

        {/* Running details */}
        {status.running && url && (
          <>
            {/* URL pill + QR */}
            <div className="flex flex-col sm:flex-row gap-5 items-center mb-6">
              <div
                className="bg-white rounded-xl p-3 shrink-0"
                aria-label="QR code linking to the LAN server URL"
                dangerouslySetInnerHTML={{ __html: qrSvg }}
              />
              <div className="flex-1 w-full">
                <p className="text-xs text-artha-muted mb-1.5">Reachable at</p>
                <button
                  onClick={copyUrl}
                  className="group flex items-center gap-2 w-full px-3 py-2.5 rounded-xl bg-artha-s2 border border-artha-border hover:border-cyan-500/40 transition-colors"
                >
                  <code className="flex-1 text-left text-sm text-cyan-300 font-mono truncate">{url}</code>
                  {copied ? <Check size={14} className="text-green-400" /> : <Copy size={14} className="text-artha-muted group-hover:text-white" />}
                </button>
                <p className="text-xs text-artha-muted/70 mt-2">Scan the QR or share the URL with anyone on the same Wi-Fi.</p>
              </div>
            </div>

            {/* Usage examples */}
            <h3 className="text-sm font-semibold text-gray-300 mb-2">Usage</h3>
            <div className="space-y-3">
              {[
                { label: 'Health check', code: curlHealth },
                { label: 'Send a message', code: curlChat },
                { label: 'JavaScript (streaming)', code: fetchSnippet },
              ].map(ex => (
                <div key={ex.label}>
                  <p className="text-xs text-artha-muted mb-1">{ex.label}</p>
                  <pre className="p-3 rounded-xl bg-black/40 border border-white/10 text-xs text-green-300/90 font-mono overflow-x-auto whitespace-pre-wrap">
                    {ex.code}
                  </pre>
                </div>
              ))}
            </div>
          </>
        )}

        {/* Autostart */}
        <label className="flex items-center gap-3 mt-6 px-4 py-3 rounded-xl bg-artha-s2 border border-artha-border cursor-pointer">
          <input
            type="checkbox"
            checked={autostart}
            onChange={toggleAutostart}
            className="w-4 h-4 accent-cyan-500"
          />
          <span className="text-sm text-white">Start the LAN server automatically when Artha launches</span>
        </label>
      </div>
    </div>
  );
}
