/**
 * MCPToolsPanel — two tabs:
 *   Tools    — installed MCP servers + built-in tools, enable/disable/remove
 *   Audit Log — persistent history of every tool invocation
 */
import { useEffect, useState } from 'react';
import {
  Wrench, Plus, Trash2, ToggleLeft, ToggleRight,
  RefreshCw, Clock, CheckCircle2, XCircle, ChevronDown, ChevronRight,
  Shield, Zap,
} from 'lucide-react';

// ── Types ─────────────────────────────────────────────────────────────────────

interface MCPTool {
  tool_id: string;
  name: string;
  description: string;
  mcp_server_uri: string | null;
  is_enabled: number;
  installed_at: number;
}

interface AuditEntry {
  id: string;
  session_id: string | null;
  workflow_id: string | null;
  tool_name: string;
  args_json: string;
  result: string | null;
  duration_ms: number | null;
  status: 'ok' | 'error';
  ts: number;
}

// ── Built-in tool names (always shown, cannot be disabled via UI) ─────────────
const BUILTIN_TOOLS = [
  'fs_list_directory', 'fs_search_files', 'fs_create_directory',
  'fs_move_file', 'fs_copy_file', 'fs_read_file',
  'fs_get_file_info', 'fs_delete_file',
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function relativeTime(unixSec: number): string {
  const diff = Math.floor(Date.now() / 1000) - unixSec;
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function toolColor(name: string): string {
  if (name.startsWith('fs_')) return 'text-blue-400 bg-blue-400/10';
  return 'text-violet-400 bg-violet-400/10';
}

// ── Sub-components ────────────────────────────────────────────────────────────

function AuditRow({ entry }: { entry: AuditEntry }) {
  const [expanded, setExpanded] = useState(false);
  let args: Record<string, unknown> = {};
  try { args = JSON.parse(entry.args_json); } catch { /* ok */ }

  return (
    <div className={`rounded-xl border text-xs ${
      entry.status === 'error'
        ? 'border-red-500/20 bg-red-500/5'
        : 'border-artha-border bg-artha-surface'
    }`}>
      <button
        onClick={() => setExpanded(e => !e)}
        className="w-full flex items-center gap-3 px-3 py-2.5 text-left"
      >
        {entry.status === 'error'
          ? <XCircle size={12} className="text-red-400 shrink-0" />
          : <CheckCircle2 size={12} className="text-green-400 shrink-0" />}

        <code className={`font-mono font-medium px-1.5 py-0.5 rounded text-xs ${toolColor(entry.tool_name)}`}>
          {entry.tool_name}
        </code>

        {entry.duration_ms != null && (
          <span className="text-artha-muted">{entry.duration_ms}ms</span>
        )}

        <span className="ml-auto text-artha-muted flex items-center gap-1">
          <Clock size={10} /> {relativeTime(entry.ts)}
        </span>

        {expanded
          ? <ChevronDown size={12} className="text-artha-muted shrink-0" />
          : <ChevronRight size={12} className="text-artha-muted shrink-0" />}
      </button>

      {expanded && (
        <div className="px-3 pb-3 space-y-2 border-t border-artha-border/50 pt-2">
          {Object.keys(args).length > 0 && (
            <div>
              <p className="text-artha-muted mb-1 uppercase tracking-wide text-[10px]">Args</p>
              <pre className="font-mono text-artha-text whitespace-pre-wrap break-all">
                {JSON.stringify(args, null, 2).slice(0, 400)}
              </pre>
            </div>
          )}
          {entry.result && (
            <div>
              <p className="text-artha-muted mb-1 uppercase tracking-wide text-[10px]">Result</p>
              <pre className={`font-mono whitespace-pre-wrap break-all ${
                entry.status === 'error' ? 'text-red-400/80' : 'text-green-300/70'
              }`}>
                {entry.result.slice(0, 400)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Main panel ────────────────────────────────────────────────────────────────

export default function MCPToolsPanel() {
  const [tab, setTab] = useState<'tools' | 'audit'>('tools');
  const [tools, setTools] = useState<MCPTool[]>([]);
  const [auditLog, setAuditLog] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [addUri, setAddUri] = useState('');
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState('');

  const load = async () => {
    setLoading(true);
    try {
      const [t, a] = await Promise.all([
        window.artha.mcp.listTools() as Promise<MCPTool[]>,
        window.artha.mcp.getAuditLog(200) as Promise<AuditEntry[]>,
      ]);
      setTools(t);
      setAuditLog(a);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const toggle = async (tool: MCPTool) => {
    const next = !tool.is_enabled;
    await window.artha.mcp.toggleTool(tool.tool_id, next);
    setTools(prev => prev.map(t =>
      t.tool_id === tool.tool_id ? { ...t, is_enabled: next ? 1 : 0 } : t
    ));
  };

  const remove = async (tool: MCPTool) => {
    await window.artha.mcp.removeServer(tool.tool_id);
    setTools(prev => prev.filter(t => t.tool_id !== tool.tool_id));
  };

  const addServer = async () => {
    const uri = addUri.trim();
    if (!uri) return;
    setAdding(true);
    setAddError('');
    try {
      await window.artha.mcp.installServer(uri);
      setAddUri('');
      await load();
    } catch (err) {
      setAddError(err instanceof Error ? err.message : 'Failed to connect server');
    } finally {
      setAdding(false);
    }
  };

  const mcpTools = tools.filter(t => t.mcp_server_uri);

  return (
    <div className="flex-1 overflow-y-auto px-8 py-8 max-w-3xl mx-auto w-full">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-artha-accent/20 flex items-center justify-center">
            <Wrench size={16} className="text-artha-accent" />
          </div>
          <div>
            <h1 className="text-base font-semibold text-white">MCP Tools</h1>
            <p className="text-xs text-artha-muted">Manage tools and review execution history</p>
          </div>
        </div>
        <button onClick={load} disabled={loading}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-artha-border text-artha-muted hover:text-white hover:bg-white/5 text-xs transition-colors disabled:opacity-40">
          <RefreshCw size={12} className={loading ? 'animate-spin' : ''} /> Refresh
        </button>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 mb-6 p-1 bg-artha-s2 border border-artha-border rounded-xl w-fit">
        {(['tools', 'audit'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)}
            className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-colors capitalize
              ${tab === t ? 'bg-artha-accent/20 text-white' : 'text-artha-muted hover:text-white'}`}>
            {t === 'audit' ? 'Audit Log' : 'Tools'}
            {t === 'audit' && auditLog.length > 0 && (
              <span className="ml-1.5 text-xs bg-artha-accent/20 text-artha-accent px-1.5 py-0.5 rounded-full">
                {auditLog.length}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* ── Tools tab ── */}
      {tab === 'tools' && (
        <div className="space-y-6">
          {/* Built-in tools */}
          <section>
            <div className="flex items-center gap-2 mb-3">
              <Shield size={13} className="text-artha-accent" />
              <h2 className="text-xs font-semibold text-artha-muted uppercase tracking-wide">
                Built-in Filesystem Tools
              </h2>
              <span className="text-xs text-artha-muted">({BUILTIN_TOOLS.length})</span>
            </div>
            <div className="grid grid-cols-2 gap-2">
              {BUILTIN_TOOLS.map(name => (
                <div key={name}
                  className="flex items-center gap-2 px-3 py-2 rounded-lg bg-artha-s2 border border-artha-border">
                  <Zap size={11} className="text-blue-400 shrink-0" />
                  <code className="text-xs font-mono text-artha-text truncate">{name}</code>
                  <CheckCircle2 size={11} className="text-green-400 ml-auto shrink-0" />
                </div>
              ))}
            </div>
          </section>

          {/* MCP servers */}
          <section>
            <div className="flex items-center gap-2 mb-3">
              <Wrench size={13} className="text-artha-accent" />
              <h2 className="text-xs font-semibold text-artha-muted uppercase tracking-wide">
                MCP Servers
              </h2>
              {mcpTools.length > 0 && (
                <span className="text-xs text-artha-muted">({mcpTools.length})</span>
              )}
            </div>

            {mcpTools.length === 0 ? (
              <div className="text-center py-8 bg-artha-s2 border border-dashed border-artha-border rounded-xl">
                <Wrench size={24} className="mx-auto mb-2 text-artha-muted opacity-30" />
                <p className="text-sm text-artha-muted">No MCP servers installed</p>
                <p className="text-xs text-artha-muted mt-1">Add a server URI below to extend Artha's capabilities</p>
              </div>
            ) : (
              <div className="space-y-2">
                {mcpTools.map(tool => (
                  <div key={tool.tool_id}
                    className="flex items-center gap-3 px-4 py-3 rounded-xl bg-artha-s2 border border-artha-border">
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-white truncate">{tool.name}</p>
                      {tool.mcp_server_uri && (
                        <code className="text-xs text-artha-muted font-mono truncate block">{tool.mcp_server_uri}</code>
                      )}
                    </div>

                    {/* Toggle */}
                    <button onClick={() => toggle(tool)} title={tool.is_enabled ? 'Disable' : 'Enable'}
                      className="text-artha-muted hover:text-white transition-colors">
                      {tool.is_enabled
                        ? <ToggleRight size={20} className="text-artha-accent" />
                        : <ToggleLeft size={20} />}
                    </button>

                    {/* Remove */}
                    <button onClick={() => remove(tool)} title="Remove server"
                      className="text-artha-muted hover:text-red-400 transition-colors">
                      <Trash2 size={14} />
                    </button>
                  </div>
                ))}
              </div>
            )}

            {/* Add server */}
            <div className="mt-4 space-y-2">
              <div className="flex gap-2">
                <input
                  value={addUri}
                  onChange={e => setAddUri(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && addServer()}
                  placeholder="npx @modelcontextprotocol/server-filesystem ~/Documents"
                  className="flex-1 bg-artha-s2 border border-artha-border rounded-lg px-3 py-2 text-sm text-artha-text placeholder-artha-muted focus:border-artha-accent/50 focus:outline-none transition-colors font-mono"
                />
                <button onClick={addServer} disabled={!addUri.trim() || adding}
                  className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-artha-accent hover:bg-artha-accent/80 disabled:opacity-40 disabled:cursor-not-allowed text-sm font-medium transition-colors">
                  {adding ? <RefreshCw size={13} className="animate-spin" /> : <Plus size={13} />}
                  Add
                </button>
              </div>
              {addError && (
                <p className="text-xs text-red-400 flex items-center gap-1">
                  <XCircle size={11} /> {addError}
                </p>
              )}
              <p className="text-xs text-artha-muted">
                Any stdio MCP server — paste the full command as you'd run it in a terminal.
              </p>
            </div>
          </section>
        </div>
      )}

      {/* ── Audit Log tab ── */}
      {tab === 'audit' && (
        <div>
          {loading ? (
            <div className="space-y-2">
              {[1,2,3,4,5].map(i => (
                <div key={i} className="h-10 bg-artha-s2 border border-artha-border rounded-xl animate-pulse" />
              ))}
            </div>
          ) : auditLog.length === 0 ? (
            <div className="text-center py-16 text-artha-muted">
              <Clock size={32} className="mx-auto mb-3 opacity-30" />
              <p className="text-sm font-medium text-white mb-1">No tool invocations yet</p>
              <p className="text-xs">Every tool call Artha makes will appear here</p>
            </div>
          ) : (
            <div className="space-y-2">
              {/* Summary bar */}
              <div className="flex items-center gap-4 px-4 py-2 bg-artha-s2 border border-artha-border rounded-xl mb-4 text-xs">
                <span className="text-artha-muted">{auditLog.length} invocations</span>
                <span className="text-green-400">
                  {auditLog.filter(e => e.status === 'ok').length} ok
                </span>
                <span className="text-red-400">
                  {auditLog.filter(e => e.status === 'error').length} errors
                </span>
                {auditLog.length > 0 && auditLog[0].duration_ms != null && (
                  <span className="text-artha-muted ml-auto">
                    avg {Math.round(auditLog.slice(0,20).reduce((s,e) => s + (e.duration_ms ?? 0), 0) / Math.min(20, auditLog.length))}ms
                  </span>
                )}
              </div>

              {auditLog.map(entry => (
                <AuditRow key={entry.id} entry={entry} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
