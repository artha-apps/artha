/**
 * OrgSetup — first-run sub-flow for the "I'm setting up Artha for my
 * organization" path. Three guided steps that take an admin from a fresh
 * Enterprise license to a fully provisioned hub with copyable connection
 * cards for each teammate:
 *
 *   1. Paste & verify the org license key (license:apply).
 *   2. Start the LAN/hub server (lan:start) — gated by the entitlement.
 *   3. Provision seats: each row mints a team_members entry + a bound API key
 *      and renders a copyable connection card (hub URL + key).
 *
 * On finish, persists persona='org_admin' + onboardingComplete=true and yields
 * back to App.tsx via `onDone`. The LicensePanel in Settings remains the place
 * to manage the license later — this flow is one-time.
 */
import { useEffect, useState } from 'react';
import { ArrowRight, Building2, Check, ClipboardCopy, KeyRound, Plus, ShieldCheck, Trash2, Wifi } from 'lucide-react';

type Tier = 'free' | 'pro' | 'enterprise';
interface Entitlements {
  tier: Tier; seats: number; lanServer: boolean; sharedMemory: boolean;
  orgHub: boolean; rbac: boolean; auditExport: boolean;
  org: string | null; expiresAt: number | null;
}

interface ProvisionedSeat {
  memberId: string;
  name: string;
  role: 'admin' | 'member';
  keyId: string;
  plaintextKey: string; // shown once, then forgotten when this flow closes
}

export default function OrgSetup({ onDone, onBack }: { onDone: () => void; onBack: () => void }) {
  // ── Step 1: license ────────────────────────────────────────────────────
  const [licenseDraft, setLicenseDraft] = useState('');
  const [ents, setEnts] = useState<Entitlements | null>(null);
  const [licenseError, setLicenseError] = useState('');
  const [licenseBusy, setLicenseBusy] = useState(false);

  // ── Step 2: hub ────────────────────────────────────────────────────────
  const [hubUrl, setHubUrl] = useState<string | null>(null);
  const [hubError, setHubError] = useState('');
  const [hubBusy, setHubBusy] = useState(false);

  // ── Step 3: seats ──────────────────────────────────────────────────────
  const [seatDraftName, setSeatDraftName] = useState('');
  const [seatDraftRole, setSeatDraftRole] = useState<'admin' | 'member'>('member');
  const [seats, setSeats] = useState<ProvisionedSeat[]>([]);
  const [seatError, setSeatError] = useState('');
  const [seatBusy, setSeatBusy] = useState(false);

  // Pull current entitlements on mount in case the admin already applied a
  // key from the License panel before opening onboarding.
  useEffect(() => {
    window.artha.license.get().then(res => { if (res.hasKey) setEnts(res.entitlements); });
    window.artha.lan.getStatus().then(s => { if (s.running && s.url) setHubUrl(s.url); });
  }, []);

  // ── Handlers ───────────────────────────────────────────────────────────
  const applyLicense = async () => {
    setLicenseBusy(true); setLicenseError('');
    try {
      const res = await window.artha.license.apply(licenseDraft.trim());
      if (!res.ok) { setLicenseError(res.error); return; }
      if (res.entitlements.tier === 'free') {
        setLicenseError('That key applied as Free — Enterprise/Pro is required for org setup.');
        return;
      }
      setEnts(res.entitlements);
      setLicenseDraft('');
    } finally { setLicenseBusy(false); }
  };

  const startHub = async () => {
    setHubBusy(true); setHubError('');
    try {
      const res = await window.artha.lan.start();
      if (res.error || !res.url) {
        setHubError(res.error ?? 'Unable to start the hub. Check that port 7842 is free.');
        return;
      }
      setHubUrl(res.url);
    } finally { setHubBusy(false); }
  };

  const addSeat = async () => {
    const name = seatDraftName.trim();
    if (!name) return;
    setSeatBusy(true); setSeatError('');
    try {
      const member = await window.artha.team.addMember({ displayName: name, role: seatDraftRole });
      const key = await window.artha.apikeys.create({ name: `${name}'s seat`, memberId: member.member_id });
      setSeats(prev => [...prev, { memberId: member.member_id, name, role: seatDraftRole, keyId: key.key_id, plaintextKey: key.plaintext }]);
      setSeatDraftName('');
      setSeatDraftRole('member');
    } catch (err) {
      setSeatError(err instanceof Error ? err.message : String(err));
    } finally { setSeatBusy(false); }
  };

  const removeSeat = async (s: ProvisionedSeat) => {
    setSeatBusy(true); setSeatError('');
    try {
      await window.artha.apikeys.revoke(s.keyId);
      await window.artha.team.removeMember(s.memberId);
      setSeats(prev => prev.filter(p => p.memberId !== s.memberId));
    } finally { setSeatBusy(false); }
  };

  const copy = (text: string) => navigator.clipboard.writeText(text).catch(() => {});

  const finish = async () => {
    await window.artha.settings.set({ persona: 'org_admin', onboardingComplete: true });
    onDone();
  };

  const licenseReady = !!ents && ents.tier !== 'free';
  const hubReady = !!hubUrl;
  const seatsReady = seats.length >= 1;

  // ── Render ─────────────────────────────────────────────────────────────
  return (
    <div className="w-full max-w-2xl bg-artha-s2 border border-artha-border rounded-2xl shadow-2xl p-8">
      <div className="flex items-center justify-between mb-6">
        <button onClick={onBack} className="text-xs text-artha-muted hover:text-artha-text transition-colors">← Back</button>
        <span className="text-[11px] uppercase tracking-wide text-artha-muted">Organization setup</span>
      </div>

      <div className="flex flex-col items-center text-center mb-6">
        <div className="w-14 h-14 rounded-2xl bg-artha-accent/20 border border-artha-accent/20 flex items-center justify-center mb-4">
          <Building2 size={26} className="text-artha-accent" />
        </div>
        <h1 className="text-xl font-semibold text-artha-text mb-1">Set up Artha for your team</h1>
        <p className="text-sm text-artha-muted">Three steps. Everything stays on your network — no cloud account.</p>
      </div>

      {/* Step 1: license */}
      <Section
        n={1}
        done={licenseReady}
        title="Apply your organization license"
        subtitle={licenseReady ? `${ents!.org ?? 'Organization'} · ${ents!.tier} · ${ents!.seats} seats` : 'Required to unlock team features.'}
      >
        {!licenseReady && (
          <>
            <textarea
              value={licenseDraft}
              onChange={e => setLicenseDraft(e.target.value)}
              placeholder="Paste the license token you received (one line)."
              rows={3}
              className="w-full font-mono text-xs px-3 py-2 rounded-lg bg-artha-surface border border-artha-border focus:border-artha-accent focus:outline-none text-artha-text resize-none"
            />
            {licenseError && <p className="text-xs text-red-400 mt-2">{licenseError}</p>}
            <button
              onClick={applyLicense}
              disabled={licenseBusy || !licenseDraft.trim()}
              className="mt-3 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-artha-accent hover:bg-artha-accent/80 text-xs font-medium text-white transition-colors disabled:opacity-40"
            >
              <KeyRound size={12} /> Apply license
            </button>
          </>
        )}
      </Section>

      {/* Step 2: hub */}
      <Section
        n={2}
        done={hubReady}
        disabled={!licenseReady}
        title="Start the team hub"
        subtitle={hubReady ? hubUrl! : 'Binds the local hub at http://<your-ip>:7842 so teammates can connect.'}
      >
        {licenseReady && !hubReady && (
          <>
            {hubError && <p className="text-xs text-red-400 mb-2">{hubError}</p>}
            <button
              onClick={startHub}
              disabled={hubBusy}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-artha-accent hover:bg-artha-accent/80 text-xs font-medium text-white transition-colors disabled:opacity-40"
            >
              <Wifi size={12} /> Start hub
            </button>
          </>
        )}
        {hubReady && (
          <div className="flex items-center gap-2 text-xs text-artha-muted">
            <code className="bg-artha-surface border border-artha-border rounded px-2 py-1 text-artha-text">{hubUrl}</code>
            <button onClick={() => copy(hubUrl!)} className="inline-flex items-center gap-1 text-artha-muted hover:text-artha-text transition-colors">
              <ClipboardCopy size={11} /> copy
            </button>
          </div>
        )}
      </Section>

      {/* Step 3: seats */}
      <Section
        n={3}
        done={seatsReady}
        disabled={!hubReady}
        title="Provision a seat per teammate"
        subtitle={
          ents
            ? `${seats.length}/${ents.seats} seats provisioned. You can add more later in Settings → Team.`
            : 'Each seat mints a unique key bound to that teammate.'
        }
      >
        {hubReady && (
          <>
            <div className="flex gap-2 mb-3">
              <input
                value={seatDraftName}
                onChange={e => setSeatDraftName(e.target.value)}
                placeholder="Teammate name"
                className="flex-1 text-sm px-3 py-1.5 rounded-lg bg-artha-surface border border-artha-border focus:border-artha-accent focus:outline-none text-artha-text"
                onKeyDown={e => { if (e.key === 'Enter') addSeat(); }}
              />
              <select
                value={seatDraftRole}
                onChange={e => setSeatDraftRole(e.target.value as 'admin' | 'member')}
                className="text-sm px-2 py-1.5 rounded-lg bg-artha-surface border border-artha-border text-artha-text"
              >
                <option value="member">member</option>
                <option value="admin">admin</option>
              </select>
              <button
                onClick={addSeat}
                disabled={seatBusy || !seatDraftName.trim() || !ents || seats.length >= ents.seats}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-artha-accent hover:bg-artha-accent/80 text-xs font-medium text-white transition-colors disabled:opacity-40"
              >
                <Plus size={12} /> Add
              </button>
            </div>
            {seatError && <p className="text-xs text-red-400 mb-2">{seatError}</p>}

            {seats.length > 0 && (
              <div className="space-y-2">
                {seats.map(s => (
                  <ConnectionCard
                    key={s.memberId}
                    seat={s}
                    hubUrl={hubUrl!}
                    onRemove={() => removeSeat(s)}
                    onCopy={copy}
                  />
                ))}
                <p className="text-[11px] text-artha-muted">
                  ⚠ The keys above are shown ONCE. Copy each card to its teammate before finishing — keys cannot be retrieved later (only revoked + reissued).
                </p>
              </div>
            )}
          </>
        )}
      </Section>

      {/* Finish */}
      <div className="mt-6 pt-4 border-t border-artha-border flex items-center justify-between">
        <p className="text-xs text-artha-muted">
          You can add more teammates later in Workspace Settings → Team.
        </p>
        <button
          onClick={finish}
          disabled={!licenseReady || !hubReady}
          className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-artha-accent hover:bg-artha-accent/80 text-sm font-medium text-white transition-colors disabled:opacity-40"
        >
          Finish <ArrowRight size={14} />
        </button>
      </div>
    </div>
  );
}

// ── Internal helpers ──────────────────────────────────────────────────────

function Section({
  n, title, subtitle, done, disabled = false, children,
}: { n: number; title: string; subtitle: string; done: boolean; disabled?: boolean; children: React.ReactNode }) {
  return (
    <div className={`rounded-xl border p-4 mb-3 transition-opacity ${
      done ? 'bg-artha-accent/5 border-artha-accent/30'
        : disabled ? 'bg-artha-surface border-artha-border opacity-50'
        : 'bg-artha-surface border-artha-border'}`}>
      <div className="flex items-start gap-3 mb-3">
        <div className={`w-6 h-6 rounded-full flex items-center justify-center text-[11px] font-semibold ${
          done ? 'bg-artha-accent text-white' : 'bg-artha-s2 text-artha-muted border border-artha-border'}`}>
          {done ? <Check size={13} /> : n}
        </div>
        <div className="flex-1">
          <p className="text-sm font-medium text-artha-text">{title}</p>
          <p className="text-xs text-artha-muted">{subtitle}</p>
        </div>
        {done && <ShieldCheck size={14} className="text-artha-accent" />}
      </div>
      {!disabled && !done && children}
    </div>
  );
}

function ConnectionCard({
  seat, hubUrl, onRemove, onCopy,
}: { seat: ProvisionedSeat; hubUrl: string; onRemove: () => void; onCopy: (text: string) => void }) {
  const card = `Artha team hub
Hub URL: ${hubUrl}
Name: ${seat.name}
Role: ${seat.role}
Bearer key: ${seat.plaintextKey}

Quick test (any machine on your network):
  curl -H "Authorization: Bearer ${seat.plaintextKey}" \\
       -d '{"message":"hello"}' \\
       ${hubUrl}/chat
`;
  return (
    <div className="rounded-lg bg-artha-s2 border border-artha-border p-3">
      <div className="flex items-center justify-between mb-2">
        <div>
          <span className="text-sm text-artha-text font-medium">{seat.name}</span>
          <span className="text-xs text-artha-muted ml-2">· {seat.role}</span>
        </div>
        <div className="flex items-center gap-1">
          <button onClick={() => onCopy(card)} className="inline-flex items-center gap-1 text-xs text-artha-muted hover:text-artha-text transition-colors">
            <ClipboardCopy size={11} /> copy card
          </button>
          <button onClick={onRemove} className="text-xs text-artha-muted hover:text-red-400 transition-colors ml-2">
            <Trash2 size={11} />
          </button>
        </div>
      </div>
      <pre className="text-[11px] font-mono text-artha-muted whitespace-pre-wrap break-all bg-artha-surface border border-artha-border rounded p-2">{card}</pre>
    </div>
  );
}
