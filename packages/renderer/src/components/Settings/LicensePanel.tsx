/**
 * LicensePanel — view current tier / seats / expiry and paste, replace, or
 * clear the offline-signed license key.
 *
 * Surfaced under Workspace Settings → Team → License so customers can apply or
 * rotate a key without having to re-trigger the first-run onboarding flow. The
 * raw key is never read back from main; the panel only sees derived
 * entitlements (tier, seats, org, expiry).
 */
import { useEffect, useState } from 'react';
import { CheckCircle2, KeyRound, Trash2, ShieldCheck } from 'lucide-react';

type Tier = 'free' | 'pro' | 'enterprise';

interface Entitlements {
  tier: Tier;
  seats: number;
  lanServer: boolean;
  sharedMemory: boolean;
  orgHub: boolean;
  rbac: boolean;
  auditExport: boolean;
  org: string | null;
  expiresAt: number | null;
}

const TIER_LABEL: Record<Tier, string> = { free: 'Free', pro: 'Pro', enterprise: 'Enterprise' };
const TIER_BLURB: Record<Tier, string> = {
  free: 'Local desktop only. 1 seat. LAN server disabled.',
  pro: 'Solo / small team. LAN/team server, shared memories, seat-capped roster.',
  enterprise: 'Org hub deployment, RBAC on hub endpoints, audit-log export.',
};

function formatExpiry(exp: number | null): string {
  if (!exp) return '—';
  const d = new Date(exp * 1000);
  return d.toISOString().slice(0, 10);
}

export default function LicensePanel() {
  const [ents, setEnts] = useState<Entitlements | null>(null);
  const [hasKey, setHasKey] = useState(false);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [flash, setFlash] = useState('');

  // Fetch current entitlements on mount. We re-fetch after every mutation so
  // the panel reflects whatever the verifier just decided.
  const refresh = async () => {
    const res = await window.artha.license.get();
    setEnts(res.entitlements);
    setHasKey(res.hasKey);
  };
  useEffect(() => { refresh(); }, []);

  const apply = async () => {
    setBusy(true); setError(''); setFlash('');
    try {
      const res = await window.artha.license.apply(draft.trim());
      if (!res.ok) {
        setError(res.error);
      } else {
        setEnts(res.entitlements);
        setHasKey(true);
        setDraft('');
        setFlash(`License applied — ${TIER_LABEL[res.entitlements.tier]} (${res.entitlements.seats} seats).`);
      }
    } finally { setBusy(false); }
  };

  const clear = async () => {
    setBusy(true); setError(''); setFlash('');
    try {
      const res = await window.artha.license.clear();
      setEnts(res.entitlements);
      setHasKey(false);
      setFlash('License cleared — reverted to Free.');
    } finally { setBusy(false); }
  };

  if (!ents) {
    return <div className="flex-1 p-6 text-sm text-artha-muted">Loading…</div>;
  }

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="max-w-xl mx-auto">
        <div className="mb-6">
          <h2 className="text-lg font-semibold text-artha-text">License</h2>
          <p className="text-sm text-artha-muted mt-0.5">
            Offline-verified license key. Determines tier, seats, and which team features are unlocked. Verification is local — no data leaves your machine.
          </p>
        </div>

        {/* Current tier card */}
        <div className="rounded-xl bg-artha-s2 border border-artha-border p-4 mb-4">
          <div className="flex items-center gap-3 mb-2">
            <ShieldCheck size={16} className="text-artha-accent" />
            <span className="text-sm font-semibold text-artha-text">{TIER_LABEL[ents.tier]}</span>
            {ents.org && (
              <span className="text-xs text-artha-muted">· {ents.org}</span>
            )}
          </div>
          <p className="text-xs text-artha-muted mb-3">{TIER_BLURB[ents.tier]}</p>
          <dl className="grid grid-cols-3 gap-3 text-xs">
            <div>
              <dt className="text-artha-muted">Seats</dt>
              <dd className="text-artha-text font-medium">{ents.seats}</dd>
            </div>
            <div>
              <dt className="text-artha-muted">LAN server</dt>
              <dd className="text-artha-text font-medium">{ents.lanServer ? 'Yes' : 'Disabled'}</dd>
            </div>
            <div>
              <dt className="text-artha-muted">Expires</dt>
              <dd className="text-artha-text font-medium">{formatExpiry(ents.expiresAt)}</dd>
            </div>
          </dl>
        </div>

        {/* Apply / replace key */}
        <div className="rounded-xl bg-artha-s2 border border-artha-border p-4 mb-4">
          <label className="block text-xs font-medium text-artha-muted uppercase tracking-wide mb-2">
            {hasKey ? 'Replace license key' : 'Apply a license key'}
          </label>
          <textarea
            value={draft}
            onChange={e => setDraft(e.target.value)}
            placeholder="Paste your license token (a single line — looks like base64.base64)"
            rows={3}
            className="w-full font-mono text-xs px-3 py-2 rounded-lg bg-artha-surface border border-artha-border focus:border-artha-accent focus:outline-none text-artha-text resize-none"
          />
          {error && <p className="text-xs text-red-400 mt-2">{error}</p>}
          {flash && <p className="text-xs text-green-400 mt-2 inline-flex items-center gap-1"><CheckCircle2 size={12} /> {flash}</p>}
          <div className="flex items-center gap-2 mt-3">
            <button
              onClick={apply}
              disabled={busy || !draft.trim()}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-artha-accent hover:bg-artha-accent/80 text-xs font-medium text-white transition-colors disabled:opacity-40"
            >
              <KeyRound size={12} /> Apply
            </button>
            {hasKey && (
              <button
                onClick={clear}
                disabled={busy}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-artha-surface hover:bg-white/5 border border-artha-border text-xs text-artha-muted hover:text-white transition-colors disabled:opacity-40"
              >
                <Trash2 size={12} /> Clear key (revert to Free)
              </button>
            )}
          </div>
        </div>

        <p className="text-[11px] text-artha-muted">
          Don't have a key? Free is unlimited for solo local use. Reach out for Pro or Enterprise pricing.
        </p>
      </div>
    </div>
  );
}
