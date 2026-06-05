/**
 * CrmPanel — browse the local CRM and the Knowledge Graph behind it.
 *
 * Two views in one panel (no extra nav slot):
 *   • Contacts — the people/companies the CRM Agent recorded, each expandable
 *     to its logged interactions, plus a manual "Add contact" form.
 *   • Graph    — the projected Knowledge Graph: entities grouped by kind and
 *     their typed relations as a textual adjacency list, with a query box.
 *
 * Reads/writes the SAME tables the CRM Agent's crm_* and kg_* tools use, via the
 * `crm:*` / `kg:*` IPC channels — local component state only, no store (the
 * MemoryPanel/SkillsPanel convention).
 */
import { useEffect, useState } from 'react';
import { Contact2, Network, RefreshCw, Trash2, Plus, ChevronRight, ChevronDown, Search } from 'lucide-react';

interface ContactSummary {
  contact_id: string;
  name: string;
  email: string | null;
  company: string | null;
  title: string | null;
  last_interaction_at: number | null;
  created_at: number;
}
interface Interaction {
  interaction_id: string;
  contact_id: string | null;
  kind: string;
  summary: string;
  occurred_at: number;
}
interface KgNode {
  entity_id: string;
  kind: string;
  name: string;
  props: Record<string, unknown>;
}
interface KgEdge {
  relation_id: string;
  src_id: string;
  dst_id: string;
  rel_type: string;
}

const KIND_COLOURS: Record<string, string> = {
  person:      'bg-green-500/20 text-green-300',
  company:     'bg-orange-500/20 text-orange-300',
  deal:        'bg-yellow-500/20 text-yellow-300',
  interaction: 'bg-blue-500/20 text-blue-300',
  thing:       'bg-artha-muted/20 text-artha-muted',
};

function fmtDate(epochSecs: number | null): string {
  if (!epochSecs) return '—';
  return new Date(epochSecs * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export default function CrmPanel() {
  const [view, setView] = useState<'contacts' | 'graph'>('contacts');
  const [loading, setLoading] = useState(true);

  return (
    <div className="flex flex-col h-full p-6 overflow-y-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <Contact2 size={22} className="text-orange-400" />
          <div>
            <h2 className="text-lg font-semibold text-artha-text">CRM Agent</h2>
            <p className="text-sm text-artha-muted">Local contacts, deals & the relationship graph</p>
          </div>
        </div>
        {/* View toggle */}
        <div className="flex items-center gap-1 p-1 rounded-lg bg-artha-text/5 border border-artha-border">
          <button
            onClick={() => setView('contacts')}
            className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-md text-sm transition-colors ${view === 'contacts' ? 'bg-artha-accent text-artha-text' : 'text-artha-muted hover:text-artha-text'}`}
          >
            <Contact2 size={14} /> Contacts
          </button>
          <button
            onClick={() => setView('graph')}
            className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-md text-sm transition-colors ${view === 'graph' ? 'bg-artha-accent text-artha-text' : 'text-artha-muted hover:text-artha-text'}`}
          >
            <Network size={14} /> Knowledge Graph
          </button>
        </div>
      </div>

      {view === 'contacts'
        ? <ContactsView loading={loading} setLoading={setLoading} />
        : <GraphView />}
    </div>
  );
}

// ── Contacts view ────────────────────────────────────────────────────────────

function ContactsView({ loading, setLoading }: { loading: boolean; setLoading: (b: boolean) => void }) {
  const [contacts, setContacts] = useState<ContactSummary[]>([]);
  const [expanded, setExpanded] = useState<Record<string, Interaction[]>>({});
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ name: '', company: '', email: '' });

  async function load() {
    setLoading(true);
    try {
      setContacts(await window.artha.crm.listContacts());
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { load(); }, []);

  async function toggle(contactId: string) {
    if (expanded[contactId]) {
      setExpanded(prev => { const next = { ...prev }; delete next[contactId]; return next; });
      return;
    }
    const rows = await window.artha.crm.listInteractions(contactId);
    setExpanded(prev => ({ ...prev, [contactId]: rows }));
  }

  async function handleAdd() {
    const name = form.name.trim();
    if (!name) return;
    await window.artha.crm.addContact({
      name,
      company: form.company.trim() || undefined,
      email: form.email.trim() || undefined,
    });
    setForm({ name: '', company: '', email: '' });
    setAdding(false);
    load();
  }

  async function handleDelete(contactId: string) {
    await window.artha.crm.deleteContact(contactId);
    setContacts(prev => prev.filter(c => c.contact_id !== contactId));
  }

  return (
    <>
      <div className="flex items-center justify-between mb-4">
        <p className="text-sm text-artha-muted">{contacts.length} {contacts.length === 1 ? 'contact' : 'contacts'}</p>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setAdding(a => !a)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm text-artha-text bg-artha-accent hover:bg-artha-accent/80 transition-colors"
          >
            <Plus size={14} /> Add contact
          </button>
          <button onClick={load} className="p-2 rounded-lg hover:bg-artha-text/8 text-artha-muted hover:text-artha-text transition-colors" title="Refresh">
            <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>

      {/* Inline add form */}
      {adding && (
        <div className="mb-4 p-4 rounded-xl bg-artha-text/5 border border-artha-border space-y-2">
          <input
            autoFocus value={form.name} onChange={e => setForm({ ...form, name: e.target.value })}
            placeholder="Full name" className="w-full px-3 py-2 rounded-lg bg-artha-bg border border-artha-border text-sm text-artha-text placeholder-artha-subtle outline-none focus:border-artha-accent"
          />
          <div className="flex gap-2">
            <input
              value={form.company} onChange={e => setForm({ ...form, company: e.target.value })}
              placeholder="Company" className="flex-1 px-3 py-2 rounded-lg bg-artha-bg border border-artha-border text-sm text-artha-text placeholder-artha-subtle outline-none focus:border-artha-accent"
            />
            <input
              value={form.email} onChange={e => setForm({ ...form, email: e.target.value })}
              placeholder="Email" className="flex-1 px-3 py-2 rounded-lg bg-artha-bg border border-artha-border text-sm text-artha-text placeholder-artha-subtle outline-none focus:border-artha-accent"
            />
          </div>
          <div className="flex justify-end gap-2">
            <button onClick={() => { setAdding(false); setForm({ name: '', company: '', email: '' }); }} className="px-3 py-1.5 rounded-lg text-sm text-artha-muted hover:bg-artha-text/8 transition-colors">Cancel</button>
            <button onClick={handleAdd} disabled={!form.name.trim()} className="px-3 py-1.5 rounded-lg text-sm bg-artha-accent text-artha-text disabled:opacity-40 hover:bg-artha-accent/80 transition-colors">Save</button>
          </div>
        </div>
      )}

      {/* Empty state */}
      {!loading && contacts.length === 0 && !adding && (
        <div className="flex-1 flex flex-col items-center justify-center text-center gap-3 py-12">
          <Contact2 size={40} className="text-artha-subtle" />
          <p className="text-artha-muted text-sm">No contacts yet.</p>
          <p className="text-artha-subtle text-xs max-w-xs">Ask the CRM Agent (in Delegate) to "add a contact" or use Add contact above.</p>
        </div>
      )}

      {/* Contact list */}
      <div className="space-y-2">
        {contacts.map(c => {
          const isOpen = !!expanded[c.contact_id];
          return (
            <div key={c.contact_id} className="group rounded-xl bg-artha-text/5 hover:bg-white/8 border border-white/5 transition-colors">
              <div className="flex items-start gap-3 p-4">
                <button onClick={() => toggle(c.contact_id)} className="mt-0.5 text-artha-subtle hover:text-artha-text transition-colors" title="Show interactions">
                  {isOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                </button>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-artha-text truncate">
                    {c.name}{c.company && <span className="text-artha-muted font-normal"> · {c.company}</span>}
                  </p>
                  {c.email && <p className="text-xs text-artha-muted mt-0.5 truncate">{c.email}</p>}
                  <p className="text-xs text-artha-subtle mt-1">Last interaction: {fmtDate(c.last_interaction_at)}</p>
                </div>
                <button
                  onClick={() => handleDelete(c.contact_id)}
                  className="flex-shrink-0 p-1.5 rounded-lg opacity-0 group-hover:opacity-100 hover:bg-artha-danger/20 text-artha-subtle hover:text-artha-danger transition-all"
                  title="Delete contact"
                >
                  <Trash2 size={14} />
                </button>
              </div>
              {isOpen && (
                <div className="px-4 pb-4 pl-11 space-y-1.5">
                  {expanded[c.contact_id].length === 0 && <p className="text-xs text-artha-subtle">No interactions logged.</p>}
                  {expanded[c.contact_id].map(i => (
                    <div key={i.interaction_id} className="flex items-start gap-2 text-xs">
                      <span className={`px-2 py-0.5 rounded-full font-medium ${KIND_COLOURS.interaction}`}>{i.kind}</span>
                      <span className="text-artha-muted flex-1">{i.summary || '—'}</span>
                      <span className="text-artha-subtle">{fmtDate(i.occurred_at)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </>
  );
}

// ── Knowledge Graph view ─────────────────────────────────────────────────────

function GraphView() {
  const [nodes, setNodes] = useState<KgNode[]>([]);
  const [edges, setEdges] = useState<KgEdge[]>([]);
  const [query, setQuery] = useState('');
  const [matchIds, setMatchIds] = useState<Set<string> | null>(null);
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true);
    try {
      const [n, e] = await Promise.all([window.artha.kg.listNodes(), window.artha.kg.listEdges()]);
      setNodes(n);
      setEdges(e);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { load(); }, []);

  async function runQuery() {
    const q = query.trim();
    if (!q) { setMatchIds(null); return; }
    const res = await window.artha.kg.query(q);
    setMatchIds(new Set(res.nodes.map(n => n.entity_id)));
  }

  const byId = new Map(nodes.map(n => [n.entity_id, n]));
  const visibleNodes = matchIds ? nodes.filter(n => matchIds.has(n.entity_id)) : nodes;
  const grouped = visibleNodes.reduce<Record<string, KgNode[]>>((acc, n) => {
    (acc[n.kind] ??= []).push(n);
    return acc;
  }, {});
  const visibleEdges = matchIds
    ? edges.filter(e => matchIds.has(e.src_id) || matchIds.has(e.dst_id))
    : edges;

  return (
    <>
      {/* Query box */}
      <div className="flex items-center gap-2 mb-4">
        <div className="flex-1 flex items-center gap-2 px-3 py-2 rounded-lg bg-artha-text/5 border border-artha-border">
          <Search size={14} className="text-artha-subtle" />
          <input
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') runQuery(); }}
            placeholder="Query the graph (e.g. a name or company)…"
            className="flex-1 bg-transparent text-sm text-artha-text placeholder-artha-subtle outline-none"
          />
          {matchIds && (
            <button onClick={() => { setQuery(''); setMatchIds(null); }} className="text-xs text-artha-subtle hover:text-artha-text">clear</button>
          )}
        </div>
        <button onClick={load} className="p-2 rounded-lg hover:bg-artha-text/8 text-artha-muted hover:text-artha-text transition-colors" title="Refresh">
          <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>

      {/* Empty state */}
      {!loading && nodes.length === 0 && (
        <div className="flex-1 flex flex-col items-center justify-center text-center gap-3 py-12">
          <Network size={40} className="text-artha-subtle" />
          <p className="text-artha-muted text-sm">The knowledge graph is empty.</p>
          <p className="text-artha-subtle text-xs max-w-xs">It fills up as the CRM Agent records contacts, companies, deals, and interactions.</p>
        </div>
      )}

      {/* Entities grouped by kind */}
      {visibleNodes.length > 0 && (
        <div className="space-y-4">
          <div>
            <p className="text-xs uppercase tracking-wide text-artha-subtle mb-2">Entities ({visibleNodes.length})</p>
            <div className="space-y-3">
              {Object.entries(grouped).map(([kind, group]) => (
                <div key={kind}>
                  <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium mb-1.5 ${KIND_COLOURS[kind] ?? KIND_COLOURS.thing}`}>{kind} · {group.length}</span>
                  <div className="flex flex-wrap gap-1.5">
                    {group.map(n => (
                      <span key={n.entity_id} className="px-2 py-1 rounded-lg text-xs bg-artha-text/5 border border-white/5 text-artha-muted">{n.name}</span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Relations as adjacency list */}
          {visibleEdges.length > 0 && (
            <div>
              <p className="text-xs uppercase tracking-wide text-artha-subtle mb-2">Relations ({visibleEdges.length})</p>
              <div className="space-y-1">
                {visibleEdges.map(e => (
                  <div key={e.relation_id} className="flex items-center gap-2 text-sm text-artha-muted font-mono">
                    <span className="text-artha-text">{byId.get(e.src_id)?.name ?? '?'}</span>
                    <span className="text-artha-accent">—[{e.rel_type}]→</span>
                    <span className="text-artha-text">{byId.get(e.dst_id)?.name ?? '?'}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </>
  );
}
