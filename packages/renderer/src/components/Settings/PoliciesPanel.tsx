/**
 * PoliciesPanel — manage Tool Policies (per-tool-call governance).
 *
 * A policy binds a tool *pattern* to a *tier* that decides what happens when the
 * agent tries to make that call: run silently (Auto), ask first (Confirm),
 * preview only (Dry run), or block (Forbid). The panel leads with a short
 * plain-English explainer so first-time users understand the four tiers before
 * they touch a rule.
 */
import { useEffect, useState } from 'react';
import { ShieldCheck, Plus, Trash2, Info, Zap, ShieldQuestion, Eye, Ban } from 'lucide-react';

type Tier = 'auto' | 'confirm' | 'dry_run' | 'forbid';
type Scope = 'always' | 'outside_roots';

interface Policy {
  policy_id: string;
  pattern: string;
  tier: Tier;
  scope: Scope;
  note: string;
  is_enabled: number;
  created_at: number;
}

/** Tier metadata: label, helper text, icon, and colour. Order = least → most
 *  restrictive, which is also the order shown in the tier picker. */
const TIERS: { value: Tier; label: string; help: string; icon: typeof Zap; color: string }[] = [
  { value: 'auto',    label: 'Auto',    help: 'Run silently — no prompt.',                 icon: Zap,            color: 'text-artha-muted' },
  { value: 'confirm', label: 'Confirm', help: 'Pause and ask you before each call.',       icon: ShieldQuestion, color: 'text-artha-warn' },
  { value: 'dry_run', label: 'Dry run', help: 'Describe what it would do — never execute.', icon: Eye,           color: 'text-artha-accent' },
  { value: 'forbid',  label: 'Forbid',  help: 'Block the call outright.',                  icon: Ban,            color: 'text-artha-danger' },
];

const TIER_BADGE: Record<Tier, string> = {
  auto: 'text-artha-muted bg-artha-text/5 border-artha-border',
  confirm: 'text-artha-warn bg-artha-warn/10 border-artha-warn/30',
  dry_run: 'text-artha-accent bg-artha-accent/10 border-artha-accent/30',
  forbid: 'text-artha-danger bg-artha-danger/10 border-artha-danger/30',
};

export default function PoliciesPanel() {
  const [policies, setPolicies] = useState<Policy[]>([]);
  const [loading, setLoading] = useState(true);
  // New-rule draft.
  const [pattern, setPattern] = useState('');
  const [tier, setTier] = useState<Tier>('confirm');
  const [scope, setScope] = useState<Scope>('always');

  const reload = () => window.artha.policies.list().then(p => { setPolicies(p as Policy[]); setLoading(false); });
  useEffect(() => { reload(); }, []);

  const add = async () => {
    const p = pattern.trim();
    if (!p) return;
    await window.artha.policies.create({ pattern: p, tier, scope });
    setPattern('');
    reload();
  };

  const changeTier = async (id: string, t: Tier) => {
    await window.artha.policies.update(id, { tier: t });
    reload();
  };

  const remove = async (id: string) => {
    await window.artha.policies.delete(id);
    reload();
  };

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="max-w-3xl mx-auto">
        {/* Header */}
        <div className="flex items-center gap-3 mb-5">
          <ShieldCheck size={22} className="text-artha-accent" />
          <div>
            <h2 className="text-lg font-semibold text-artha-text">Tool Policies</h2>
            <p className="text-sm text-artha-muted">Decide what happens before each function call the agent makes.</p>
          </div>
        </div>

        {/* ── In-app guidance ──────────────────────────────────────────── */}
        <div className="mb-6 rounded-xl border border-artha-accent/30 bg-artha-accent/8 p-4">
          <div className="flex items-center gap-2 mb-2">
            <Info size={14} className="text-artha-accent" />
            <span className="text-sm font-semibold text-artha-text">How tool policies work</span>
          </div>
          <p className="text-xs text-artha-muted leading-relaxed mb-3">
            A rule matches a tool by name. Use an exact name like <code className="text-artha-accent">fs_delete_file</code>,
            a prefix ending in <code className="text-artha-accent">_</code> like <code className="text-artha-accent">browser_</code> (all browser tools),
            or <code className="text-artha-accent">*</code> for every tool. When a call matches, its tier decides what happens:
          </p>
          <div className="grid grid-cols-2 gap-2">
            {TIERS.map(t => {
              const Icon = t.icon;
              return (
                <div key={t.value} className="flex items-start gap-2 px-3 py-2 rounded-lg bg-artha-s2 border border-artha-border">
                  <Icon size={13} className={`${t.color} shrink-0 mt-0.5`} />
                  <div>
                    <p className="text-xs font-medium text-artha-text">{t.label}</p>
                    <p className="text-[11px] text-artha-muted">{t.help}</p>
                  </div>
                </div>
              );
            })}
          </div>
          <p className="text-[11px] text-artha-subtle mt-3">
            Scope <code className="text-artha-accent">outside my folders</code> applies a rule only when the call touches a path
            outside the folders attached to a chat — so you can allow free rein inside a workspace but require confirmation everywhere else.
            Unattended runs (Delegate, scheduled) treat “Confirm” as blocked, since no one is there to approve.
          </p>
        </div>

        {/* ── Add rule ─────────────────────────────────────────────────── */}
        <div className="mb-6 rounded-xl border border-artha-border bg-artha-s2 p-4">
          <p className="text-xs font-semibold text-artha-muted uppercase tracking-wide mb-3">Add a rule</p>
          <div className="flex flex-wrap items-center gap-2">
            <input
              value={pattern}
              onChange={e => setPattern(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') add(); }}
              placeholder="tool name, prefix_ or *"
              className="flex-1 min-w-[180px] bg-artha-bg border border-artha-border rounded-lg px-3 py-2 text-sm font-mono text-artha-text placeholder-artha-subtle focus:outline-none focus:border-artha-accent"
            />
            <select
              value={tier}
              onChange={e => setTier(e.target.value as Tier)}
              className="bg-artha-bg border border-artha-border rounded-lg px-3 py-2 text-sm text-artha-text focus:outline-none focus:border-artha-accent"
            >
              {TIERS.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
            <select
              value={scope}
              onChange={e => setScope(e.target.value as Scope)}
              className="bg-artha-bg border border-artha-border rounded-lg px-3 py-2 text-sm text-artha-text focus:outline-none focus:border-artha-accent"
            >
              <option value="always">Always</option>
              <option value="outside_roots">Outside my folders</option>
            </select>
            <button
              onClick={add}
              disabled={!pattern.trim()}
              className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-artha-accent hover:bg-artha-accent-hover disabled:opacity-40 text-artha-on-accent text-sm font-medium transition-colors"
            >
              <Plus size={14} /> Add
            </button>
          </div>
        </div>

        {/* ── Existing rules ───────────────────────────────────────────── */}
        <h3 className="text-sm font-semibold text-artha-muted mb-3">Active rules</h3>
        {loading ? (
          <p className="text-sm text-artha-muted">Loading…</p>
        ) : policies.length === 0 ? (
          <p className="text-sm text-artha-muted/70">No policies yet — every tool runs automatically. Add a rule above to gate one.</p>
        ) : (
          <div className="space-y-2">
            {policies.map(p => (
              <div key={p.policy_id} className="flex items-center gap-3 px-4 py-3 rounded-xl bg-artha-s2 border border-artha-border">
                <code className="text-xs font-mono text-artha-text shrink-0">{p.pattern}</code>
                <span className={`text-[10px] px-2 py-0.5 rounded border ${TIER_BADGE[p.tier]} shrink-0`}>
                  {TIERS.find(t => t.value === p.tier)?.label}
                </span>
                {p.scope === 'outside_roots' && (
                  <span className="text-[10px] text-artha-muted shrink-0">· outside my folders</span>
                )}
                {p.note && <span className="text-[11px] text-artha-muted truncate flex-1">{p.note}</span>}
                <div className="ml-auto flex items-center gap-2 shrink-0">
                  <select
                    value={p.tier}
                    onChange={e => changeTier(p.policy_id, e.target.value as Tier)}
                    className="bg-artha-bg border border-artha-border rounded-md px-2 py-1 text-xs text-artha-text focus:outline-none focus:border-artha-accent"
                  >
                    {TIERS.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
                  </select>
                  <button
                    onClick={() => remove(p.policy_id)}
                    className="text-artha-muted hover:text-artha-danger transition-colors p-1"
                    title="Delete rule"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
