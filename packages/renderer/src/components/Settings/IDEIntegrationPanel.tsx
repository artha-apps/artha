/**
 * IDEIntegrationPanel — generate MCP config files for VS Code and Cursor.
 *
 * Writes .vscode/mcp.json or .cursor/mcp.json into the user's project
 * folder so that Copilot Chat / Cursor can talk to Artha's local MCP server.
 */
import { useEffect, useState } from 'react';
import { Code2, CheckCircle2, FolderOpen, Zap, Info } from 'lucide-react';
import { FeatureGuide } from '../ui/FeatureGuide';
import { GUIDES } from './guides';

type IDE = 'vscode' | 'cursor';

const IDE_OPTIONS: { id: IDE; label: string; configPath: string; description: string }[] = [
  {
    id: 'vscode',
    label: 'VS Code',
    configPath: '.vscode/mcp.json',
    description: 'Works with GitHub Copilot Chat (requires VS Code ≥ 1.99)',
  },
  {
    id: 'cursor',
    label: 'Cursor',
    configPath: '.cursor/mcp.json',
    description: 'Works with Cursor\'s built-in agent mode',
  },
];

/**
 * IDE Integration panel — generates the editor-side MCP config file and starts
 * the local MCP HTTP bridge that VS Code / Cursor connect to. The bridge exposes
 * all of Artha's tools (filesystem, web, docs, RAG, memory) over HTTP/MCP so the
 * editor's AI agent can call them without running Artha itself.
 */
export default function IDEIntegrationPanel() {
  // ── State ──────────────────────────────────────────────────────────────────
  const [selectedIde, setSelectedIde] = useState<IDE>('vscode');
  // Port that the MCP bridge listens on — written into the generated config file.
  const [port, setPort]               = useState(3847);
  const [generatedPath, setGeneratedPath] = useState<string | null>(null);
  const [busy, setBusy]               = useState(false);
  const [error, setError]             = useState<string | null>(null);
  const [serverRunning, setServerRunning] = useState(false);
  const [serverUrl, setServerUrl]     = useState('http://localhost:3847/mcp');

  // Ensure the local MCP bridge is up the moment this panel mounts — the
  // generated editor configs are useless without a live server on the port.
  useEffect(() => {
    window.artha.ide.startMcpServer()
      .then(({ running, url }) => { setServerRunning(running); if (url) setServerUrl(url); })
      .catch(() => setServerRunning(false));
  }, []);

  // ── Handlers ───────────────────────────────────────────────────────────────

  /** Open a folder picker, then write the IDE config file into that project. */
  async function handleGenerate() {
    setBusy(true);
    setError(null);
    setGeneratedPath(null);
    try {
      const result = await window.artha.ide.pickProjectAndGenerate(selectedIde, port);
      if (result) setGeneratedPath(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const selectedOption = IDE_OPTIONS.find(o => o.id === selectedIde)!;

  // Config file content shown as a preview before the user clicks Generate.
  const configPreview = JSON.stringify({
    mcpServers: {
      artha: {
        url: `http://localhost:${port}/mcp`,
        description: 'Artha local AI agent — filesystem, web, docs, RAG, memory tools',
      },
    },
  }, null, 2);

  return (
    <div className="flex flex-col h-full p-6 overflow-y-auto">
      <FeatureGuide {...GUIDES.ide} />
      {/* Header */}
      <div className="flex items-center gap-3 mb-6">
        <Code2 size={22} className="text-artha-accent" />
        <div className="flex-1">
          <h2 className="text-lg font-semibold text-artha-text">IDE Integration</h2>
          <p className="text-sm text-artha-muted">Connect VS Code or Cursor to Artha's local MCP server</p>
        </div>
      </div>

      {/* MCP server status — the bridge the generated configs talk to */}
      <div className="flex items-center gap-3 p-3 mb-6 rounded-lg bg-artha-text/5 border border-artha-border">
        <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${
          serverRunning ? 'bg-artha-success shadow-[0_0_6px_rgba(74,222,128,0.7)]' : 'bg-artha-muted'
        }`} />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-artha-text">
            MCP server {serverRunning ? 'running' : 'stopped'}
          </p>
          <p className="text-xs text-artha-muted font-mono break-all">{serverUrl}</p>
        </div>
      </div>

      {/* How it works */}
      <div className="flex items-start gap-3 p-3 mb-6 rounded-lg bg-artha-accent/10 border border-artha-accent/20">
        <Info size={16} className="text-artha-accent mt-0.5 flex-shrink-0" />
        <p className="text-xs text-artha-accent leading-relaxed">
          Artha exposes its tools (filesystem, web search, docs generation, RAG, memory) over a local
          MCP HTTP server. Generating a config file tells your editor where to find it — after that,
          the editor's AI agent can call Artha's tools directly alongside its own.
        </p>
      </div>

      {/* IDE selector */}
      <div className="mb-6">
        <label className="block text-sm font-medium text-artha-muted mb-2">Editor</label>
        <div className="grid grid-cols-2 gap-3">
          {IDE_OPTIONS.map(opt => (
            <button
              key={opt.id}
              onClick={() => { setSelectedIde(opt.id); setGeneratedPath(null); }}
              className={`p-4 rounded-xl border text-left transition-colors ${
                selectedIde === opt.id
                  ? 'border-artha-accent/60 bg-artha-accent/10'
                  : 'border-artha-border bg-artha-text/5 hover:bg-artha-text/8'
              }`}
            >
              <p className="text-sm font-semibold text-artha-text">{opt.label}</p>
              <p className="text-xs text-artha-muted mt-1">{opt.description}</p>
              <p className="text-xs text-artha-subtle mt-2 font-mono">{opt.configPath}</p>
            </button>
          ))}
        </div>
      </div>

      {/* Port */}
      <div className="mb-6">
        <label className="block text-sm font-medium text-artha-muted mb-2">MCP server port</label>
        <input
          type="number"
          value={port}
          min={1024}
          max={65535}
          onChange={e => setPort(Number(e.target.value))}
          className="w-32 px-3 py-2 rounded-lg bg-artha-text/5 border border-artha-border text-artha-text text-sm focus:outline-none focus:border-artha-accent/50"
        />
        <p className="text-xs text-artha-subtle mt-1">Default: 3847. Change only if another service uses this port.</p>
      </div>

      {/* Config preview */}
      <div className="mb-6">
        <label className="block text-sm font-medium text-artha-muted mb-2">
          Preview — <span className="text-artha-subtle font-mono">{selectedOption.configPath}</span>
        </label>
        <pre className="p-4 rounded-xl bg-black/40 border border-artha-border text-xs text-artha-success font-mono overflow-x-auto">
          {configPreview}
        </pre>
      </div>

      {/* Generate button */}
      <button
        onClick={handleGenerate}
        disabled={busy}
        className="flex items-center gap-2 px-4 py-3 rounded-xl bg-artha-accent hover:bg-artha-accent-hover disabled:bg-artha-accent/40 disabled:cursor-not-allowed text-artha-on-accent text-sm font-medium transition-colors self-start"
      >
        <FolderOpen size={16} />
        {busy ? 'Generating…' : 'Choose project folder & generate'}
      </button>

      {/* Success */}
      {generatedPath && (
        <div className="flex items-start gap-3 p-4 mt-4 rounded-xl bg-artha-success/10 border border-artha-success/20">
          <CheckCircle2 size={18} className="text-artha-success flex-shrink-0 mt-0.5" />
          <div>
            <p className="text-sm font-medium text-artha-success">Config generated</p>
            <p className="text-xs text-artha-success/70 font-mono mt-1 break-all">{generatedPath}</p>
            <p className="text-xs text-artha-success/70 mt-2">
              The file has been revealed in Finder. Restart {selectedOption.label} and the Artha MCP
              server will appear in the editor's agent tool list.
            </p>
          </div>
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="p-4 mt-4 rounded-xl bg-artha-danger/10 border border-artha-danger/20">
          <p className="text-sm text-artha-danger">{error}</p>
        </div>
      )}

      {/* Quick-start steps */}
      <div className="mt-8">
        <h3 className="text-sm font-semibold text-artha-muted mb-3 flex items-center gap-2">
          <Zap size={14} className="text-yellow-400" />
          After generating
        </h3>
        <ol className="space-y-2 text-sm text-artha-muted">
          <li className="flex gap-2"><span className="text-artha-subtle font-mono">1.</span> Make sure Artha is running (it starts the MCP server automatically).</li>
          <li className="flex gap-2"><span className="text-artha-subtle font-mono">2.</span> Open your project in {selectedOption.label}.</li>
          <li className="flex gap-2"><span className="text-artha-subtle font-mono">3.</span> Open the agent chat panel — Artha tools will appear in the tool list.</li>
          <li className="flex gap-2"><span className="text-artha-subtle font-mono">4.</span> Ask the agent to "move all screenshots to a Screenshots folder" and watch it use Artha's filesystem tools.</li>
        </ol>
      </div>
    </div>
  );
}
