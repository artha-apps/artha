/**
 * GrantsPanel — standing "Always allow" grants, with Revoke.
 *
 * Every time the user answers an approval prompt with "Always allow (30 days)"
 * Artha records a grant (bodhi/grants.ts). This panel lists them so the user can
 * see exactly what runs without asking, until when, and where — and revoke any
 * of them. Revocation is immediate: the next matching tool call asks again.
 * Expired and revoked grants stay listed (dimmed) as an audit trail.
 */
import { useEffect, useState } from 'react';
import { KeyRound, Trash2 } from 'lucide-react';

/** One row from `grants:list`. */
interface GrantRow {
  id: string;
  scope_kind: 'tool' | 'host' | 'folder' | 'app' | 'connector';
  scope_value: string;
  subject: string;
  created_at: number;
  expires_at: number | null;
  revoke_gen: number;
  active: boolean;
}

/** Human label for a grant subject (session:/project:/schedule:/global). */
function subjectLabel(subject: string): string {
  if (subject === 'global') return 'All chats';
  const [kind, id] = subject.split(':');
  return `${kind.charAt(0).toUpperCase()}${kind.slice(1)} ${id?.slice(0, 8) ?? ''}`;
}

/** Human status for a grant: active-until, expired, or revoked. */
function statusLabel(g: GrantRow): string {
  if (g.revoke_gen > 0) return 'Revoked';
  if (!g.active) return 'Expired';
  return g.expires_at ? `Until ${new Date(g.expires_at * 1000).toLocaleDateString()}` : 'No expiry';
}

export default function GrantsPanel() {
  const [grants, setGrants] = useState<GrantRow[]>([]);
  const [loading, setLoading] = useState(true);

  /** Reload the list from the main process. */
  const reload = () => window.artha.grants.list()
    .then(g => { setGrants(g as GrantRow[]); setLoading(false); })
    .catch(() => setLoading(false));
  useEffect(() => { reload(); }, []);

  /** Revoke one grant, then refresh. */
  const revoke = async (id: string) => {
    await window.artha.grants.revoke(id);
    reload();
  };

  return (
    <div className="p-6 space-y-4 max-w-3xl">
      <div className="flex items-center gap-2">
        <KeyRound size={16} className="text-artha-accent" />
        <h2 className="text-base font-semibold text-artha-text">Grants</h2>
      </div>
      <p className="text-xs text-artha-muted">
        Things you told Artha to always allow. A grant only skips the question — it never overrides a
        Forbid policy, plan mode, or the rule that sending email always asks.
      </p>
      {loading ? (
        <p className="text-sm text-artha-muted">Loading…</p>
      ) : grants.length === 0 ? (
        <p className="text-sm text-artha-muted/70">No grants yet. Choose “Always allow (30 days)” on an approval prompt to add one.</p>
      ) : (
        <div className="space-y-1.5">
          {grants.map(g => (
            <div
              key={g.id}
              className={`flex items-center gap-3 px-3 py-2 rounded-lg border border-artha-border bg-artha-surface ${g.active ? '' : 'opacity-50'}`}
            >
              <span className="text-[10px] uppercase tracking-wide text-artha-subtle w-16 shrink-0">{g.scope_kind}</span>
              <code className="text-xs font-mono text-artha-text truncate flex-1 min-w-0" title={g.scope_value}>{g.scope_value}</code>
              <span className="text-[11px] text-artha-muted shrink-0">{subjectLabel(g.subject)}</span>
              <span className="text-[11px] text-artha-muted shrink-0 w-28 text-right">{statusLabel(g)}</span>
              {g.active ? (
                <button
                  onClick={() => revoke(g.id)}
                  className="flex items-center gap-1 px-2 py-1 rounded-md text-[11px] text-artha-danger hover:bg-artha-danger/8"
                  aria-label={`Revoke grant for ${g.scope_value}`}
                >
                  <Trash2 size={11} /> Revoke
                </button>
              ) : <span className="w-[62px]" />}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
