/**
 * MemoryImport — "Bring Your Own Memory" (BYOM).
 *
 * Lets a user paste the memory export from another AI assistant (ChatGPT,
 * Claude, Gemini, …), reviews/edits the parsed entries, then commits them to
 * Artha's long-term memory so the agent "already knows" them. Reused in two
 * places: the first-run Onboarding step and Settings → Memory.
 *
 * Flow: paste → (parse / optional AI refine) → review & edit → commit → done.
 * Parsing happens in the main process (`memory.importPreview` / `importRefine`),
 * committing via `memory.import`. Nothing is written until the user confirms.
 */
import { useState } from 'react';
import {
  BrainCircuit, ClipboardCopy, Check, Sparkles, ArrowRight, ArrowLeft,
  Trash2, RotateCcw, FileInput, Loader2, PartyPopper,
} from 'lucide-react';

/** Parsed entry mirrored from the main-process ParsedEntry shape. */
interface ParsedEntry {
  name: string;
  content: string;
  entity_type: string;
  tags: string[];
  date?: string | null;
}

/** A review-row: a parsed entry plus local UI state. */
interface ReviewEntry extends ParsedEntry {
  _id: number;
  keep: boolean;
}

type SourceTool = 'chatgpt' | 'claude' | 'gemini' | 'other';

const TOOLS: { id: SourceTool; label: string }[] = [
  { id: 'chatgpt', label: 'ChatGPT' },
  { id: 'claude',  label: 'Claude' },
  { id: 'gemini',  label: 'Gemini' },
  { id: 'other',   label: 'Other' },
];

const TYPE_OPTIONS = ['fact', 'preference', 'person', 'project', 'decision', 'other'];

const TYPE_COLOURS: Record<string, string> = {
  fact:       'bg-blue-500/20 text-blue-300',
  preference: 'bg-purple-500/20 text-purple-300',
  person:     'bg-green-500/20 text-green-300',
  project:    'bg-orange-500/20 text-orange-300',
  decision:   'bg-yellow-500/20 text-yellow-300',
  other:      'bg-gray-500/20 text-gray-300',
};

/** The export prompt we hand users to run in their old assistant. Designed so
 *  its output parses deterministically (see tools/memoryImport.ts). */
const EXPORT_PROMPT = `I'm migrating to a new AI assistant and need a complete, portable export of everything you know about me. Output it in a SINGLE fenced code block using the exact skeleton below. Preserve my own words verbatim wherever possible — especially instructions and preferences. Do not summarize, merge, or omit entries.

Rules:
- One entry per line, formatted:  [YYYY-MM-DD] - entry text   (use [unknown] if no date).
- Group entries under the headers below, in this order; keep every header even if empty.
- Sort oldest-first within each header.
- IDENTITY = atomic facts, one per line (name, location, role, family, languages, interests).
- PROJECTS = one per line, lead with the project name, then what it does + status + key decisions.
- Keep the === lines exactly. Do not add commentary inside the block.

=== ARTHA MEMORY IMPORT v1 ===
[INSTRUCTIONS]
[IDENTITY]
[CAREER]
[PROJECTS]
[PREFERENCES]
[OTHER]
=== END ===

After the code block, tell me in one line whether this is the complete set of everything you have stored about me, or if anything remains.`;

interface Props {
  /** Called after a successful commit (or when the user closes the success view). */
  onDone: (result?: { created: number; skipped: number }) => void;
  /** Called when the user skips/cancels without importing. */
  onSkip?: () => void;
  /** 'onboarding' tunes copy + skip affordance; 'settings' shows a Cancel. */
  variant?: 'onboarding' | 'settings';
}

export default function MemoryImport({ onDone, onSkip, variant = 'onboarding' }: Props) {
  const [step, setStep] = useState<'paste' | 'review' | 'done'>('paste');
  const [tool, setTool] = useState<SourceTool>('chatgpt');
  const [raw, setRaw] = useState('');
  const [useAI, setUseAI] = useState(false);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [entries, setEntries] = useState<ReviewEntry[]>([]);
  const [result, setResult] = useState<{ created: number; skipped: number } | null>(null);
  const [error, setError] = useState('');

  const provenanceTag = `source:${tool}`;
  const keptCount = entries.filter(e => e.keep).length;

  async function copyPrompt() {
    try {
      await navigator.clipboard.writeText(EXPORT_PROMPT);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch { /* clipboard blocked — user can still select manually */ }
  }

  async function handleParse() {
    if (!raw.trim()) return;
    setBusy(true);
    setError('');
    try {
      const parsed = useAI
        ? await window.artha.memory.importRefine(raw, provenanceTag)
        : await window.artha.memory.importPreview(raw, provenanceTag);
      if (!parsed.length) {
        setError("Couldn't find any memories in that text. Check the format, or try \"Refine with AI\".");
        return;
      }
      setEntries(parsed.map((p, i) => ({ ...p, _id: i, keep: true })));
      setStep('review');
    } catch {
      setError('Something went wrong while parsing. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  async function handleCommit() {
    setBusy(true);
    setError('');
    try {
      const payload: ParsedEntry[] = entries
        .filter(e => e.keep && e.content.trim())
        .map(({ _id: _drop, keep: _k, ...rest }) => rest);
      const res = await window.artha.memory.import(payload, 'import');
      setResult(res);
      setStep('done');
    } catch {
      setError('Could not save these memories. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  function updateEntry(id: number, patch: Partial<ReviewEntry>) {
    setEntries(prev => prev.map(e => (e._id === id ? { ...e, ...patch } : e)));
  }

  // ── Paste step ──────────────────────────────────────────────────────────────
  if (step === 'paste') {
    return (
      <div className="flex flex-col gap-4">
        <div className="flex items-start gap-3">
          <div className="w-10 h-10 rounded-xl bg-artha-accent/15 border border-artha-accent/20 flex items-center justify-center shrink-0">
            <BrainCircuit size={20} className="text-artha-accent" />
          </div>
          <div>
            <h2 className="text-base font-semibold text-artha-text">Give Artha a head start</h2>
            <p className="text-sm text-artha-muted leading-relaxed">
              Coming from another AI? Paste what it knows about you and Artha will already
              understand your style, projects, and preferences — all stored locally.
            </p>
          </div>
        </div>

        {/* Tool selector */}
        <div className="flex items-center gap-2">
          <span className="text-xs text-artha-muted">Exporting from:</span>
          {TOOLS.map(t => (
            <button
              key={t.id}
              onClick={() => setTool(t.id)}
              className={`px-2.5 py-1 rounded-lg text-xs font-medium border transition-colors ${
                tool === t.id
                  ? 'bg-artha-accent text-white border-artha-accent'
                  : 'bg-artha-surface text-artha-muted border-artha-border hover:text-artha-text'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* Export-prompt helper */}
        <details className="rounded-xl bg-artha-surface border border-artha-border">
          <summary className="cursor-pointer px-4 py-2.5 text-xs text-artha-muted hover:text-artha-text flex items-center gap-1.5">
            <FileInput size={13} /> Don't have an export yet? Get the prompt
          </summary>
          <div className="px-4 pb-3 space-y-2">
            <p className="text-xs text-artha-muted leading-relaxed">
              Copy this, paste it into {TOOLS.find(t => t.id === tool)?.label}, then paste its reply below.
            </p>
            <pre className="max-h-40 overflow-auto text-[11px] leading-relaxed text-artha-text bg-artha-s2 border border-artha-border rounded-lg p-3 whitespace-pre-wrap font-mono">
{EXPORT_PROMPT}
            </pre>
            <button
              onClick={copyPrompt}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-artha-accent hover:bg-artha-accent/80 text-xs font-medium text-white transition-colors"
            >
              {copied ? <><Check size={13} /> Copied</> : <><ClipboardCopy size={13} /> Copy prompt</>}
            </button>
          </div>
        </details>

        {/* Paste box */}
        <textarea
          value={raw}
          onChange={e => setRaw(e.target.value)}
          placeholder="Paste your exported memories here…"
          rows={8}
          className="w-full text-sm px-3 py-2.5 rounded-xl bg-artha-surface border border-artha-border focus:border-artha-accent focus:outline-none text-artha-text resize-y font-mono leading-relaxed"
        />

        <label className="flex items-center gap-2 text-xs text-artha-muted cursor-pointer select-none">
          <input type="checkbox" checked={useAI} onChange={e => setUseAI(e.target.checked)} className="accent-artha-accent" />
          <Sparkles size={13} className="text-artha-accent" />
          Refine with AI (uses your local model — slower, handles messy formats)
        </label>

        {error && <p className="text-xs text-red-400">{error}</p>}

        <div className="flex items-center justify-between pt-1">
          <button
            onClick={() => onSkip?.()}
            className="text-xs text-artha-muted hover:text-artha-text transition-colors"
          >
            {variant === 'onboarding' ? 'Skip for now' : 'Cancel'}
          </button>
          <button
            onClick={handleParse}
            disabled={!raw.trim() || busy}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-artha-accent hover:bg-artha-accent/80 text-sm font-medium text-white transition-colors disabled:opacity-40"
          >
            {busy ? <Loader2 size={14} className="animate-spin" /> : <ArrowRight size={14} />}
            {busy ? 'Reading…' : 'Continue'}
          </button>
        </div>
      </div>
    );
  }

  // ── Review step ───────────────────────────────────────────────────────────
  if (step === 'review') {
    return (
      <div className="flex flex-col gap-4">
        <div>
          <h2 className="text-base font-semibold text-artha-text">Review what Artha will remember</h2>
          <p className="text-sm text-artha-muted">
            {keptCount} of {entries.length} selected. Edit the text, change a category, or untick anything you don't want.
          </p>
        </div>

        <div className="space-y-2 max-h-[42vh] overflow-y-auto pr-1">
          {entries.map(e => (
            <div
              key={e._id}
              className={`flex items-start gap-3 p-3 rounded-xl border transition-colors ${
                e.keep
                  ? 'bg-artha-text/5 border-white/5'
                  : 'bg-transparent border-artha-border opacity-50'
              }`}
            >
              <input
                type="checkbox"
                checked={e.keep}
                onChange={ev => updateEntry(e._id, { keep: ev.target.checked })}
                className="mt-1.5 accent-artha-accent shrink-0"
              />
              <div className="flex-1 min-w-0 space-y-1.5">
                <textarea
                  value={e.content}
                  onChange={ev => updateEntry(e._id, { content: ev.target.value })}
                  rows={1}
                  className="w-full text-sm px-2 py-1 rounded-lg bg-artha-surface border border-artha-border focus:border-artha-accent focus:outline-none text-artha-text resize-y leading-relaxed"
                />
                <div className="flex items-center gap-2">
                  <select
                    value={e.entity_type}
                    onChange={ev => updateEntry(e._id, { entity_type: ev.target.value })}
                    className={`px-2 py-0.5 rounded-full text-xs font-medium border-0 focus:outline-none cursor-pointer ${
                      TYPE_COLOURS[e.entity_type] ?? TYPE_COLOURS.other
                    }`}
                  >
                    {TYPE_OPTIONS.map(t => <option key={t} value={t}>{t}</option>)}
                  </select>
                  {e.date && <span className="text-[11px] text-artha-subtle">{e.date}</span>}
                </div>
              </div>
              <button
                onClick={() => updateEntry(e._id, { keep: false })}
                className="p-1.5 rounded-lg text-artha-subtle hover:bg-red-500/20 hover:text-red-400 transition-colors shrink-0"
                title="Drop this entry"
              >
                <Trash2 size={14} />
              </button>
            </div>
          ))}
        </div>

        {error && <p className="text-xs text-red-400">{error}</p>}

        <div className="flex items-center justify-between pt-1">
          <button
            onClick={() => { setStep('paste'); setError(''); }}
            className="inline-flex items-center gap-1.5 text-xs text-artha-muted hover:text-artha-text transition-colors"
          >
            <ArrowLeft size={13} /> Back
          </button>
          <button
            onClick={handleCommit}
            disabled={keptCount === 0 || busy}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-artha-accent hover:bg-artha-accent/80 text-sm font-medium text-white transition-colors disabled:opacity-40"
          >
            {busy ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
            Add {keptCount} {keptCount === 1 ? 'memory' : 'memories'} to Artha
          </button>
        </div>
      </div>
    );
  }

  // ── Done step ───────────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col items-center text-center gap-3 py-4">
      <div className="w-12 h-12 rounded-2xl bg-green-500/15 border border-green-500/20 flex items-center justify-center">
        <PartyPopper size={24} className="text-green-400" />
      </div>
      <h2 className="text-base font-semibold text-artha-text">Artha now knows you</h2>
      <p className="text-sm text-artha-muted max-w-sm">
        Added {result?.created ?? 0} {(result?.created ?? 0) === 1 ? 'memory' : 'memories'}.
        {result?.skipped ? ` ${result.skipped} duplicate${result.skipped === 1 ? '' : 's'} skipped.` : ''}{' '}
        These are stored locally and surface automatically in future conversations.
      </p>
      <div className="flex items-center gap-2 pt-1">
        <button
          onClick={() => { setRaw(''); setEntries([]); setResult(null); setStep('paste'); }}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs text-artha-muted hover:text-artha-text border border-artha-border hover:bg-white/5 transition-colors"
        >
          <RotateCcw size={13} /> Import more
        </button>
        <button
          onClick={() => onDone(result ?? undefined)}
          className="px-4 py-2 rounded-lg bg-artha-accent hover:bg-artha-accent/80 text-sm font-medium text-white transition-colors"
        >
          Done
        </button>
      </div>
    </div>
  );
}
