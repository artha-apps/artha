/**
 * AboutPanel — application info inside Workspace Settings: version (the release),
 * runtime build details, and credits. Version comes from the main process
 * (app.getVersion()), so it always matches the installed build.
 */
import { useEffect, useState } from 'react';
import { Download, ExternalLink, ScrollText, X } from 'lucide-react';
import { BrandWordmark } from '../ui/BrandWordmark';

interface AppInfo {
  version: string;
  electron: string;
  node: string;
  chrome: string;
  platform: string;
}

/** GitHub fallback for the notices when the bundled file can't be read. */
const NOTICES_URL =
  'https://github.com/artha-apps/artha/blob/main/THIRD-PARTY-NOTICES.md';

export default function AboutPanel() {
  const [info, setInfo] = useState<AppInfo | null>(null);
  // Open Source Notices modal. `notices`: undefined = not yet loaded,
  // null = load failed (show GitHub fallback), string = markdown/text.
  const [noticesOpen, setNoticesOpen] = useState(false);
  const [notices, setNotices] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    window.artha.system.getAppInfo().then(setInfo).catch(() => setInfo(null));
  }, []);

  function openNotices() {
    setNoticesOpen(true);
    if (notices === undefined) {
      window.artha.system
        .openSourceNotices()
        .then((text) => setNotices(text))
        .catch(() => setNotices(null));
    }
  }

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
          <BrandWordmark size={16} showRule={false} tagline={false} />
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
        <button
          onClick={openNotices}
          className="flex items-center gap-2 px-3.5 py-2 rounded-lg border border-artha-border text-artha-text text-sm hover:border-artha-accent transition-colors"
        >
          <ScrollText size={14} /> Open Source Notices
        </button>
      </div>

      <div className="text-xs text-artha-subtle border-t border-artha-border pt-4">
        © 2026 Shree Labs Inc. · Artha™
      </div>

      {noticesOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6"
          onClick={() => setNoticesOpen(false)}
        >
          <div
            className="flex flex-col w-full max-w-3xl max-h-[80vh] rounded-xl border border-artha-border bg-artha-surface shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-5 py-3 border-b border-artha-border">
              <h3 className="text-sm font-semibold text-artha-text">Open Source Notices</h3>
              <button
                onClick={() => setNoticesOpen(false)}
                aria-label="Close"
                className="text-artha-muted hover:text-artha-text transition-colors"
              >
                <X size={16} />
              </button>
            </div>
            <div className="flex-1 overflow-auto px-5 py-4">
              {notices === undefined && (
                <p className="text-sm text-artha-muted">Loading…</p>
              )}
              {notices === null && (
                <p className="text-sm text-artha-muted">
                  Notices could not be loaded from this build. View them online at{' '}
                  <a
                    href={NOTICES_URL}
                    target="_blank"
                    rel="noreferrer"
                    className="text-artha-accent hover:underline"
                  >
                    THIRD-PARTY-NOTICES.md
                  </a>
                  .
                </p>
              )}
              {typeof notices === 'string' && (
                <pre className="whitespace-pre-wrap break-words font-mono text-xs text-artha-text leading-relaxed">
                  {notices}
                </pre>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
