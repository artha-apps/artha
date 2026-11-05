/**
 * Permission modes — how much Artha may do in a chat without asking.
 *
 * A mode is chosen per chat session (chat_sessions.permission_mode) or, when
 * unset, derived from the `autonomousActions` setting. Five modes:
 *
 *   ask           Today's confirm behaviour: plans that change files always
 *                 stop at the plan card; per-call, the user's tool policies
 *                 decide (confirm-tier tools ask).
 *   accept_edits  File writes / moves / new folders INSIDE the chat's attached
 *                 folders run without asking. Deletes always ask, and edits
 *                 outside the attached folders ask.
 *   plan          Read-only tools only, until the user approves the plan. Every
 *                 plan stops at the plan card; anything that would change state
 *                 before approval is blocked (not executed).
 *   auto          Reversible plans run without asking (blast radius, see
 *                 autoApprove.ts) and each call passes `autoGate`: deterministic
 *                 rules, plus an optional local classifier for tools the rules
 *                 don't know. The classifier FAILS CLOSED.
 *   unattended    Nobody is watching (scheduled / LAN runs). Anything that
 *                 would ask is blocked and reported instead — the existing
 *                 fail-closed behaviour. A run that is unattended is ALWAYS in
 *                 this mode, whatever the chat's mode says.
 *
 * Per-call decision order (decideToolCall), most authoritative first:
 *
 *   1. forbid policy                 → block. Nothing overrides it.
 *   2. ALWAYS_CONFIRM_FLOOR          → ask, unless an explicit, unexpired grant
 *                                      names exactly this tool.
 *   3. dry_run policy                → describe, don't execute.
 *   4. mode rules                    → run / ask / block. A block is final.
 *   5. active grant                  → turns an "ask" into "run".
 *   6. baseline (policy tier, with the plan-level blast-radius gate having
 *      already run before the loop started).
 *   Finally an "ask" with nobody to answer becomes a block (skip-and-report).
 *
 * Everything here except the session-mode accessors is pure, so the policy is
 * unit-tested as a mode × tool matrix (modes.test.ts).
 */
import { decideAutoApprove, type AutoApproveDecision } from './autoApprove';
import type { BlastRadius } from './blastRadius';
import type { PolicyTier } from '../bodhi/policy';
import { pathInside, type GrantQuery, type GrantStore } from '../bodhi/grants';
import { getDb } from '../db/schema';

/** The five permission modes. */
export type PermissionMode = 'ask' | 'accept_edits' | 'plan' | 'auto' | 'unattended';

/** All modes, in the order the UI lists them. */
export const PERMISSION_MODES: readonly PermissionMode[] = ['ask', 'accept_edits', 'plan', 'auto', 'unattended'];

/** Short UI labels for each mode. */
export const PERMISSION_MODE_LABELS: Record<PermissionMode, string> = {
  ask: 'Ask',
  accept_edits: 'Accept edits',
  plan: 'Plan',
  auto: 'Auto',
  unattended: 'Unattended',
};

/** Type guard for values coming over IPC / out of the DB. */
export function isPermissionMode(x: unknown): x is PermissionMode {
  return typeof x === 'string' && (PERMISSION_MODES as readonly string[]).includes(x);
}

/** The mode a chat gets when it has none stored: `autonomousActions` off ⇒
 *  ask (no auto-approval, today's off behaviour); on/unset ⇒ auto (today's
 *  default: reversible plans run, the rest asks). */
export function defaultModeFor(autonomous: boolean | undefined): PermissionMode {
  return autonomous === false ? 'ask' : 'auto';
}

/** The mode that actually governs a run. An unattended or LAN run is always
 *  'unattended' — a chat's "auto" can never make a scheduled run ask a modal
 *  nobody will see, or loosen its fail-closed behaviour. */
export function resolveEffectiveMode(
  sessionMode: PermissionMode | null | undefined,
  autonomous: boolean | undefined,
  run?: { lan?: boolean; unattended?: boolean } | null,
): PermissionMode {
  if (run?.lan || run?.unattended) return 'unattended';
  return sessionMode ?? defaultModeFor(autonomous);
}

// ── Tool classes ───────────────────────────────────────────────────────────

/** Tools that only read state. The only tools plan mode allows before approval. */
export const READ_ONLY_TOOLS = new Set<string>([
  'fs_read_file', 'fs_list_directory', 'fs_search_files', 'fs_get_file_info',
  'web_search', 'web_fetch',
  'rag_search', 'rag_list_indexes',
  'memory_recall',
  'kg_query', 'kg_search',
  'crm_find',
  'browser_read_dom', 'browser_screenshot', 'browser_get_url',
  'desktop_screenshot', 'desktop_find_on_screen', 'desktop_get_active_window',
]);

/** Reversible filesystem edits (tracked by agent/undo.ts). */
export const EDIT_TOOLS = new Set<string>([
  'fs_write_file', 'fs_create_directory', 'fs_copy_file', 'fs_move_file', 'fs_move_batch', 'fs_rename_file',
]);

/** Destructive filesystem operations. */
export const DELETE_TOOLS = new Set<string>(['fs_delete_file', 'fs_delete_folder', 'fs_delete_directory']);

/** Built-in tools the deterministic auto-gate rules know about. Anything else
 *  (e.g. an MCP connector's tool) is "unknown" and may go to the classifier. */
const KNOWN_TOOL_PREFIXES = ['fs_', 'web_', 'browser_', 'desktop_', 'memory_', 'rag_', 'kg_', 'crm_', 'docs_', 'email_'];
const KNOWN_TOOLS = new Set<string>(['invoke_capability']);

/** True for built-in tools (by name prefix); false for connector/unknown tools. */
export function isKnownTool(name: string): boolean {
  return KNOWN_TOOLS.has(name) || KNOWN_TOOL_PREFIXES.some(p => name.startsWith(p));
}

// ── Argument extraction ────────────────────────────────────────────────────

/** Argument keys that carry a filesystem path (mirrors bodhi/policy.ts). */
const PATH_ARG_KEYS = ['path', 'destination', 'dest', 'source', 'src', 'target', 'file', 'filename', 'dir', 'directory'];

/** Every path-like string in a tool's args, including fs_move_batch's
 *  `moves: [{source, destination}]`. Used for scope checks and folder grants. */
export function extractPathArgs(args: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const k of PATH_ARG_KEYS) {
    const v = args[k];
    if (typeof v === 'string' && v.trim()) out.push(v);
  }
  if (Array.isArray(args.moves)) {
    for (const m of args.moves) {
      if (m && typeof m === 'object') {
        for (const k of ['source', 'destination']) {
          const v = (m as Record<string, unknown>)[k];
          if (typeof v === 'string' && v.trim()) out.push(v);
        }
      }
    }
  }
  return out;
}

/** URL hosts a tool call reaches (from `url`/`href` args). For host grants. */
export function extractHosts(args: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const k of ['url', 'href']) {
    const v = args[k];
    if (typeof v !== 'string') continue;
    try { out.push(new URL(v).hostname); } catch { /* not a URL — no host */ }
  }
  return out;
}

/** The desktop app a call targets (desktop_open_app's `appName`). For app grants. */
export function extractApp(toolName: string, args: Record<string, unknown>): string | undefined {
  if (toolName !== 'desktop_open_app') return undefined;
  return typeof args.appName === 'string' ? args.appName : undefined;
}

/** True when the chat has attached folders and EVERY path in the call is
 *  inside one of them. No roots or no paths ⇒ false (not provably in scope). */
export function allPathsInRoots(paths: string[], roots: string[]): boolean {
  if (!roots.length || !paths.length) return false;
  return paths.every(p => roots.some(r => pathInside(p, r)));
}

// ── Auto gate ──────────────────────────────────────────────────────────────

/** The auto-mode gate's verdict for one call. */
export interface AutoGateDecision {
  decision: 'allow' | 'ask' | 'block';
  reason: string;
}

/** What the auto gate sees about one call. */
export interface AutoGateCall {
  toolName: string;
  args: Record<string, unknown>;
  /** The user's policy tier for this call (after forbid/floor handling). */
  policyTier: PolicyTier;
  /** The chat's attached folder paths. */
  roots: string[];
  /** True when the user explicitly approved this run's plan (plan card). */
  planApproved: boolean;
  /** True when someone can answer an approval prompt. */
  attended: boolean;
}

/** Optional local-model classifier for calls the deterministic rules can't
 *  judge. It returns raw model text; `parseClassifierOutput` interprets it.
 *  Implementations should honour the abort signal. */
export interface AutoGateClassifier {
  classify(input: { toolName: string; args: Record<string, unknown> }, signal: AbortSignal): Promise<string>;
}

/** Default time budget for the classifier before it fails closed. */
export const CLASSIFIER_TIMEOUT_MS = 3000;

/** Deterministic auto-mode rules. Returns a verdict, or 'classify' when the
 *  rules don't know the tool (only then is a classifier consulted). */
export function autoGateRules(call: AutoGateCall): AutoGateDecision | 'classify' {
  const { toolName } = call;
  // An explicit user confirm rule is never loosened by auto mode, even for reads.
  if (call.policyTier === 'confirm') return { decision: 'ask', reason: 'Your tool policy asks before this call.' };
  if (READ_ONLY_TOOLS.has(toolName)) return { decision: 'allow', reason: 'Read-only tool.' };
  if (DELETE_TOOLS.has(toolName)) {
    return call.planApproved
      ? { decision: 'allow', reason: 'Delete is part of the plan you approved.' }
      : { decision: 'ask', reason: 'Deletes are not reversible — asking first.' };
  }
  if (EDIT_TOOLS.has(toolName)) {
    const paths = extractPathArgs(call.args);
    // A scoped chat confines edits to its folders; anything provably outside
    // them asks. An unscoped chat keeps today's behaviour (Undo covers it).
    if (call.roots.length && paths.length && !allPathsInRoots(paths, call.roots)) {
      return { decision: 'ask', reason: 'Edit reaches outside the attached folders — asking first.' };
    }
    return { decision: 'allow', reason: 'Reversible edit (Undo available).' };
  }
  if (isKnownTool(toolName)) return { decision: 'allow', reason: 'Built-in tool within auto mode.' };
  return 'classify';
}

/** Interpret classifier text. Accepts a JSON object `{"decision": "...",
 *  "reason": "..."}` (optionally inside other text / a code fence). Anything
 *  else — including a valid JSON with an unknown decision — is null. */
export function parseClassifierOutput(raw: unknown): AutoGateDecision | null {
  if (typeof raw !== 'string') return null;
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const j = JSON.parse(m[0]) as { decision?: unknown; reason?: unknown };
    if (j.decision !== 'allow' && j.decision !== 'ask' && j.decision !== 'block') return null;
    return { decision: j.decision, reason: typeof j.reason === 'string' && j.reason.trim() ? j.reason.trim().slice(0, 200) : 'Classifier verdict.' };
  } catch {
    return null;
  }
}

/** The fail-closed verdict: ask when someone can answer, otherwise block
 *  (the call is skipped and the run reports it). */
function failClosed(attended: boolean, why: string): AutoGateDecision {
  return attended
    ? { decision: 'ask', reason: `${why} — asking first.` }
    : { decision: 'block', reason: `${why} and nobody is available to approve — skipped.` };
}

/** Auto-mode gate for one call: deterministic rules first; the classifier only
 *  for unknown tools. No classifier ⇒ unknown tools keep today's behaviour
 *  (allow; the policy layer already had its say). A classifier that times out,
 *  throws, or returns something unparseable FAILS CLOSED. */
export async function autoGate(
  call: AutoGateCall,
  classifier?: AutoGateClassifier | null,
  timeoutMs: number = CLASSIFIER_TIMEOUT_MS,
): Promise<AutoGateDecision> {
  const ruled = autoGateRules(call);
  if (ruled !== 'classify') return ruled;
  if (!classifier) return { decision: 'allow', reason: 'Connector tool within auto mode.' };

  const ctrl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const raw = await Promise.race([
      classifier.classify({ toolName: call.toolName, args: call.args }, ctrl.signal),
      new Promise<symbol>(resolve => { timer = setTimeout(() => resolve(TIMEOUT), timeoutMs); }),
    ]);
    if (raw === TIMEOUT) {
      ctrl.abort();
      return failClosed(call.attended, 'The safety check timed out');
    }
    const parsed = parseClassifierOutput(raw);
    if (!parsed) return failClosed(call.attended, 'The safety check gave no clear answer');
    // Even a classifier "ask" can't reach anyone on an unattended run.
    if (parsed.decision === 'ask' && !call.attended) return failClosed(false, parsed.reason.replace(/\.$/, ''));
    return parsed;
  } catch {
    return failClosed(call.attended, 'The safety check failed');
  } finally {
    if (timer) clearTimeout(timer);
  }
}
const TIMEOUT = Symbol('classifier-timeout');

// ── Full per-call decision ─────────────────────────────────────────────────

/** Everything needed to decide one tool call. */
export interface ToolCallGateInput {
  toolName: string;
  args: Record<string, unknown>;
  /** The effective mode (resolveEffectiveMode). */
  mode: PermissionMode;
  /** The result of evaluatePolicy for this call. */
  policy: { tier: PolicyTier; matchedPattern: string | null; note: string };
  /** True when the tool is on the always-confirm floor (email_send). */
  isFloor: boolean;
  /** True when someone can answer an approval prompt. */
  attended: boolean;
  /** The chat's attached folder paths. */
  roots: string[];
  /** True when the user explicitly approved this run's plan. */
  planApproved: boolean;
  /** Grant subjects that apply to this run (empty ⇒ grants never apply). */
  subjects: string[];
  /** MCP server id owning the tool, if any (connector grants). */
  connector?: string;
  grants: GrantStore;
  classifier?: AutoGateClassifier | null;
  classifierTimeoutMs?: number;
  now?: number;
}

/** What to do with one call, and why (shown to the user / recorded in receipts). */
export interface ToolCallGateDecision {
  action: 'run' | 'ask' | 'block' | 'dry_run';
  reason: string;
  /** Which rule decided. */
  source: 'policy-forbid' | 'floor' | 'policy-dry-run' | 'mode' | 'grant' | 'baseline';
  /** The grant that allowed the call, when source === 'grant'. */
  grantId?: string;
}

/** Mode rules (step 4). Returns run/ask/block for the mode, or null to defer
 *  to the baseline (the user's policy tier). */
async function modeRules(i: ToolCallGateInput): Promise<{ action: 'run' | 'ask' | 'block'; reason: string } | null> {
  const t = i.toolName;
  switch (i.mode) {
    case 'plan':
      if (!i.planApproved) {
        return READ_ONLY_TOOLS.has(t)
          ? null
          : { action: 'block', reason: `Plan mode: ${t} changes things, so it waits until you approve the plan.` };
      }
      return null; // approved plan ⇒ ask-mode behaviour
    case 'accept_edits':
      if (DELETE_TOOLS.has(t)) return { action: 'ask', reason: 'Accept-edits mode still asks before deleting.' };
      if (EDIT_TOOLS.has(t)) {
        if (i.policy.tier === 'confirm') return null; // an explicit user rule still asks
        return allPathsInRoots(extractPathArgs(i.args), i.roots)
          ? { action: 'run', reason: 'Accept-edits mode: edit inside the attached folders.' }
          : { action: 'ask', reason: 'Edit is not inside the attached folders — asking first.' };
      }
      return null;
    case 'auto': {
      const g = await autoGate({
        toolName: t, args: i.args, policyTier: i.policy.tier, roots: i.roots,
        planApproved: i.planApproved, attended: i.attended,
      }, i.classifier, i.classifierTimeoutMs);
      return { action: g.decision === 'allow' ? 'run' : g.decision, reason: g.reason };
    }
    case 'ask':
    case 'unattended':
    default:
      return null;
  }
}

/** Decide one tool call. See the module header for the order. Never returns
 *  'ask' for an unattended run — that becomes 'block' (skip-and-report). */
export async function decideToolCall(i: ToolCallGateInput): Promise<ToolCallGateDecision> {
  const attended = i.attended && i.mode !== 'unattended';
  const query: GrantQuery = {
    toolName: i.toolName,
    subjects: i.subjects,
    paths: extractPathArgs(i.args),
    hosts: extractHosts(i.args),
    app: extractApp(i.toolName, i.args),
    connector: i.connector,
  };
  const noAnswer = (d: ToolCallGateDecision): ToolCallGateDecision =>
    d.action === 'ask' && !attended
      ? { ...d, action: 'block', reason: `${d.reason.replace(/\.$/, '')} — this run is unattended, so it was skipped.` }
      : d;

  // 1. forbid
  if (i.policy.tier === 'forbid') {
    return { action: 'block', source: 'policy-forbid', reason: `Blocked by your tool policy${i.policy.matchedPattern ? ` (rule "${i.policy.matchedPattern}")` : ''}.${i.policy.note ? ` ${i.policy.note}` : ''}` };
  }

  // 2. always-confirm floor: only an explicit, expiring grant naming this tool.
  // On an unattended run that grant must also name a schedule subject — a
  // chat- or global-level "always allow" never lets a background run send.
  if (i.isFloor) {
    const floorSubjects = attended ? i.subjects : i.subjects.filter(s => s.startsWith('schedule:'));
    const g = i.grants.findActive({ ...query, subjects: floorSubjects, explicitToolOnly: true }, i.now);
    if (!g) {
      return noAnswer({ action: 'ask', source: 'floor', reason: i.policy.note || `${i.toolName} always needs your approval.` });
    }
    // Explicit grant present: the floor is satisfied; mode rules still apply.
    const m = await modeRules(i);
    if (m?.action === 'block') return { action: 'block', source: 'mode', reason: m.reason };
    return { action: 'run', source: 'grant', grantId: g.id, reason: `Allowed by your standing grant for ${i.toolName}.` };
  }

  // 3. dry_run policy
  if (i.policy.tier === 'dry_run') {
    return { action: 'dry_run', source: 'policy-dry-run', reason: 'Dry-run policy: described, not executed.' };
  }

  // 4. mode rules
  const m = await modeRules(i);
  if (m?.action === 'block') return { action: 'block', source: 'mode', reason: m.reason };
  if (m?.action === 'run') return { action: 'run', source: 'mode', reason: m.reason };

  // Baseline when the mode deferred: the policy tier.
  const asking = m?.action === 'ask'
    ? { reason: m.reason, source: 'mode' as const }
    : i.policy.tier === 'confirm'
      ? { reason: i.policy.note || `Your tool policy asks before ${i.toolName}.`, source: 'baseline' as const }
      : null;
  if (!asking) return { action: 'run', source: 'baseline', reason: 'Allowed.' };

  // 5. active grant turns the ask into a run.
  const g = i.grants.findActive(query, i.now);
  if (g) return { action: 'run', source: 'grant', grantId: g.id, reason: `Allowed by your standing grant (${g.scope_kind}: ${g.scope_value}).` };

  return noAnswer({ action: 'ask', source: asking.source, reason: asking.reason });
}

// ── Plan-level gate ────────────────────────────────────────────────────────

/** Whether a plan that needs approval may run without the plan card, by mode.
 *  ask/plan always show the card; auto/accept_edits/unattended use the
 *  blast-radius rule (no deletes + reversible). */
export function decidePlanGate(
  mode: PermissionMode,
  blast: Pick<BlastRadius, 'deletions' | 'reversible' | 'moves' | 'writes'> | undefined,
): AutoApproveDecision {
  if (mode === 'ask') return { auto: false, reason: 'Ask mode — review the plan before it runs.' };
  if (mode === 'plan') return { auto: false, reason: 'Plan mode — review the plan before anything changes.' };
  return decideAutoApprove({ autonomous: true, blast });
}

/** True when this mode shows the plan card for EVERY plan, not just ones that
 *  change files (plan mode). */
export function modeRequiresPlanApproval(mode: PermissionMode): boolean {
  return mode === 'plan';
}

// ── Per-session storage ────────────────────────────────────────────────────

/** The stored mode for a chat, or null when unset/unknown. Never throws. */
export function getSessionMode(sessionId: string): PermissionMode | null {
  try {
    const row = getDb().prepare(`SELECT permission_mode FROM chat_sessions WHERE session_id = ?`).get(sessionId) as
      { permission_mode: string | null } | undefined;
    return isPermissionMode(row?.permission_mode) ? row!.permission_mode as PermissionMode : null;
  } catch {
    return null;
  }
}

/** Store a chat's mode (null clears it back to the default). 'unattended' is
 *  set by the runtime, never chosen for an interactive chat. Returns true when
 *  a row was updated. */
export function setSessionMode(sessionId: string, mode: PermissionMode | null): boolean {
  if (mode !== null && (!isPermissionMode(mode) || mode === 'unattended')) {
    throw new Error(`Invalid permission mode: ${String(mode)}`);
  }
  const info = getDb().prepare(`UPDATE chat_sessions SET permission_mode = ? WHERE session_id = ?`).run(mode, sessionId);
  return info.changes > 0;
}
