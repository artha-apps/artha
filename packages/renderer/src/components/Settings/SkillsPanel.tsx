/**
 * SkillsPanel — manage agent Skills (named playbooks).
 *
 * A skill bundles: a description (used to auto-match user intent), instructions
 * (injected into the agent's system prompt when active), and an optional tool
 * allowlist (scopes which tools the agent may call). Skills are invoked by
 * typing "/slug" in chat or matched automatically by the orchestrator.
 *
 * Built-in skills can be edited and disabled but not deleted.
 */
import { useEffect, useMemo, useState } from 'react';
import {
  Sparkles, Plus, Trash2, Pencil, ToggleLeft, ToggleRight,
  RefreshCw, Save, X, Lock, Wrench, Upload, Download,
  Activity, Clock, Zap, Gauge,
} from 'lucide-react';
import { FeatureGuide } from '../ui/FeatureGuide';
import { GUIDES } from './guides';

interface Skill {
  skill_id: string;
  slug: string;
  name: string;
  description: string;
  instructions: string;
  allowed_tools_json: string;
  icon: string;
  is_enabled: number;
  is_builtin: number;
  created_at: number;
  updated_at: number;
}

/** Per-skill usage metrics (mirrors SkillMetric in app/src/skills/metrics.ts). */
interface SkillMetric {
  skillId: string;
  runs: number;
  successes: number;
  errors: number;
  cancelled: number;
  successRate: number;
  avgToolCalls: number;
  avgDurationMs: number;
  lastRunAt: number | null;
  viaExplicit: number;
  viaAuto: number;
  viaInvoke: number;
  estTimeSavedMs: number;
}

type SortKey = 'usage' | 'name';

/** Compact human duration from milliseconds: "820ms", "4.2s", "3m 5s". */
function fmtDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rem = Math.round(s % 60);
  return `${m}m${rem ? ` ${rem}s` : ''}`;
}

/** Larger, rounded duration for the "time saved" headline: "2h 5m", "12m". */
function fmtSavedDuration(ms: number): string {
  if (ms <= 0) return '0m';
  const totalMin = Math.round(ms / 60000);
  if (totalMin < 60) return `${totalMin}m`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return `${h}h${m ? ` ${m}m` : ''}`;
}

/** Relative "last used" label from a unix-epoch (seconds) timestamp. */
function fmtRelative(epochSec: number | null): string {
  if (!epochSec) return 'never';
  const diff = Date.now() / 1000 - epochSec;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

/** Editable form state — allowed tools are edited as a comma list, parsed on save. */
interface Draft {
  skill_id?: string;
  slug: string;
  name: string;
  icon: string;
  description: string;
  instructions: string;
  allowedToolsText: string;
  is_enabled: boolean;
  is_builtin: boolean;
}

// Chip hints shown in the editor to help authors remember tool prefix syntax.
const BUILTIN_TOOL_HINTS = [
  'fs_ (all filesystem)', 'web_ (all web)', 'browser_ (all browser)',
  'web_search', 'web_fetch', 'fs_list_directory', 'fs_move_file', 'fs_read_file',
];

/** Fresh form state for the "New Skill" flow. */
const EMPTY_DRAFT: Draft = {
  slug: '', name: '', icon: '✨', description: '', instructions: '',
  allowedToolsText: '', is_enabled: true, is_builtin: false,
};

/** Split a comma-separated tool allowlist string into a trimmed string array. */
function parseTools(text: string): string[] {
  return text.split(',').map(s => s.trim()).filter(Boolean);
}

/** Convert a Skill DB row into the editable Draft shape (JSON tools → comma string). */
function toDraft(skill: Skill): Draft {
  let tools: string[] = [];
  try { const p = JSON.parse(skill.allowed_tools_json); if (Array.isArray(p)) tools = p; } catch { /* ok */ }
  return {
    skill_id: skill.skill_id,
    slug: skill.slug,
    name: skill.name,
    icon: skill.icon,
    description: skill.description,
    instructions: skill.instructions,
    allowedToolsText: tools.join(', '),
    is_enabled: !!skill.is_enabled,
    is_builtin: !!skill.is_builtin,
  };
}

/** Skills list + editor panel. Renders the editor in-place when `editing` is set,
 *  otherwise shows the full list view. */
export default function SkillsPanel() {
  // ── State ──────────────────────────────────────────────────────────────────
  const [skills, setSkills] = useState<Skill[]>([]);
  const [metrics, setMetrics] = useState<SkillMetric[]>([]);
  const [loading, setLoading] = useState(true);
  // `editing` non-null means the editor view is shown; null = list view.
  const [editing, setEditing] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [sortBy, setSortBy] = useState<SortKey>('usage');

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      // Metrics are best-effort decoration — never let a metrics failure block
      // the skill list, so each is awaited independently.
      const [list, mx] = await Promise.all([
        window.artha.skills.list() as Promise<Skill[]>,
        window.artha.skills.metrics().catch(() => [] as SkillMetric[]),
      ]);
      setSkills(list);
      setMetrics(mx);
    } catch (err) {
      // Surface backend failures (e.g. the SQLite engine failed to load) rather
      // than silently rendering the empty-state, which looks like "no skills".
      setError(err instanceof Error ? err.message : 'Could not load skills');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  // Index metrics by skill id for O(1) lookup while rendering cards.
  const metricsById = useMemo(() => {
    const m = new Map<string, SkillMetric>();
    for (const x of metrics) m.set(x.skillId, x);
    return m;
  }, [metrics]);

  // Roll-up across all skills for the summary strip.
  const totals = useMemo(() => {
    const runs = metrics.reduce((a, m) => a + m.runs, 0);
    const successes = metrics.reduce((a, m) => a + m.successes, 0);
    const savedMs = metrics.reduce((a, m) => a + m.estTimeSavedMs, 0);
    return {
      runs,
      successRate: runs > 0 ? successes / runs : 0,
      savedMs,
    };
  }, [metrics]);

  // List order: most-used first (then A–Z), or pure alphabetical. Built-ins keep
  // no special pinning here so a heavily-used custom skill can rise to the top.
  const orderedSkills = useMemo(() => {
    const copy = [...skills];
    if (sortBy === 'name') {
      copy.sort((a, b) => a.name.localeCompare(b.name));
    } else {
      copy.sort((a, b) => {
        const ra = metricsById.get(a.skill_id)?.runs ?? 0;
        const rb = metricsById.get(b.skill_id)?.runs ?? 0;
        // Most-used first; ties keep the registry's default (built-ins pinned,
        // then A–Z) so first-launch order matches the rest of the app.
        return rb - ra || (b.is_builtin - a.is_builtin) || a.name.localeCompare(b.name);
      });
    }
    return copy;
  }, [skills, sortBy, metricsById]);

  const toggle = async (s: Skill) => {
    const next = !s.is_enabled;
    await window.artha.skills.toggle(s.skill_id, next);
    setSkills(prev => prev.map(x => x.skill_id === s.skill_id ? { ...x, is_enabled: next ? 1 : 0 } : x));
  };

  const remove = async (s: Skill) => {
    if (s.is_builtin) return;
    await window.artha.skills.remove(s.skill_id);
    setSkills(prev => prev.filter(x => x.skill_id !== s.skill_id));
    // Drop its metrics too so the summary totals stay accurate without a reload
    // (the backend also deletes the skill's skill_runs rows on remove).
    setMetrics(prev => prev.filter(m => m.skillId !== s.skill_id));
  };

  const exportSkill = async (s: Skill) => {
    await window.artha.skills.export(s.skill_id);
  };

  const importSkill = async () => {
    setError('');
    try {
      const res = await window.artha.skills.import();
      if (res) await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Import failed');
    }
  };

  const save = async () => {
    if (!editing) return;
    if (!editing.name.trim()) { setError('Name is required'); return; }
    if (!editing.slug.trim()) { setError('Slug is required'); return; }
    setSaving(true);
    setError('');
    try {
      const payload = {
        slug: editing.slug,
        name: editing.name,
        icon: editing.icon || '✨',
        description: editing.description,
        instructions: editing.instructions,
        allowedTools: parseTools(editing.allowedToolsText),
        isEnabled: editing.is_enabled,
      };
      if (editing.skill_id) {
        await window.artha.skills.update(editing.skill_id, payload);
      } else {
        await window.artha.skills.create(payload);
      }
      setEditing(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save skill');
    } finally {
      setSaving(false);
    }
  };

  // ── Editor view ───────────────────────────────────────────────────────────
  if (editing) {
    return (
      <div className="flex-1 overflow-y-auto px-8 py-8 max-w-3xl mx-auto w-full">
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-artha-accent/20 flex items-center justify-center">
              <Sparkles size={16} className="text-artha-accent" />
            </div>
            <div>
              <h1 className="text-base font-semibold text-artha-text">
                {editing.skill_id ? 'Edit Skill' : 'New Skill'}
              </h1>
              <p className="text-xs text-artha-muted">
                {editing.is_builtin ? 'Built-in skill — editable, slug is locked' : 'A reusable playbook for the agent'}
              </p>
            </div>
          </div>
          <button onClick={() => { setEditing(null); setError(''); }}
            className="p-2 rounded-lg text-artha-muted hover:text-artha-text hover:bg-artha-text/5 transition-colors">
            <X size={16} />
          </button>
        </div>

        <div className="space-y-5">
          {/* Icon + Name + Slug */}
          <div className="flex gap-3">
            <div className="w-20">
              <label className="block text-xs font-medium text-artha-muted mb-1">Icon</label>
              <input
                value={editing.icon}
                onChange={e => setEditing({ ...editing, icon: e.target.value.slice(0, 2) })}
                placeholder="✨"
                className="w-full text-center bg-artha-s2 border border-artha-border rounded-lg px-3 py-2 text-lg focus:border-artha-accent/50 focus:outline-none"
              />
            </div>
            <div className="flex-1">
              <label className="block text-xs font-medium text-artha-muted mb-1">Name</label>
              <input
                value={editing.name}
                onChange={e => setEditing({
                  ...editing,
                  name: e.target.value,
                  // Auto-derive slug from name only for brand-new (non-builtin) skills;
                  // existing slugs must not change silently or "/" links in chat break.
                  slug: !editing.skill_id ? e.target.value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') : editing.slug,
                })}
                placeholder="Weekly Report"
                className="w-full bg-artha-s2 border border-artha-border rounded-lg px-3 py-2 text-sm text-artha-text placeholder-artha-muted focus:border-artha-accent/50 focus:outline-none"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-artha-muted mb-1">
              Slug {editing.is_builtin && <span className="text-artha-muted/60">(locked)</span>}
            </label>
            <div className="flex items-center gap-2">
              <span className="text-artha-muted text-sm font-mono">/</span>
              <input
                value={editing.slug}
                disabled={editing.is_builtin}
                onChange={e => setEditing({ ...editing, slug: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '') })}
                placeholder="weekly-report"
                className="flex-1 bg-artha-s2 border border-artha-border rounded-lg px-3 py-2 text-sm text-artha-text placeholder-artha-muted focus:border-artha-accent/50 focus:outline-none font-mono disabled:opacity-50"
              />
            </div>
            <p className="text-xs text-artha-muted mt-1">
              Type <code className="bg-artha-s2 border border-artha-border px-1 py-0.5 rounded font-mono">/{editing.slug || 'slug'}</code> in chat to invoke this skill directly.
            </p>
          </div>

          <div>
            <label className="block text-xs font-medium text-artha-muted mb-1">Description</label>
            <textarea
              value={editing.description}
              onChange={e => setEditing({ ...editing, description: e.target.value })}
              placeholder="When should the agent use this skill? This is matched against the user's request."
              rows={2}
              className="w-full bg-artha-s2 border border-artha-border rounded-lg px-3 py-2 text-sm text-artha-text placeholder-artha-muted focus:border-artha-accent/50 focus:outline-none resize-none leading-relaxed"
            />
            <p className="text-xs text-artha-muted mt-1">Used for automatic matching — describe the trigger plainly.</p>
          </div>

          <div>
            <label className="block text-xs font-medium text-artha-muted mb-1">Instructions (playbook)</label>
            <textarea
              value={editing.instructions}
              onChange={e => setEditing({ ...editing, instructions: e.target.value })}
              placeholder={'Step-by-step guidance the agent follows when this skill is active.\n1. …\n2. …'}
              rows={9}
              className="w-full bg-artha-s2 border border-artha-border rounded-lg px-3 py-2 text-sm text-artha-text placeholder-artha-muted focus:border-artha-accent/50 focus:outline-none resize-y leading-relaxed font-mono"
            />
            <p className="text-xs text-artha-muted mt-1">Injected into the agent's system prompt while the skill runs.</p>
          </div>

          <div>
            <label className="block text-xs font-medium text-artha-muted mb-1 flex items-center gap-1.5">
              <Wrench size={11} /> Allowed tools <span className="text-artha-muted/60">(optional)</span>
            </label>
            <input
              value={editing.allowedToolsText}
              onChange={e => setEditing({ ...editing, allowedToolsText: e.target.value })}
              placeholder="fs_, web_search   (leave empty to allow all tools)"
              className="w-full bg-artha-s2 border border-artha-border rounded-lg px-3 py-2 text-sm text-artha-text placeholder-artha-muted focus:border-artha-accent/50 focus:outline-none font-mono"
            />
            <p className="text-xs text-artha-muted mt-1">
              Comma-separated. A trailing <code className="bg-artha-s2 border border-artha-border px-1 rounded font-mono">_</code> is a prefix (e.g. <code className="bg-artha-s2 border border-artha-border px-1 rounded font-mono">fs_</code> = all filesystem tools). Empty = all tools.
            </p>
            <div className="flex flex-wrap gap-1.5 mt-2">
              {BUILTIN_TOOL_HINTS.map(h => {
                const tool = h.split(' ')[0];
                return (
                  <button key={h} type="button"
                    onClick={() => {
                      const tools = parseTools(editing.allowedToolsText);
                      if (!tools.includes(tool)) {
                        setEditing({ ...editing, allowedToolsText: [...tools, tool].join(', ') });
                      }
                    }}
                    className="text-[10px] px-2 py-0.5 rounded-full bg-artha-s2 border border-artha-border text-artha-muted hover:text-artha-text hover:border-artha-accent/40 transition-colors font-mono">
                    + {h}
                  </button>
                );
              })}
            </div>
          </div>

          {error && (
            <p className="text-xs text-artha-danger flex items-center gap-1"><X size={11} /> {error}</p>
          )}

          <div className="flex gap-2 pt-2">
            <button onClick={save} disabled={saving}
              className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-artha-accent hover:bg-artha-accent/80 disabled:opacity-40 text-sm font-medium transition-colors">
              {saving ? <RefreshCw size={13} className="animate-spin" /> : <Save size={13} />}
              {editing.skill_id ? 'Save changes' : 'Create skill'}
            </button>
            <button onClick={() => { setEditing(null); setError(''); }}
              className="px-4 py-2 rounded-lg text-sm text-artha-muted hover:text-artha-text hover:bg-artha-text/5 transition-colors">
              Cancel
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ── List view ───────────────────────────────────────────────────────────
  return (
    <div className="flex-1 overflow-y-auto px-8 py-8 max-w-3xl mx-auto w-full">
      <FeatureGuide {...GUIDES.skills} />
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-artha-accent/20 flex items-center justify-center">
            <Sparkles size={16} className="text-artha-accent" />
          </div>
          <div>
            <h1 className="text-base font-semibold text-artha-text">Skills</h1>
            <p className="text-xs text-artha-muted">Reusable playbooks the agent loads on intent or via <code className="font-mono">/slug</code></p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={load} disabled={loading}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-artha-border text-artha-muted hover:text-artha-text hover:bg-artha-text/5 text-xs transition-colors disabled:opacity-40">
            <RefreshCw size={12} className={loading ? 'animate-spin' : ''} /> Refresh
          </button>
          <button onClick={importSkill}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-artha-border text-artha-muted hover:text-artha-text hover:bg-artha-text/5 text-xs transition-colors">
            <Upload size={12} /> Import
          </button>
          <button onClick={() => { setError(''); setEditing({ ...EMPTY_DRAFT }); }}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-artha-accent hover:bg-artha-accent/80 text-xs font-medium transition-colors">
            <Plus size={13} /> New Skill
          </button>
        </div>
      </div>

      {/* Dashboard summary — only meaningful once skills have actually run. */}
      {!loading && totals.runs > 0 && (
        <div className="grid grid-cols-3 gap-2 mb-4">
          <div className="rounded-xl border border-artha-border bg-artha-s2 px-4 py-3">
            <div className="flex items-center gap-1.5 text-[11px] text-artha-muted mb-1">
              <Activity size={12} /> Total runs
            </div>
            <div className="text-lg font-semibold text-artha-text">{totals.runs}</div>
          </div>
          <div className="rounded-xl border border-artha-border bg-artha-s2 px-4 py-3">
            <div className="flex items-center gap-1.5 text-[11px] text-artha-muted mb-1">
              <Gauge size={12} /> Success rate
            </div>
            <div className="text-lg font-semibold text-artha-text">{Math.round(totals.successRate * 100)}%</div>
          </div>
          <div className="rounded-xl border border-artha-border bg-artha-s2 px-4 py-3">
            <div className="flex items-center gap-1.5 text-[11px] text-artha-muted mb-1">
              <Clock size={12} /> Est. time saved
            </div>
            <div className="text-lg font-semibold text-artha-accent" title="Rough estimate: successful runs × assumed manual effort per task.">
              {fmtSavedDuration(totals.savedMs)}
            </div>
          </div>
        </div>
      )}

      {/* Sort control — only shown when there's usage data worth ordering by. */}
      {!loading && skills.length > 0 && totals.runs > 0 && (
        <div className="flex items-center justify-end gap-1.5 mb-2 text-[11px] text-artha-muted">
          <span>Sort:</span>
          <button onClick={() => setSortBy('usage')}
            className={`px-2 py-0.5 rounded-full border transition-colors ${
              sortBy === 'usage' ? 'border-artha-accent/50 text-artha-accent bg-artha-accent/10' : 'border-artha-border hover:text-artha-text'
            }`}>Most used</button>
          <button onClick={() => setSortBy('name')}
            className={`px-2 py-0.5 rounded-full border transition-colors ${
              sortBy === 'name' ? 'border-artha-accent/50 text-artha-accent bg-artha-accent/10' : 'border-artha-border hover:text-artha-text'
            }`}>A–Z</button>
        </div>
      )}

      {error && (
        <p className="text-xs text-artha-danger flex items-center gap-1 mb-3"><X size={11} /> {error}</p>
      )}

      {loading ? (
        <div className="space-y-2">
          {[1, 2, 3].map(i => <div key={i} className="h-20 bg-artha-s2 border border-artha-border rounded-xl animate-pulse" />)}
        </div>
      ) : skills.length === 0 ? (
        <div className="text-center py-16 text-artha-muted">
          <Sparkles size={32} className="mx-auto mb-3 opacity-30" />
          <p className="text-sm font-medium text-artha-text mb-1">No skills yet</p>
          <p className="text-xs">Create one to give the agent a reusable playbook.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {orderedSkills.map(s => {
            let tools: string[] = [];
            try { const p = JSON.parse(s.allowed_tools_json); if (Array.isArray(p)) tools = p; } catch { /* ok */ }
            const m = metricsById.get(s.skill_id);
            return (
              <div key={s.skill_id}
                className={`rounded-xl border px-4 py-3 transition-all ${
                  s.is_enabled ? 'border-artha-border bg-artha-s2' : 'border-artha-border/50 bg-artha-s2/40 opacity-60'
                }`}>
                <div className="flex items-start gap-3">
                  <div className="w-9 h-9 rounded-lg bg-artha-surface border border-artha-border flex items-center justify-center shrink-0 text-lg">
                    {s.icon}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-0.5">
                      <span className="text-sm font-medium text-artha-text">{s.name}</span>
                      <code className="text-[10px] text-artha-accent bg-artha-accent/10 px-1.5 py-0.5 rounded font-mono">/{s.slug}</code>
                      {!!s.is_builtin && (
                        <span className="flex items-center gap-1 text-[10px] text-artha-muted bg-artha-text/5 px-1.5 py-0.5 rounded-full">
                          <Lock size={9} /> built-in
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-artha-muted leading-relaxed line-clamp-2">{s.description}</p>
                    {tools.length > 0 && (
                      <div className="flex flex-wrap gap-1 mt-1.5">
                        {tools.map(t => (
                          <code key={t} className="text-[10px] text-artha-muted/80 bg-artha-surface border border-artha-border px-1.5 py-0.5 rounded font-mono">{t}</code>
                        ))}
                      </div>
                    )}
                    {/* Usage metrics — a dense stat row when run, a quiet badge when not. */}
                    {m && m.runs > 0 ? (
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-2 text-[10px] text-artha-muted">
                        <span className="flex items-center gap-1"><Activity size={10} /> {m.runs} run{m.runs === 1 ? '' : 's'}</span>
                        <span
                          className={`flex items-center gap-1 ${m.successRate < 0.6 ? 'text-artha-danger' : m.successRate >= 0.9 ? 'text-artha-accent' : ''}`}
                          title={`${m.successes} ok · ${m.errors} error${m.cancelled ? ` · ${m.cancelled} cancelled` : ''}`}
                        >
                          <Gauge size={10} /> {Math.round(m.successRate * 100)}%
                        </span>
                        <span className="flex items-center gap-1" title="Average tool calls per run"><Wrench size={10} /> {m.avgToolCalls.toFixed(1)} tools</span>
                        <span className="flex items-center gap-1" title="Average run duration"><Clock size={10} /> {fmtDuration(m.avgDurationMs)}</span>
                        <span className="flex items-center gap-1 text-artha-accent" title="Rough estimate of manual effort saved across successful runs"><Zap size={10} /> ~{fmtSavedDuration(m.estTimeSavedMs)} saved</span>
                        <span className="opacity-70">· {fmtRelative(m.lastRunAt)}</span>
                      </div>
                    ) : (
                      <div className="mt-2 text-[10px] text-artha-muted/60 flex items-center gap-1">
                        <Activity size={10} /> Never used
                      </div>
                    )}
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    <button onClick={() => toggle(s)} title={s.is_enabled ? 'Disable' : 'Enable'}
                      className="text-artha-muted hover:text-artha-text transition-colors">
                      {s.is_enabled ? <ToggleRight size={20} className="text-artha-accent" /> : <ToggleLeft size={20} />}
                    </button>
                    <button onClick={() => exportSkill(s)} title="Export"
                      className="p-1.5 text-artha-muted hover:text-artha-text hover:bg-artha-text/5 rounded-lg transition-colors">
                      <Download size={13} />
                    </button>
                    <button onClick={() => { setError(''); setEditing(toDraft(s)); }} title="Edit"
                      className="p-1.5 text-artha-muted hover:text-artha-text hover:bg-artha-text/5 rounded-lg transition-colors">
                      <Pencil size={13} />
                    </button>
                    {!s.is_builtin && (
                      <button onClick={() => remove(s)} title="Delete"
                        className="p-1.5 text-artha-muted hover:text-artha-danger hover:bg-artha-text/5 rounded-lg transition-colors">
                        <Trash2 size={13} />
                      </button>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <p className="text-xs text-artha-muted mt-6 pt-4 border-t border-artha-border">
        Skills are matched automatically by their description, or invoked directly by typing <code className="bg-artha-s2 border border-artha-border px-1 py-0.5 rounded font-mono">/slug</code> at the start of a chat message.
      </p>
    </div>
  );
}
