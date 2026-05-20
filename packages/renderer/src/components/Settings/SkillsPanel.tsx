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
import { useEffect, useState } from 'react';
import {
  Sparkles, Plus, Trash2, Pencil, ToggleLeft, ToggleRight,
  RefreshCw, Save, X, Lock, Wrench, Upload, Download,
} from 'lucide-react';

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

const BUILTIN_TOOL_HINTS = [
  'fs_ (all filesystem)', 'web_ (all web)', 'browser_ (all browser)',
  'web_search', 'web_fetch', 'fs_list_directory', 'fs_move_file', 'fs_read_file',
];

const EMPTY_DRAFT: Draft = {
  slug: '', name: '', icon: '✨', description: '', instructions: '',
  allowedToolsText: '', is_enabled: true, is_builtin: false,
};

function parseTools(text: string): string[] {
  return text.split(',').map(s => s.trim()).filter(Boolean);
}

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

export default function SkillsPanel() {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const load = async () => {
    setLoading(true);
    try {
      setSkills(await window.artha.skills.list() as Skill[]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const toggle = async (s: Skill) => {
    const next = !s.is_enabled;
    await window.artha.skills.toggle(s.skill_id, next);
    setSkills(prev => prev.map(x => x.skill_id === s.skill_id ? { ...x, is_enabled: next ? 1 : 0 } : x));
  };

  const remove = async (s: Skill) => {
    if (s.is_builtin) return;
    await window.artha.skills.remove(s.skill_id);
    setSkills(prev => prev.filter(x => x.skill_id !== s.skill_id));
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
              <h1 className="text-base font-semibold text-white">
                {editing.skill_id ? 'Edit Skill' : 'New Skill'}
              </h1>
              <p className="text-xs text-artha-muted">
                {editing.is_builtin ? 'Built-in skill — editable, slug is locked' : 'A reusable playbook for the agent'}
              </p>
            </div>
          </div>
          <button onClick={() => { setEditing(null); setError(''); }}
            className="p-2 rounded-lg text-artha-muted hover:text-white hover:bg-white/5 transition-colors">
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
                  // Auto-derive slug from name for new, non-builtin skills only.
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
                    className="text-[10px] px-2 py-0.5 rounded-full bg-artha-s2 border border-artha-border text-artha-muted hover:text-white hover:border-artha-accent/40 transition-colors font-mono">
                    + {h}
                  </button>
                );
              })}
            </div>
          </div>

          {error && (
            <p className="text-xs text-red-400 flex items-center gap-1"><X size={11} /> {error}</p>
          )}

          <div className="flex gap-2 pt-2">
            <button onClick={save} disabled={saving}
              className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-artha-accent hover:bg-artha-accent/80 disabled:opacity-40 text-sm font-medium transition-colors">
              {saving ? <RefreshCw size={13} className="animate-spin" /> : <Save size={13} />}
              {editing.skill_id ? 'Save changes' : 'Create skill'}
            </button>
            <button onClick={() => { setEditing(null); setError(''); }}
              className="px-4 py-2 rounded-lg text-sm text-artha-muted hover:text-white hover:bg-white/5 transition-colors">
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
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-artha-accent/20 flex items-center justify-center">
            <Sparkles size={16} className="text-artha-accent" />
          </div>
          <div>
            <h1 className="text-base font-semibold text-white">Skills</h1>
            <p className="text-xs text-artha-muted">Reusable playbooks the agent loads on intent or via <code className="font-mono">/slug</code></p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={load} disabled={loading}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-artha-border text-artha-muted hover:text-white hover:bg-white/5 text-xs transition-colors disabled:opacity-40">
            <RefreshCw size={12} className={loading ? 'animate-spin' : ''} /> Refresh
          </button>
          <button onClick={importSkill}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-artha-border text-artha-muted hover:text-white hover:bg-white/5 text-xs transition-colors">
            <Upload size={12} /> Import
          </button>
          <button onClick={() => { setError(''); setEditing({ ...EMPTY_DRAFT }); }}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-artha-accent hover:bg-artha-accent/80 text-xs font-medium transition-colors">
            <Plus size={13} /> New Skill
          </button>
        </div>
      </div>

      {error && (
        <p className="text-xs text-red-400 flex items-center gap-1 mb-3"><X size={11} /> {error}</p>
      )}

      {loading ? (
        <div className="space-y-2">
          {[1, 2, 3].map(i => <div key={i} className="h-20 bg-artha-s2 border border-artha-border rounded-xl animate-pulse" />)}
        </div>
      ) : skills.length === 0 ? (
        <div className="text-center py-16 text-artha-muted">
          <Sparkles size={32} className="mx-auto mb-3 opacity-30" />
          <p className="text-sm font-medium text-white mb-1">No skills yet</p>
          <p className="text-xs">Create one to give the agent a reusable playbook.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {skills.map(s => {
            let tools: string[] = [];
            try { const p = JSON.parse(s.allowed_tools_json); if (Array.isArray(p)) tools = p; } catch { /* ok */ }
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
                      <span className="text-sm font-medium text-white">{s.name}</span>
                      <code className="text-[10px] text-artha-accent bg-artha-accent/10 px-1.5 py-0.5 rounded font-mono">/{s.slug}</code>
                      {!!s.is_builtin && (
                        <span className="flex items-center gap-1 text-[10px] text-artha-muted bg-white/5 px-1.5 py-0.5 rounded-full">
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
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    <button onClick={() => toggle(s)} title={s.is_enabled ? 'Disable' : 'Enable'}
                      className="text-artha-muted hover:text-white transition-colors">
                      {s.is_enabled ? <ToggleRight size={20} className="text-artha-accent" /> : <ToggleLeft size={20} />}
                    </button>
                    <button onClick={() => exportSkill(s)} title="Export"
                      className="p-1.5 text-artha-muted hover:text-white hover:bg-white/5 rounded-lg transition-colors">
                      <Download size={13} />
                    </button>
                    <button onClick={() => { setError(''); setEditing(toDraft(s)); }} title="Edit"
                      className="p-1.5 text-artha-muted hover:text-white hover:bg-white/5 rounded-lg transition-colors">
                      <Pencil size={13} />
                    </button>
                    {!s.is_builtin && (
                      <button onClick={() => remove(s)} title="Delete"
                        className="p-1.5 text-artha-muted hover:text-red-400 hover:bg-white/5 rounded-lg transition-colors">
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
