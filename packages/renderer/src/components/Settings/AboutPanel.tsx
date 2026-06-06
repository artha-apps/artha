/**
 * AboutPanel — application info inside Workspace Settings: version (the release),
 * runtime build details, and credits. Version comes from the main process
 * (app.getVersion()), so it always matches the installed build.
 */
import { useEffect, useState } from 'react';
import { Download, ExternalLink } from 'lucide-react';
import { BrandWordmark } from '../ui/BrandWordmark';

interface AppInfo {
  version: string;
  electron: string;
  node: string;
  chrome: string;
  platform: string;
}

export default function AboutPanel() {
  const [info, setInfo] = useState<AppInfo | null>(null);

  useEffect(() => {
    window.artha.system.getAppInfo().then(setInfo).catch(() => setInfo(null));
  }, []);

  const rows: Array<[string, string]> = info
    ? [
        ['Release', `v${info.version}`],
        ['Platform', info.platform],
        ['Electron', info.electron],
        ['Chromium', info.chrome],
        ['Node', info.node],
      ]
    : [];

  return (
    <div>
      <h2 className="text-lg font-semibold text-artha-text mb-1">About Artha</h2>
      <p className="text-sm text-artha-muted mb-6">
        A local-first AI agent for serious work — runs on your machine, zero telemetry.
      </p>

      {/* Identity */}
      <div className="flex items-center gap-3 mb-6">
        <img src="./logo-mark.png" alt="" width={44} height={44} className="rounded-lg" onError={(e) => { (e.currentTarget.style.display = 'none'); }} />
        <div>
          <BrandWordmark height={18} />
          <div className="mt-1 text-sm text-artha-muted">
            {info ? `Version ${info.version}` : 'Loading…'}
          </div>
        </div>
      </div>

      {/* Build details */}
      <div className="rounded-xl border border-artha-border overflow-hidden mb-6 max-w-md">
        {rows.map(([k, v], i) => (
          <div
            key={k}
            className={`flex items-center justify-between px-4 py-2.5 text-sm ${i % 2 ? 'bg-artha-surface2/40' : ''}`}
          >
            <span className="text-artha-muted">{k}</span>
            <span className="text-artha-text font-mono text-[13px]">{v}</span>
          </div>
        ))}
      </div>

      {/* Actions */}
      <div className="flex flex-wrap gap-2 mb-6">
        <button
          onClick={() => window.artha.updates.openDownload()}
          className="flex items-center gap-2 px-3.5 py-2 rounded-lg bg-artha-accent hover:bg-artha-accent-hover text-artha-on-accent text-sm font-medium transition-colors"
        >
          <Download size={14} /> Check for updates
        </button>
        <a
          href="https://github.com/artha-apps/artha/releases"
          target="_blank"
          rel="noreferrer"
          className="flex items-center gap-2 px-3.5 py-2 rounded-lg border border-artha-border text-artha-text text-sm hover:border-artha-accent transition-colors"
        >
          <ExternalLink size={14} /> Release notes
        </a>
      </div>

      <div className="text-xs text-artha-subtle border-t border-artha-border pt-4">
        © 2026 Artha · Presented by Shree Labs Inc.
      </div>
    </div>
  );
}
