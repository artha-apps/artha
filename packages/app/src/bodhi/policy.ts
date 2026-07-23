/**
 * Bodhi — Tool-Call Policies (governance layer for function calling).
 *
 * Competitors gate at the *plan* boundary: you approve a whole plan, which
 * implicitly approves every tool call inside it. Artha governs at the level of
 * the individual function call, taking the tool name AND its arguments into
 * account. A policy binds a tool *pattern* to a *tier*:
 *
 *   auto     — run silently (the historical default for every tool).
 *   confirm  — pause and ask the user before this specific call runs.
 *   dry_run  — never execute; report what *would* have happened.
 *   forbid   — block the call outright with a clear reason.
 *
 * A policy's `scope` narrows *when* it applies:
 *   always         — every invocation of a matching tool.
 *   outside_roots  — only when the call's path arguments resolve OUTSIDE the
 *                    chat's sandbox roots (so "delete anywhere outside my
 *                    attached folders needs confirmation" is one rule).
 *
 * Everything here is local-first: policies live in SQLite and are evaluated in
 * the main process, so the rules never leave the device. The pattern-matching
 * convention matches the Skills tool-allowlist exactly (exact name, a prefix
 * ending in "_", or "*" for all tools) so the two systems read the same way.
 */
import { getDb } from '../db/schema';
import type { ScopeRoot } from '../db/scopes';

/** How a matching tool call is handled. Ordered least → most restrictive; the
 *  evaluator always picks the most restrictive tier among matching policies. */
export type PolicyTier = 'auto' | 'confirm' | 'dry_run' | 'forbid';

/** When a policy applies. */
export type PolicyScope = 'always' | 'outside_roots';

/** A row from `tool_policies`. */
export interface ToolPolicy {
  policy_id: string;
  pattern: string;
  tier: PolicyTier;
  scope: PolicyScope;
  note: string;
  is_enabled: number;
  created_at: number;
}

/** The write surface for creating/updating a policy. */
export interface PolicyInput {
  pattern: string;
  tier: PolicyTier;
  scope?: PolicyScope;
  note?: string;
  isEnabled?: boolean;
}

/** The outcome of evaluating a tool call against all enabled policies. */
export interface PolicyDecision {
  tier: PolicyTier;
  /** The pattern of the policy that decided this, or null when nothing matched
   *  (→ implicit 'auto'). */
  matchedPattern: string | null;
  /** Human-readable note from the deciding policy, surfaced in the approval UI. */
  note: string;
}

const TIER_RANK: Record<PolicyTier, number> = { auto: 0, dry_run: 1, confirm: 2, forbid: 3 };

/**
 * Built-in approval floor: tools that dispatch a real, hard-to-reverse external
 * action may NEVER run below 'confirm', regardless of (or in the absence of)
 * any user policy. A user can raise these to 'forbid', but can never lower them
 * to 'auto' — so "actually send this email" always pauses for a human, and
 * fails closed on unattended runs. This is enforced in code, not data, so an
 * empty or misconfigured policy table can't silently un-gate a send.
 */
const ALWAYS_CONFIRM_FLOOR = new Set<string>(['email_send']);

/** True when `pattern` matches `toolName`. Mirrors the Skills allowlist
 *  convention: "*" = all tools; a trailing "_" = name prefix; else exact. */
export function policyMatches(pattern: string, toolName: string): boolean {
  if (pattern === '*') return true;
  if (pattern.endsWith('_')) return toolName.startsWith(pattern);
  return pattern === toolName;
}

/** Common argument keys that carry a filesystem path, in priority order. */
const PATH_ARG_KEYS = ['path', 'destination', 'dest', 'source', 'src', 'target', 'file', 'filename', 'dir', 'directory'];

/** Pull every path-like string out of a tool's arguments (handles fs_move_batch's
 *  `moves: [{source, destination}]` shape too). Best-effort — used only to decide
 *  whether an `outside_roots` policy applies. */
function extractPaths(args: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const key of PATH_ARG_KEYS) {
    const v = args[key];
    if (typeof v === 'string' && v.trim()) out.push(v);
  }
  const moves = args.moves;
  if (Array.isArray(moves)) {
    for (const m of moves) {
      if (m && typeof m === 'object') {
        for (const key of ['source', 'destination']) {
          const v = (m as Record<string, unknown>)[key];
          if (typeof v === 'string' && v.trim()) out.push(v);
        }
      }
    }
  }
  return out;
}

/** True when `p` is inside one of the sandbox roots (prefix match on the
 *  normalised path). An empty root list means "no sandbox" → nothing is inside. */
function isInsideRoots(p: string, roots: ScopeRoot[]): boolean {
  if (!roots.length) return false;
  const norm = p.replace(/\/+$/, '');
  return roots.some(r => {
    const root = r.path.replace(/\/+$/, '');
    return norm === root || norm.startsWith(root + '/');
  });
}

/** Decide whether an `outside_roots` policy applies to this call. It applies
 *  when the chat has a sandbox AND at least one path argument falls outside it,
 *  OR when there is no sandbox at all (an unscoped chat has no "inside"). Calls
 *  with no path arguments are treated as outside (they're not bound to a root). */
function appliesOutsideRoots(args: Record<string, unknown>, roots: ScopeRoot[]): boolean {
  if (!roots.length) return true;
  const paths = extractPaths(args);
  if (!paths.length) return true;
  return paths.some(p => !isInsideRoots(p, roots));
}

/** All policies, most-restrictive first, for the management UI. */
export function listPolicies(): ToolPolicy[] {
  return getDb()
    .prepare(`SELECT * FROM tool_policies ORDER BY is_enabled DESC, created_at ASC`)
    .all() as ToolPolicy[];
}

/** Evaluate a single tool call. Returns the most restrictive tier among all
 *  enabled, matching, in-scope policies; 'auto' (no match) by default. Never
 *  throws — a DB hiccup degrades to 'auto' so a policy lookup can't break a run. */
export function evaluatePolicy(
  toolName: string,
  args: Record<string, unknown>,
  ctx?: { allowedRoots?: ScopeRoot[] | null },
): PolicyDecision {
  try {
    const roots = ctx?.allowedRoots ?? [];
    const policies = getDb()
      .prepare(`SELECT * FROM tool_policies WHERE is_enabled = 1`)
      .all() as ToolPolicy[];

    // Built-in floor first — a consequential send can never be below 'confirm',
    // even with no policy row present.
    let best: PolicyDecision = ALWAYS_CONFIRM_FLOOR.has(toolName)
      ? { tier: 'confirm', matchedPattern: 'built-in:always-confirm', note: 'Sending mail always needs your approval.' }
      : { tier: 'auto', matchedPattern: null, note: '' };
    for (const p of policies) {
      if (!policyMatches(p.pattern, toolName)) continue;
      if (p.scope === 'outside_roots' && !appliesOutsideRoots(args, roots)) continue;
      if (TIER_RANK[p.tier] > TIER_RANK[best.tier]) {
        best = { tier: p.tier, matchedPattern: p.pattern, note: p.note };
      }
    }
    return best;
  } catch {
    // Even on a DB failure, the send floor must hold.
    return ALWAYS_CONFIRM_FLOOR.has(toolName)
      ? { tier: 'confirm', matchedPattern: 'built-in:always-confirm', note: 'Sending mail always needs your approval.' }
      : { tier: 'auto', matchedPattern: null, note: '' };
  }
}

/** Create a policy. Returns the created row. */
export function createPolicy(input: PolicyInput): ToolPolicy {
  const db = getDb();
  const pattern = input.pattern.trim();
  db.prepare(
    `INSERT INTO tool_policies (pattern, tier, scope, note, is_enabled)
     VALUES (?, ?, ?, ?, ?)`
  ).run(
    pattern,
    input.tier,
    input.scope ?? 'always',
    input.note ?? '',
    input.isEnabled === false ? 0 : 1,
  );
  return db.prepare(`SELECT * FROM tool_policies WHERE pattern = ? ORDER BY created_at DESC LIMIT 1`).get(pattern) as ToolPolicy;
}

/** Patch a policy by id. Only the provided fields change. */
export function updatePolicy(policyId: string, patch: Partial<PolicyInput>): ToolPolicy | undefined {
  const db = getDb();
  const existing = db.prepare(`SELECT * FROM tool_policies WHERE policy_id = ?`).get(policyId) as ToolPolicy | undefined;
  if (!existing) return undefined;
  const next = {
    pattern: patch.pattern?.trim() ?? existing.pattern,
    tier: patch.tier ?? existing.tier,
    scope: patch.scope ?? existing.scope,
    note: patch.note ?? existing.note,
    is_enabled: patch.isEnabled === undefined ? existing.is_enabled : (patch.isEnabled ? 1 : 0),
  };
  db.prepare(
    `UPDATE tool_policies SET pattern=?, tier=?, scope=?, note=?, is_enabled=? WHERE policy_id=?`
  ).run(next.pattern, next.tier, next.scope, next.note, next.is_enabled, policyId);
  return db.prepare(`SELECT * FROM tool_policies WHERE policy_id = ?`).get(policyId) as ToolPolicy;
}

/** Delete a policy. Returns true if a row was removed. */
export function deletePolicy(policyId: string): boolean {
  const info = getDb().prepare(`DELETE FROM tool_policies WHERE policy_id = ?`).run(policyId);
  return info.changes > 0;
}
