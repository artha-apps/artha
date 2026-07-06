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
  Activity, Clock, Zap, Gauge, ChevronDown, ChevronRight,
  Cpu, AlertTriangle, ShieldCheck, RotateCw, Pin, TrendingDown, Hourglass,
} from 'lucide-react';
import { FeatureGuide } from '../ui/FeatureGuide';
import { GUIDES } from './guides';
import { useChatStore } from '../../stores/chat';
import { createChat } from '../../lib/newChat';

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

/** Health verdict (mirrors SkillHealth in app/src/skills/metrics.ts). */
interface SkillHealth {
  status: 'healthy' | 'degraded' | 'slow' | 'unknown';
  reason: string;
  recentSuccessRate: number;
  priorSuccessRate: number;
  recentAvgDurationMs: number;
  priorAvgDurationMs: number;
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
  health: SkillHealth;
}

/** Insight DTOs (mirror the same names in app/src/skills/metrics.ts). */
interface SkillModelStat { model: string; runs: number; successes: number; successRate: number; avgDurationMs: number; }
interface SkillModelStats { models: SkillModelStat[]; recommended: string | null; currentPin: string | null; }
interface SkillToolStat { tool: string; calls: number; errors: number; blocked: number; allowed: boolean; }
interface SkillToolUsage { tools: SkillToolStat[]; grantedButUnused: string[]; expandHints: string[]; allowlistEmpty: boolean; }
interface SkillFailure { runId: string | null; sessionId: string | null; goal: string; status: string; matchedVia: string; toolErrors: number; durationMs: number; createdAt: number; }

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

/** Small health pill — only rendered for problem states (degraded / slow); a
 *  healthy or not-yet-judged skill shows nothing so the list stays calm. */
function HealthBadge({ health }: { health: SkillHealth }) {
  if (health.status === 'healthy' || health.status === 'unknown') return null;
  const degraded = health.status === 'degraded';
  return (
    <span
      title={health.reason}
      className={`flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full border ${
        degraded
          ? 'text-artha-danger border-artha-danger/40 bg-artha-danger/10'
          : 'text-artha-warn border-artha-warn/40 bg-artha-warn/10'
      }`}
    >
      {degraded ? <TrendingDown size={9} /> : <Hourglass size={9} />}
      {degraded ? 'Degraded' : 'Slower'}
    </span>
  );
}

/** Expandable per-skill insights: model breakdown + pin (model dim.), tool
 *  usage + least-privilege tuning (tool dim.), and recent failures + re-run
 *  (lineage dim.). Data is fetched lazily on first expand. */
function SkillInsights({
  skill, onRerun, onPinChanged,
}: {
  skill: Skill;
  onRerun: (slug: string, goal: string) => void;
  onPinChanged: () => void;
}) {
  const [models, setModels] = useState<SkillModelStats | null>(null);
  const [tools, setTools] = useState<SkillToolUsage | null>(null);
  const [failures, setFailures] = useState<SkillFailure[] | null>(null);
  const [busy, setBusy] = useState(true);
  const [pinning, setPinning] = useState(false);

  const load = async () => {
    setBusy(true);
    const [m, t, f] = await Promise.all([
      window.artha.skills.modelStats(skill.skill_id).catch(() => null),
      window.artha.skills.toolUsage(skill.skill_id).catch(() => null),
      window.artha.skills.failures(skill.skill_id, 8).catch(() => [] as SkillFailure[]),
    ]);
    setModels(m); setTools(t); setFailures(f);
    setBusy(false);
  };
  // load() depends only on the skill id; refetch when the drawer's skill changes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [skill.skill_id]);

  const pin = async (model: string | null) => {
    setPinning(true);
    await window.artha.skills.pinModel(skill.skill_id, model).catch(() => {});
    await load();
    onPinChanged();
    setPinning(false);
  };

  if (busy && !models && !tools && !failures) {
    return <div className="mt-3 h-16 rounded-lg bg-artha-surface/60 border border-artha-border animate-pulse" />;
  }

  return (
    <div className="mt-3 space-y-3 border-t border-artha-border pt-3">
      {/* ── Models ─────────────────────────────────────────────────────────── */}
      <section>
        <div className="flex items-center gap-1.5 text-[11px] font-medium text-artha-muted mb-1.5">
          <Cpu size={12} /> Model performance
        </div>
        {!models || models.models.length === 0 ? (
          <p className="text-[11px] text-artha-muted/70">No model history yet.</p>
        ) : (
          <div className="space-y-1">
            {models.models.map(m => {
              const isPin = models.currentPin === m.model;
              const isRec = models.recommended === m.model;
              return (
                <div key={m.model} className="flex items-center gap-2 text-[11px]">
                  <code className="font-mono text-artha-text/90 truncate max-w-[40%]">{m.model}</code>
                  <span className={m.successRate >= 0.9 ? 'text-artha-accent' : m.successRate < 0.6 ? 'text-artha-danger' : 'text-artha-muted'}>
                    {Math.round(m.successRate * 100)}%
                  </span>
                  <span className="text-artha-muted/70">{m.runs} run{m.runs === 1 ? '' : 's'}</span>
                  <span className="text-artha-muted/70">{fmtDuration(m.avgDurationMs)}</span>
                  {isRec && <span className="text-[9px] px-1 rounded bg-artha-accent/15 text-artha-accent border border-artha-accent/30">best</span>}
                  {isPin ? (
                    <button onClick={() => pin(null)} disabled={pinning}
                      className="ml-auto flex items-center gap-1 text-[9px] px-1.5 py-0.5 rounded-full bg-artha-accent/15 text-artha-accent border border-artha-accent/40">
                      <Pin size={8} /> pinned · unpin
                    </button>
                  ) : (
                    <button onClick={() => pin(m.model)} disabled={pinning}
                      className="ml-auto text-[9px] px-1.5 py-0.5 rounded-full border border-artha-border text-artha-muted hover:text-artha-text hover:border-artha-accent/40">
                      pin
                    </button>
                  )}
                </div>
              );
            })}
            {models.recommended && models.currentPin !== models.recommended && (
              <button onClick={() => pin(models.recommended)} disabled={pinning}
                className="mt-1 text-[10px] text-artha-accent hover:underline">
                Pin best model ({models.recommended}) →
              </button>
            )}
          </div>
        )}
      </section>

      {/* ── Tools (least-privilege) ────────────────────────────────────────── */}
      <section>
        <div className="flex items-center gap-1.5 text-[11px] font-medium text-artha-muted mb-1.5">
          <ShieldCheck size={12} /> Tool usage
        </div>
        {!tools || tools.tools.length === 0 ? (
          <p className="text-[11px] text-artha-muted/70">No tool calls recorded yet.</p>
        ) : (
          <div className="flex flex-wrap gap-1">
            {tools.tools.map(t => (
              <code key={t.tool}
                title={`${t.calls} call(s)${t.errors ? `, ${t.errors} error(s)` : ''}${t.blocked ? `, ${t.blocked} blocked` : ''}${t.allowed ? '' : ' — not in allowlist'}`}
                className={`text-[10px] px-1.5 py-0.5 rounded border font-mono ${
                  t.allowed
                    ? 'text-artha-muted/80 bg-artha-surface border-artha-border'
                    : 'text-artha-warn bg-artha-warn/10 border-artha-warn/40'
                }`}>
                {t.tool} · {t.calls}{t.errors ? ` ⚠${t.errors}` : ''}
              </code>
            ))}
          </div>
        )}
        {/* Only suggest tightening once there's real usage to compare against —
            otherwise a skill that simply hasn't run looks like it over-grants. */}
        {tools && tools.tools.length > 0 && tools.grantedButUnused.length > 0 && (
          <p className="mt-1.5 text-[10px] text-artha-muted">
            <AlertTriangle size={9} className="inline mr-1 -mt-0.5" />
            Granted but never used: <span className="font-mono">{tools.grantedButUnused.join(', ')}</span> — consider tightening the allowlist.
          </p>
        )}
        {tools && tools.expandHints.length > 0 && (
          <p className="mt-1 text-[10px] text-artha-warn">
            <AlertTriangle size={9} className="inline mr-1 -mt-0.5" />
            Tried but not allowed: <span className="font-mono">{tools.expandHints.join(', ')}</span> — add to the allowlist if intended.
          </p>
        )}
      </section>

      {/* ── Failures + re-run ──────────────────────────────────────────────── */}
      <section>
        <div className="flex items-center gap-1.5 text-[11px] font-medium text-artha-muted mb-1.5">
          <AlertTriangle size={12} /> Recent failures
        </div>
        {!failures || failures.length === 0 ? (
          <p className="text-[11px] text-artha-muted/70">No failed runs — nice.</p>
        ) : (
          <div className="space-y-1">
            {failures.map((f, i) => (
              <div key={f.runId ?? i} className="flex items-center gap-2 text-[11px]">
                <span className={`text-[9px] px-1 rounded ${f.status === 'cancelled' ? 'text-artha-muted bg-artha-text/5' : 'text-artha-danger bg-artha-danger/10'}`}>
                  {f.status}
                </span>
                <span className="text-artha-text/80 truncate flex-1" title={f.goal}>{f.goal || '(no goal)'}</span>
                <span className="text-artha-muted/60 shrink-0">{fmtRelative(f.createdAt)}</span>
                <button onClick={() => onRerun(skill.slug, f.goal)}
                  title="Re-run this task in a new chat"
                  className="shrink-0 flex items-center gap-1 text-[9px] px-1.5 py-0.5 rounded-full border border-artha-border text-artha-muted hover:text-artha-accent hover:border-artha-accent/40">
                  <RotateCw size={8} /> re-run
                </button>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

/** A curated starter template — one click creates a real (editable) skill.
 *  These are the "vertical packs" seed: proven playbooks for the professional
 *  niches Artha targets (legal, finance, operations), written against the
 *  agent's actual tool names so the allowlists work out of the box. */
interface SkillTemplate {
  slug: string;
  name: string;
  icon: string;
  vertical: 'Legal' | 'Finance' | 'Operations';
  description: string;
  instructions: string;
  allowedTools: string[];
}

const SKILL_TEMPLATES: SkillTemplate[] = [
  {
    slug: 'contract-review',
    name: 'Contract Reviewer',
    icon: '⚖️',
    vertical: 'Legal',
    description: 'Read a contract and produce a structured review memo — parties, key dates, obligations, unusual clauses, red flags. Use when the user asks to review, analyse, or summarise a contract or agreement.',
    instructions: [
      'You are operating as the Contract Reviewer skill. Everything stays local — never send contract text to the web.',
      '1. Locate the contract: use the attached file/folder scope, or rag_search / fs_search_files when the user names it loosely. Read it fully with fs_read_file before any analysis.',
      '2. Extract, verbatim where possible: the parties, effective date, term & renewal, payment terms, termination rights, liability caps, indemnities, confidentiality, and governing law.',
      '3. Flag anything unusual or one-sided (auto-renewals, unilateral changes, unlimited liability, broad IP assignment) in its own "Red flags" section, quoting the clause.',
      '4. If the user wants a document, call docs_generate (docx) with a structured review memo; otherwise answer inline with short sections.',
      '5. Never invent clause text. If a section is missing from the document, say "not present" — that itself is a finding.',
    ].join('\n'),
    allowedTools: ['fs_read_file', 'fs_list_directory', 'fs_search_files', 'rag_search', 'rag_list_indexes', 'docs_generate', 'memory_store'],
  },
  {
    slug: 'client-intake',
    name: 'Client Intake Organizer',
    icon: '🗂️',
    vertical: 'Legal',
    description: 'Organize new-client documents into a clean matter folder and log the client in the CRM. Use when the user mentions onboarding a client, opening a matter, or organising intake documents.',
    instructions: [
      'You are operating as the Client Intake Organizer skill.',
      '1. List the intake folder first (fs_list_directory). Never assume its contents.',
      '2. Create a tidy structure (e.g. 01-engagement, 02-identity, 03-correspondence, 04-working) with fs_create_directory and move files with fs_move_batch — one batch call, then re-list to verify.',
      '3. Register the client with crm_add_contact (name, email, company if present in the documents) and log the intake as a crm_log_interaction note.',
      '4. Store durable facts (matter name, key dates) with memory_store so future chats know this client.',
      '5. Finish with a short summary: files organised (counts per folder), client logged, anything missing that the user should chase.',
    ].join('\n'),
    allowedTools: ['fs_', 'crm_add_contact', 'crm_log_interaction', 'crm_find', 'memory_store'],
  },
  {
    slug: 'expense-audit',
    name: 'Expense Auditor',
    icon: '🧾',
    vertical: 'Finance',
    description: 'Scan a folder of receipts/statements, categorise spending, flag anomalies, and produce a spreadsheet. Use when the user asks to audit, categorise, or reconcile expenses or receipts.',
    instructions: [
      'You are operating as the Expense Auditor skill. All analysis is local.',
      '1. fs_list_directory the expenses folder; read each statement/receipt you can parse (fs_read_file; PDFs may arrive as attachments).',
      '2. Categorise each line item (travel, software, meals, office, other) and total per category.',
      '3. Flag anomalies explicitly: duplicates, round-number outliers, missing dates, spend spikes vs the other months you saw. Quote the line, never guess.',
      '4. Produce an xlsx via docs_generate with columns: date, vendor, amount, category, flag. Pass every extracted row in "context" so nothing is fabricated.',
      '5. Close with the 3-5 findings a reviewer should look at first.',
    ].join('\n'),
    allowedTools: ['fs_read_file', 'fs_list_directory', 'fs_search_files', 'rag_search', 'docs_generate', 'memory_store'],
  },
  {
    slug: 'invoice-chase',
    name: 'Invoice Follow-up',
    icon: '💸',
    vertical: 'Finance',
    description: 'Track outstanding invoices and draft polite follow-up emails, logging each chase in the CRM. Use when the user asks who owes them money or wants payment reminders drafted.',
    instructions: [
      'You are operating as the Invoice Follow-up skill.',
      '1. Find the invoices (attached folder, rag_search, or fs_search_files) and read them — extract client, amount, issue date, due date.',
      '2. Work out which are overdue relative to today (the environment context gives you the date). Sort by most overdue.',
      '3. Draft a follow-up email per overdue invoice: courteous, one short paragraph, restating amount + due date + payment method if known. Present drafts in chat — do NOT send anything unless the user explicitly says to.',
      '4. Log each drafted chase with crm_log_interaction against the contact (create the contact with crm_add_contact if missing).',
      '5. Summarise: total outstanding, count overdue, oldest invoice.',
    ].join('\n'),
    allowedTools: ['fs_read_file', 'fs_list_directory', 'fs_search_files', 'rag_search', 'crm_', 'kg_query', 'memory_store'],
  },
  {
    slug: 'meeting-brief',
    name: 'Meeting Brief Builder',
    icon: '📋',
    vertical: 'Operations',
    description: 'Build a one-page brief before a meeting — who they are, history from the CRM, open items from your notes. Use when the user asks to prep for a meeting or call with someone.',
    instructions: [
      'You are operating as the Meeting Brief Builder skill.',
      '1. Identify the person/company: crm_find + kg_query for relationship history and past interactions; rag_search your notes for recent mentions.',
      '2. Recall relevant memory with memory_recall (decisions, preferences, commitments made to them).',
      '3. Compose a one-page brief: who they are, relationship history (last 3 interactions), open items/commitments, and 3 suggested talking points grounded in what you found.',
      '4. Deliver inline by default; docs_generate (docx) only if the user asked for a document.',
      '5. Only state facts that came from the CRM, notes, or memory — mark anything uncertain as "unverified".',
    ].join('\n'),
    allowedTools: ['crm_find', 'crm_list', 'kg_query', 'kg_search', 'rag_search', 'memory_recall', 'fs_read_file', 'docs_generate'],
  },
  {
    slug: 'weekly-report',
    name: 'Weekly Status Compiler',
    icon: '📅',
    vertical: 'Operations',
    description: 'Compile a weekly status update from what changed in the project folder and your notes. Use when the user asks for a weekly report, status update, or "what happened this week".',
    instructions: [
      'You are operating as the Weekly Status Compiler skill.',
      '1. fs_list_directory the project folder and identify files modified in the last 7 days (fs_get_file_info when timestamps matter).',
      '2. rag_search notes/documents for this week\'s decisions and progress; memory_recall for commitments made.',
      '3. Structure the update: Done · In progress · Blocked · Next week. Every bullet must trace to a file, note, or memory you actually read.',
      '4. Produce a docx via docs_generate when the user wants a shareable report; otherwise answer inline.',
      '5. Keep it under a page. No filler, no invented progress.',
    ].join('\n'),
    allowedTools: ['fs_list_directory', 'fs_read_file', 'fs_get_file_info', 'fs_search_files', 'rag_search', 'memory_recall', 'docs_generate'],
  },
];

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
  // skill_id of the card whose insights drawer is open (only one at a time).
  const [expandedId, setExpandedId] = useState<string | null>(null);
  // Starter-templates gallery (vertical packs): collapsed by default; slug
  // currently being added (disables its button).
  const [showTemplates, setShowTemplates] = useState(false);
  const [addingTemplate, setAddingTemplate] = useState<string | null>(null);

  // Store actions for the failure "re-run" → opens a fresh chat on the skill.
  const closeWorkspaceSettings = useChatStore(s => s.closeWorkspaceSettings);
  const addUserMessage = useChatStore(s => s.addUserMessage);
  const activeProjectId = useChatStore(s => s.activeProjectId);

  /** Re-run a failed task: spin up a new chat (shared helper — attaches the
   *  project root scope so the re-run gets the same sandbox as a normal
   *  project chat; this entry point used to skip it), send the skill-prefixed
   *  goal so it re-resolves the skill explicitly, then jump the user there.
   *  createChat clears the message list, so addUserMessage must follow it;
   *  agent:sendMessage also persists the user message server-side. */
  const rerun = async (slug: string, goal: string) => {
    const text = `/${slug} ${goal}`.trim();
    const sessionId = await createChat(activeProjectId);
    closeWorkspaceSettings();
    addUserMessage(sessionId, text);
    await window.artha.agent.sendMessage(sessionId, text).catch(() => {});
  };

  /** One-click template install — creates a normal editable skill. */
  const addTemplate = async (t: SkillTemplate) => {
    if (addingTemplate) return;
    setAddingTemplate(t.slug);
    setError('');
    try {
      await window.artha.skills.create({
        slug: t.slug,
        name: t.name,
        icon: t.icon,
        description: t.description,
        instructions: t.instructions,
        allowedTools: t.allowedTools,
        isEnabled: true,
      });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add template');
    } finally {
      setAddingTemplate(null);
    }
  };

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

      {/* Starter templates — curated vertical playbooks (legal / finance / ops).
          One click creates a normal, fully editable skill. */}
      <div className="rounded-xl border border-artha-border bg-artha-s2 mb-4 overflow-hidden">
        <button
          onClick={() => setShowTemplates(v => !v)}
          className="w-full flex items-center gap-2 px-4 py-2.5 text-left hover:bg-artha-text/5 transition-colors"
        >
          <Sparkles size={13} className="text-artha-accent shrink-0" />
          <span className="text-xs font-semibold text-artha-text flex-1">
            Starter templates
            <span className="ml-2 font-normal text-artha-muted">legal · finance · operations</span>
          </span>
          <span className="text-[10px] text-artha-subtle">
            {showTemplates ? 'Hide' : `${SKILL_TEMPLATES.length} playbooks`}
          </span>
        </button>
        {showTemplates && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 px-3 pb-3">
            {SKILL_TEMPLATES.map(t => {
              const installed = skills.some(s => s.slug === t.slug);
              return (
                <div key={t.slug} className="rounded-lg border border-artha-border bg-artha-surface p-3 flex flex-col gap-1.5">
                  <div className="flex items-center gap-2">
                    <span className="text-base leading-none">{t.icon}</span>
                    <span className="text-xs font-medium text-artha-text flex-1 truncate">{t.name}</span>
                    <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-artha-accent/10 text-artha-accent shrink-0">{t.vertical}</span>
                  </div>
                  <p className="text-[11px] text-artha-muted leading-snug line-clamp-2">{t.description}</p>
                  <div className="flex items-center justify-between mt-auto pt-1">
                    <code className="text-[10px] text-artha-subtle font-mono">/{t.slug}</code>
                    {installed ? (
                      <span className="text-[10px] text-artha-success">Added ✓</span>
                    ) : (
                      <button
                        onClick={() => addTemplate(t)}
                        disabled={!!addingTemplate}
                        className="text-[11px] px-2 py-0.5 rounded-md bg-artha-accent/15 hover:bg-artha-accent/25 text-artha-accent font-medium transition-colors disabled:opacity-40"
                      >
                        {addingTemplate === t.slug ? 'Adding…' : 'Add'}
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
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
                      {m && <HealthBadge health={m.health} />}
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
                    <button
                      onClick={() => setExpandedId(prev => prev === s.skill_id ? null : s.skill_id)}
                      title="Insights — models, tools, failures"
                      className={`p-1.5 rounded-lg transition-colors hover:bg-artha-text/5 ${expandedId === s.skill_id ? 'text-artha-accent' : 'text-artha-muted hover:text-artha-text'}`}>
                      {expandedId === s.skill_id ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                    </button>
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
                {expandedId === s.skill_id && (
                  <SkillInsights skill={s} onRerun={rerun} onPinChanged={load} />
                )}
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
