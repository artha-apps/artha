/**
 * TeamPanel — manage team members, LAN API keys, and shared memories.
 *
 * Three tabs:
 *   Members   — add/remove teammates; set admin vs member role
 *   API Keys  — generate / revoke Bearer tokens for the LAN server
 *   Shared Memory — toggle which memory entities remote teammates can see
 */
import { useEffect, useState } from 'react';
import { Users, Key, Brain, Plus, Trash2, Copy, Check, Eye, EyeOff, Shield, User, AlertTriangle, Loader } from 'lucide-react';

type Tab = 'members' | 'keys' | 'memory';

interface Member {
  member_id: string;
  display_name: string;
  email: string | null;
  role: 'admin' | 'member';
  joined_at: number;
}

interface ApiKey {
  key_id: string;
  name: string;
  created_at: number;
  last_used_at: number | null;
  is_enabled: number;
}

interface MemoryEntity {
  entity_id: string;
  name: string;
  entity_type: string;
  content: string;
  tags_json: string;
  is_shared: number;
  created_at: number;
  updated_at: number;
}

// ── Members tab ───────────────────────────────────────────────────────────────

/**
 * Lists teammates stored in the `team_members` table and provides an add form.
 * Role is displayed as a clickable badge that toggles between admin and member.
 */
function MembersTab() {
  // ── State ──────────────────────────────────────────────────────────────────
  const [members, setMembers] = useState<Member[]>([]);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'admin' | 'member'>('member');
  const [busy, setBusy] = useState(false);

  const load = () =>
    window.artha.team.listMembers().then(setMembers).catch(() => {});

  useEffect(() => { load(); }, []);

  const add = async () => {
    if (!name.trim()) return;
    setBusy(true);
    try {
      await window.artha.team.addMember({ displayName: name, email: email || undefined, role });
      setName(''); setEmail(''); setRole('member');
      await load();
    } finally { setBusy(false); }
  };

  const remove = async (id: string) => {
    await window.artha.team.removeMember(id);
    await load();
  };

  /** Toggle the member between admin and member roles; a full reload keeps truth in DB. */
  const toggleRole = async (m: Member) => {
    const next = m.role === 'admin' ? 'member' : 'admin';
    await window.artha.team.updateMember(m.member_id, { role: next });
    await load();
  };

  return (
    <div className="space-y-4">
      {/* Add form */}
      <div className="p-4 rounded-xl bg-artha-s2 border border-artha-border space-y-3">
        <p className="text-xs font-semibold text-artha-muted uppercase tracking-wide">Add team member</p>
        <div className="flex gap-2">
          <input value={name} onChange={e => setName(e.target.value)}
            placeholder="Display name *"
            className="flex-1 px-3 py-2 rounded-lg bg-artha-surface border border-artha-border text-sm text-artha-text placeholder-artha-muted focus:outline-none focus:border-cyan-500/50" />
          <input value={email} onChange={e => setEmail(e.target.value)}
            placeholder="Email (optional)"
            className="flex-1 px-3 py-2 rounded-lg bg-artha-surface border border-artha-border text-sm text-artha-text placeholder-artha-muted focus:outline-none focus:border-cyan-500/50" />
          <select value={role} onChange={e => setRole(e.target.value as 'admin' | 'member')}
            className="px-3 py-2 rounded-lg bg-artha-surface border border-artha-border text-sm text-artha-text focus:outline-none">
            <option value="member">Member</option>
            <option value="admin">Admin</option>
          </select>
          <button onClick={add} disabled={busy || !name.trim()}
            className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-cyan-600 hover:bg-cyan-500 disabled:opacity-40 text-artha-text text-sm font-medium transition-colors">
            {busy ? <Loader size={13} className="animate-spin" /> : <Plus size={13} />} Add
          </button>
        </div>
      </div>

      {/* List */}
      {members.length === 0 ? (
        <p className="text-center text-sm text-artha-muted py-8">No team members yet. Add one above.</p>
      ) : (
        <div className="space-y-2">
          {members.map(m => (
            <div key={m.member_id}
              className="flex items-center gap-3 px-4 py-3 rounded-xl bg-artha-s2 border border-artha-border">
              <div className={`p-1.5 rounded-lg ${m.role === 'admin' ? 'bg-purple-500/20' : 'bg-cyan-500/10'}`}>
                {m.role === 'admin' ? <Shield size={14} className="text-purple-400" /> : <User size={14} className="text-cyan-400" />}
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-artha-text truncate">{m.display_name}</p>
                {m.email && <p className="text-xs text-artha-muted truncate">{m.email}</p>}
              </div>
              <button onClick={() => toggleRole(m)}
                className={`px-2.5 py-1 rounded-lg text-xs font-medium transition-colors ${
                  m.role === 'admin'
                    ? 'bg-purple-500/15 text-purple-300 hover:bg-purple-500/25'
                    : 'bg-cyan-500/10 text-cyan-400 hover:bg-cyan-500/20'
                }`}>
                {m.role}
              </button>
              <button onClick={() => remove(m.member_id)}
                className="p-1.5 rounded-lg text-artha-muted hover:text-red-400 hover:bg-red-500/10 transition-colors">
                <Trash2 size={13} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── API Keys tab ──────────────────────────────────────────────────────────────

/**
 * Manages Bearer tokens for the LAN server. The plaintext key is shown exactly
 * once after creation (stored only as a bcrypt hash); after that only the name
 * and metadata are visible. When the `api_keys` table is empty the LAN server
 * operates without auth — the yellow warning banner reflects this.
 */
function ApiKeysTab() {
  // ── State ──────────────────────────────────────────────────────────────────
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [keyName, setKeyName] = useState('');
  // `newKey` holds the one-time plaintext reveal; cleared on revoke or navigation.
  const [newKey, setNewKey] = useState<{ key_id: string; plaintext: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = () => window.artha.apikeys.list().then(setKeys).catch(() => {});
  useEffect(() => { load(); }, []);

  const create = async () => {
    setBusy(true);
    try {
      const result = await window.artha.apikeys.create(keyName || 'API Key');
      setNewKey(result);
      setKeyName('');
      await load();
    } finally { setBusy(false); }
  };

  const copyKey = (k: string) => {
    navigator.clipboard.writeText(k);
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };

  const revoke = async (id: string) => {
    await window.artha.apikeys.revoke(id);
    // Also clear the one-time reveal banner if that key was revoked.
    if (newKey?.key_id === id) setNewKey(null);
    await load();
  };

  const toggle = async (id: string, current: number) => {
    await window.artha.apikeys.toggle(id, current === 0);
    await load();
  };

  const fmt = (ts: number | null) =>
    ts ? new Date(ts * 1000).toLocaleDateString() : 'Never';

  return (
    <div className="space-y-4">
      <div className="flex items-start gap-3 p-3 rounded-xl bg-yellow-500/10 border border-yellow-500/30 text-sm text-yellow-300">
        <AlertTriangle size={15} className="shrink-0 mt-0.5" />
        <span>When no keys exist the LAN server is open. Add at least one key to require authentication.</span>
      </div>

      {/* New key reveal */}
      {newKey && (
        <div className="p-4 rounded-xl bg-green-500/10 border border-green-500/30 space-y-2">
          <p className="text-xs font-semibold text-green-400">Copy this key now — it will not be shown again.</p>
          <div className="flex items-center gap-2">
            <code className="flex-1 font-mono text-xs text-green-300 break-all bg-black/30 px-3 py-2 rounded-lg">
              {newKey.plaintext}
            </code>
            <button onClick={() => copyKey(newKey.plaintext)}
              className="p-2 rounded-lg bg-green-500/20 hover:bg-green-500/30 text-green-400 transition-colors shrink-0">
              {copied ? <Check size={14} /> : <Copy size={14} />}
            </button>
          </div>
          <p className="text-xs text-artha-muted">Use as: <code className="font-mono">Authorization: Bearer {newKey.plaintext.slice(0, 8)}…</code></p>
        </div>
      )}

      {/* Create form */}
      <div className="flex gap-2">
        <input value={keyName} onChange={e => setKeyName(e.target.value)}
          placeholder="Key name (e.g. Alice's laptop)"
          className="flex-1 px-3 py-2 rounded-lg bg-artha-s2 border border-artha-border text-sm text-artha-text placeholder-artha-muted focus:outline-none focus:border-cyan-500/50" />
        <button onClick={create} disabled={busy}
          className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-cyan-600 hover:bg-cyan-500 disabled:opacity-40 text-artha-text text-sm font-medium transition-colors">
          {busy ? <Loader size={13} className="animate-spin" /> : <Plus size={13} />} Generate
        </button>
      </div>

      {/* List */}
      {keys.length === 0 ? (
        <p className="text-center text-sm text-artha-muted py-6">No API keys yet.</p>
      ) : (
        <div className="space-y-2">
          {keys.map(k => (
            <div key={k.key_id}
              className="flex items-center gap-3 px-4 py-3 rounded-xl bg-artha-s2 border border-artha-border">
              <Key size={14} className={k.is_enabled ? 'text-cyan-400' : 'text-artha-muted'} />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-artha-text truncate">{k.name}</p>
                <p className="text-xs text-artha-muted">
                  Created {fmt(k.created_at)} · Last used {fmt(k.last_used_at)}
                </p>
              </div>
              <button onClick={() => toggle(k.key_id, k.is_enabled)}
                title={k.is_enabled ? 'Disable' : 'Enable'}
                className="p-1.5 rounded-lg text-artha-muted hover:text-artha-text hover:bg-artha-text/8 transition-colors">
                {k.is_enabled ? <Eye size={13} /> : <EyeOff size={13} />}
              </button>
              <button onClick={() => revoke(k.key_id)}
                className="p-1.5 rounded-lg text-artha-muted hover:text-red-400 hover:bg-red-500/10 transition-colors">
                <Trash2 size={13} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Shared memory tab ─────────────────────────────────────────────────────────

/**
 * Lets the user choose which memory entities are visible to LAN-server sessions.
 * Shared entities are injected into the system prompt for every remote request,
 * giving teammates the same persistent context the host user has.
 */
function SharedMemoryTab() {
  const [memories, setMemories] = useState<MemoryEntity[]>([]);
  // `busy` holds the entity_id whose toggle is in-flight (to prevent double-tap).
  const [busy, setBusy] = useState<string | null>(null);

  const load = async () => {
    // Load ALL memories so the user can toggle sharing on any of them — including
    // ones that are not yet shared. The `is_shared` field may be absent on older rows.
    const all = await window.artha.memory.list() as unknown as (MemoryEntity & { is_shared?: number })[];
    setMemories(all.map(m => ({ ...m, is_shared: m.is_shared ?? 0 })));
  };

  useEffect(() => { load().catch(() => {}); }, []);

  const toggle = async (m: MemoryEntity) => {
    setBusy(m.entity_id);
    try {
      await window.artha.sharedMemory.setShared(m.entity_id, m.is_shared === 0);
      await load();
    } finally { setBusy(null); }
  };

  return (
    <div className="space-y-4">
      <p className="text-sm text-artha-muted">
        Shared memories are injected into every LAN server session — teammates get the same persistent context as you.
      </p>
      {memories.length === 0 ? (
        <p className="text-center text-sm text-artha-muted py-8">
          No memories yet. Start a conversation and Artha will learn about you over time.
        </p>
      ) : (
        <div className="space-y-2">
          {memories.map(m => (
            <div key={m.entity_id}
              className="flex items-start gap-3 px-4 py-3 rounded-xl bg-artha-s2 border border-artha-border">
              <Brain size={14} className={`mt-0.5 shrink-0 ${m.is_shared ? 'text-cyan-400' : 'text-artha-muted'}`} />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-artha-text truncate">{m.name}</p>
                <p className="text-xs text-artha-muted line-clamp-2">{m.content}</p>
              </div>
              <button
                onClick={() => toggle(m)}
                disabled={busy === m.entity_id}
                className={`shrink-0 relative w-10 h-5.5 rounded-full transition-colors disabled:opacity-50 ${
                  m.is_shared ? 'bg-cyan-500' : 'bg-white/15'
                }`}
                role="switch"
                aria-checked={m.is_shared === 1}
                title={m.is_shared ? 'Shared with team' : 'Private'}
              >
                <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
                  m.is_shared ? 'translate-x-4.5' : ''
                }`} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Main panel ────────────────────────────────────────────────────────────────

/**
 * Team panel shell — renders the three sub-components (MembersTab, ApiKeysTab,
 * SharedMemoryTab) inside a shared header and tab bar.
 */
export default function TeamPanel() {
  const [tab, setTab] = useState<Tab>('members');

  const tabs: { id: Tab; label: string; icon: React.ElementType }[] = [
    { id: 'members', label: 'Members',       icon: Users  },
    { id: 'keys',    label: 'API Keys',      icon: Key    },
    { id: 'memory',  label: 'Shared Memory', icon: Brain  },
  ];

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="max-w-3xl mx-auto">
        {/* Header */}
        <div className="flex items-center gap-3 mb-6">
          <Users size={22} className="text-cyan-400" />
          <div>
            <h2 className="text-lg font-semibold text-artha-text">Team</h2>
            <p className="text-sm text-artha-muted">
              Manage teammates, issue LAN API keys, and choose which memories to share
            </p>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex gap-1 mb-6 p-1 rounded-xl bg-artha-s2 border border-artha-border">
          {tabs.map(({ id, label, icon: Icon }) => (
            <button key={id} onClick={() => setTab(id)}
              className={`flex items-center gap-2 flex-1 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                tab === id ? 'bg-artha-surface text-artha-text shadow-sm' : 'text-artha-muted hover:text-artha-text'
              }`}>
              <Icon size={14} /> {label}
            </button>
          ))}
        </div>

        {tab === 'members' && <MembersTab />}
        {tab === 'keys'    && <ApiKeysTab />}
        {tab === 'memory'  && <SharedMemoryTab />}
      </div>
    </div>
  );
}
