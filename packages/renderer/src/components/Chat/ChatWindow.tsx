/**
 * ChatWindow — the centre panel. Renders the conversation thread, the
 * "thinking" / streaming bubble, and the composer. Two modes:
 *   - Empty (no session OR session with no messages): render suggested prompts
 *   - Active: render message bubbles + inline tool events + citations
 *
 * Owns one piece of cross-component UI state: the browser toggle in the
 * composer (the globe button). It only flips `useBrowserStore.isOpen` —
 * App.tsx watches that flag and mounts BrowserPane when true.
 *
 * All other state lives in the Zustand chat store; this component is
 * presentational beyond that toggle and the input.
 */
import { useEffect, useRef, useState } from 'react';
import { Send, Square, Bot, Zap, Copy, Check, Globe, Sparkles, Paperclip, FileText, X, Mic, MicOff, Loader, CheckCircle2, Folder, FolderPlus, FilePlus2, RefreshCw } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import { useChatStore } from '../../stores/chat';
import { useBrowserStore } from '../../stores/browser';
import ToolCallInline from './ToolCallInline';
import Citations from './Citations';
import { Tooltip } from '../ui/Tooltip';

/** First-run hints shown on the empty state and the new-session screen. */
const SUGGESTED_PROMPTS = [
  { icon: '📁', text: 'Organize my Desktop by file type' },
  { icon: '🔍', text: 'Find all PDFs in my Documents folder' },
  { icon: '🗂️', text: 'Move all screenshots to a Screenshots folder' },
  { icon: '📝', text: 'List all files modified today' },
  { icon: '🧹', text: 'Clean up my Downloads folder' },
  { icon: '💾', text: "Show what's taking up space on my Desktop" },
];

/** Fenced-code renderer with a hover-revealed copy button. Separated out so
 *  we can keep `mdComponents` declarative below. */
function CodeBlock({ children }: { children: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard.writeText(children);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return (
    <div className="relative group my-2">
      <pre className="bg-artha-surface2 border border-artha-border rounded-lg p-3 text-xs font-mono overflow-x-auto text-artha-text/90 leading-relaxed">
        <code>{children}</code>
      </pre>
      <button
        onClick={copy}
        className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity p-1 rounded bg-artha-surface border border-artha-border hover:border-artha-accent text-artha-muted"
      >
        {copied ? <Check size={11} /> : <Copy size={11} />}
      </button>
    </div>
  );
}

/** Custom react-markdown element overrides — keeps headings/links/lists on
 *  brand and routes fenced code through `CodeBlock`. The `any` casts come
 *  from react-markdown's loose `Components` typing. */
const mdComponents = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  code({ className, children }: any) {
    const isBlock = className?.includes('language-') || String(children).includes('\n');
    return isBlock
      ? <CodeBlock>{String(children).replace(/\n$/, '')}</CodeBlock>
      : <code className="bg-artha-surface2 px-1.5 py-0.5 rounded text-xs font-mono text-artha-accent">{children}</code>;
  },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  p({ children }: any) { return <p className="mb-2 last:mb-0 leading-relaxed">{children}</p>; },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ul({ children }: any) { return <ul className="list-disc pl-4 space-y-0.5 mb-2">{children}</ul>; },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ol({ children }: any) { return <ol className="list-decimal pl-4 space-y-0.5 mb-2">{children}</ol>; },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  li({ children }: any) { return <li className="leading-relaxed">{children}</li>; },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  strong({ children }: any) { return <strong className="font-semibold text-artha-text">{children}</strong>; },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  blockquote({ children }: any) {
    return <blockquote className="border-l-2 border-artha-accent pl-3 text-artha-muted my-2">{children}</blockquote>;
  },
};

/** Minimal shape of an enabled skill, for the composer slash-menu. */
interface SkillOption {
  skill_id: string;
  slug: string;
  name: string;
  description: string;
  icon: string;
}

export default function ChatWindow() {
  const {
    messages, streamingContent, isStreaming, activeSessionId,
    addUserMessage, activeWorkflowId, setStreaming, pendingCitations, activeSkill,
    pendingAttachments, setPendingAttachments, scopes, setScopes,
  } = useChatStore();
  const [scopeBusy, setScopeBusy] = useState(false);
  const [reindexingScope, setReindexingScope] = useState<string | null>(null);
  const { isOpen: isBrowserOpen, setOpen: setBrowserOpen } = useBrowserStore();
  const [input, setInput] = useState('');
  const [skills, setSkills] = useState<SkillOption[]>([]);
  const [ragIndexes, setRagIndexes] = useState<{ name: string; doc_count: number }[]>([]);
  const [slashIndex, setSlashIndex] = useState(0);
  const [isListening, setIsListening] = useState(false);
  const [popplerWarning, setPopplerWarning] = useState(false);
  // Parallel sub-agent run indicator: the sub-task prompts + which have finished.
  const [parallelTasks, setParallelTasks] = useState<string[] | null>(null);
  const [parallelDone, setParallelDone] = useState<Set<number>>(new Set());
  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const recognitionRef = useRef<any>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, streamingContent]);

  // Load enabled skills once for the "/" slash-menu in the composer.
  useEffect(() => {
    window.artha.skills.listEnabled().then((s) => setSkills(s as SkillOption[]));
  }, []);

  // Parallel sub-agent run: show a row of badges that flip to checkmarks as
  // each concurrent sub-task reports back.
  useEffect(() => {
    const offStart = window.artha.agent.onParallelStart(({ subTasks }) => {
      setParallelTasks(subTasks);
      setParallelDone(new Set());
    });
    const offDone = window.artha.agent.onParallelTaskDone(({ index }) => {
      setParallelDone((prev) => new Set(prev).add(index));
    });
    return () => { offStart(); offDone(); };
  }, []);

  // Clear the indicator once the run is no longer streaming.
  useEffect(() => {
    if (!isStreaming) setParallelTasks(null);
  }, [isStreaming]);

  // Load RAG index status so the composer can tell the user whether /ask has
  // anything to search. Refreshes when a run finishes (indexes may have changed
  // via the RAG panel between turns).
  useEffect(() => {
    window.artha.rag
      .listIndexes()
      .then((r) => setRagIndexes(r as { name: string; doc_count: number }[]))
      .catch(() => setRagIndexes([]));
  }, [isStreaming]);
  // Total number of indexed chunks across all RAG indexes — shown in the status pill.
  const ragChunks = ragIndexes.reduce((n, i) => n + (i.doc_count ?? 0), 0);

  // The slash-menu is open when the entire input is "/…" with no space — i.e.
  // the user hasn't started the actual prompt yet. The capture group is the
  // partial slug; an empty capture ("/" alone) shows all skills.
  const slashMatch = input.match(/^\/([a-z0-9-]*)$/i);
  const slashQuery = slashMatch ? slashMatch[1].toLowerCase() : null;
  const slashResults = slashQuery !== null
    ? skills.filter(s => s.slug.includes(slashQuery) || s.name.toLowerCase().includes(slashQuery))
    : [];
  const showSlash = slashQuery !== null && slashResults.length > 0;

  const pickSkill = (s: SkillOption) => {
    setInput(`/${s.slug} `);
    setSlashIndex(0);
    textareaRef.current?.focus();
  };

  const autoResize = (el: HTMLTextAreaElement) => {
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 160) + 'px';
  };

  const handleInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value);
    autoResize(e.target);
  };

  /** Submit either typed input or a suggested-prompt click. Optimistically
   *  flips `isStreaming` so the spinner appears before the first agent token
   *  arrives — small UX win on slow models. */
  const send = async (text?: string) => {
    const msg = (text ?? input).trim();
    if (!msg || !activeSessionId || isStreaming) return;
    // Stop any active voice recognition before sending.
    if (isListening) { recognitionRef.current?.stop(); setIsListening(false); }
    const attachments = pendingAttachments.length ? [...pendingAttachments] : undefined;
    setInput('');
    if (textareaRef.current) textareaRef.current.style.height = 'auto';
    setPendingAttachments([]);
    setStreaming(true);
    addUserMessage(activeSessionId, msg, attachments);
    try {
      await window.artha.agent.sendMessage(activeSessionId, msg, attachments);
    } catch (err) {
      // Always reset streaming on error so the composer doesn't get stuck.
      setStreaming(false);
      console.error('[Artha] sendMessage failed:', err);
    }
  };

  const attachImage = async () => {
    const result = await window.artha.agent.pickImage();
    if (!result) return;
    setPendingAttachments([...pendingAttachments, { name: result.name, mime: result.mime, data: result.data }]);
  };

  const attachPdf = async () => {
    // PDF rendering shells out to Poppler's pdftoppm. If it's missing the picker
    // would silently fail, so surface an install hint instead of opening it.
    const { installed } = await window.artha.system.checkPoppler();
    if (!installed) {
      setPopplerWarning(true);
      return;
    }
    setPopplerWarning(false);
    const result = await window.artha.agent.pickPdf();
    if (!result) return;
    // Each rendered PDF page becomes a separate image attachment
    setPendingAttachments([...pendingAttachments, ...result.pages]);
  };

  const removeAttachment = (idx: number) => {
    setPendingAttachments(pendingAttachments.filter((_, i) => i !== idx));
  };

  // ── Per-chat scopes (folders/files the agent is aware of & sandboxed to) ──
  // Load the active session's scopes whenever it changes. setActiveSession
  // clears scopes, so this repopulates them for the opened chat.
  useEffect(() => {
    if (!activeSessionId) { setScopes([]); return; }
    window.artha.scopes.list(activeSessionId).then(setScopes).catch(() => setScopes([]));
  }, [activeSessionId, setScopes]);

  const addFolderScope = async () => {
    if (!activeSessionId || scopeBusy) return;
    setScopeBusy(true);
    try {
      const added = await window.artha.scopes.addFolder(activeSessionId);
      if (added) setScopes(await window.artha.scopes.list(activeSessionId));
    } finally {
      setScopeBusy(false);
    }
  };

  const addFileScope = async () => {
    if (!activeSessionId || scopeBusy) return;
    setScopeBusy(true);
    try {
      const added = await window.artha.scopes.addFile(activeSessionId);
      if (added?.length) setScopes(await window.artha.scopes.list(activeSessionId));
    } finally {
      setScopeBusy(false);
    }
  };

  const removeScope = async (scopeId: string) => {
    if (!activeSessionId) return;
    await window.artha.scopes.remove(scopeId);
    setScopes(await window.artha.scopes.list(activeSessionId));
  };

  const reindexScope = async (scopeId: string) => {
    setReindexingScope(scopeId);
    try {
      await window.artha.scopes.reindex(scopeId);
    } finally {
      setReindexingScope(null);
    }
  };

  const baseName = (p: string) => p.replace(/\/+$/, '').split('/').pop() || p;

  /** Toggle the microphone. Uses the browser's built-in SpeechRecognition API
   *  (Chromium — works on macOS fully on-device via Apple's speech engine).
   *  Interim results append live to the textarea; final results replace them. */
  const toggleVoice = () => {
    if (isListening) {
      recognitionRef.current?.stop();
      setIsListening(false);
      return;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const w = window as any;
    const SR: { new(): {
      lang: string; continuous: boolean; interimResults: boolean;
      start(): void; stop(): void;
      onresult: ((e: { resultIndex: number; results: { isFinal: boolean; [i: number]: { transcript: string } }[] }) => void) | null;
      onerror: (() => void) | null; onend: (() => void) | null;
    } } | undefined = w.webkitSpeechRecognition ?? w.SpeechRecognition;

    if (!SR) {
      console.warn('[Artha] SpeechRecognition not available in this environment');
      return;
    }
    const rec = new SR();
    rec.lang = 'en-US';
    rec.continuous = true;
    rec.interimResults = true;
    let baseText = input;

    rec.onresult = (e) => {
      let interim = '';
      let final = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const t = e.results[i][0].transcript;
        if (e.results[i].isFinal) final += t;
        else interim += t;
      }
      if (final) { baseText = (baseText + ' ' + final).trimStart(); }
      const display = (baseText + (interim ? ' ' + interim : '')).trimStart();
      setInput(display);
      if (textareaRef.current) {
        textareaRef.current.style.height = 'auto';
        textareaRef.current.style.height = Math.min(textareaRef.current.scrollHeight, 160) + 'px';
      }
    };
    rec.onerror = () => { setIsListening(false); };
    rec.onend   = () => { setIsListening(false); };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    recognitionRef.current = rec as any;
    rec.start();
    setIsListening(true);
  };

  /** Signal the orchestrator to abort the in-flight workflow. The UI updates
   *  when the orchestrator emits its cancellation token. */
  const stop = () => {
    if (activeWorkflowId) window.artha.agent.cancelTask(activeWorkflowId);
  };

  /** Composer keydown — when the slash-menu is open, arrows/enter/tab drive it;
   *  otherwise Enter (without shift) sends the message. */
  const onComposerKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (showSlash) {
      const max = slashResults.length - 1;
      const idx = Math.min(slashIndex, max);
      if (e.key === 'ArrowDown') { e.preventDefault(); setSlashIndex(i => Math.min(i + 1, max)); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setSlashIndex(i => Math.max(i - 1, 0)); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pickSkill(slashResults[idx]); return; }
      if (e.key === 'Escape') { e.preventDefault(); setInput(''); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  };

  const sessionMessages = messages.filter(m => m.sessionId === activeSessionId);

  // ── No session selected ─────────────────────────────────────────────────
  if (!activeSessionId) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-8 px-6">
        <div className="text-center">
          <div className="w-12 h-12 rounded-2xl bg-artha-accent/10 border border-artha-accent/30 flex items-center justify-center mx-auto mb-4">
            <Bot size={22} className="text-artha-accent" />
          </div>
          <h1 className="text-2xl font-semibold text-artha-text mb-1">Artha</h1>
          <p className="text-artha-muted text-sm">Your local AI agent. Fully private, runs on your Mac.</p>
        </div>
        <div className="grid grid-cols-2 gap-2 w-full max-w-md">
          {SUGGESTED_PROMPTS.map(({ icon, text }) => (
            <button key={text} onClick={() => send(text)}
              className="flex items-start gap-3 px-4 py-3 rounded-xl bg-artha-surface border border-artha-border hover:border-artha-accent hover:bg-artha-surface2 transition-all text-sm text-left text-artha-muted hover:text-artha-text shadow-soft">
              <span className="text-base leading-none mt-0.5 shrink-0">{icon}</span>
              <span className="leading-snug">{text}</span>
            </button>
          ))}
        </div>
      </div>
    );
  }

  // ── Active session ──────────────────────────────────────────────────────
  return (
    <div className="flex-1 flex flex-col overflow-hidden">

      {/* Messages */}
      <div className="flex-1 overflow-y-auto py-6">
        <div className="max-w-3xl mx-auto px-6 space-y-5">

          {/* Parallel sub-task progress — spinners that flip to checkmarks */}
          {parallelTasks && parallelTasks.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {parallelTasks.map((t, i) => {
                const done = parallelDone.has(i);
                return (
                  <Tooltip key={i} content={t}>
                    <div
                      className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-xs ${
                        done
                          ? 'bg-artha-success/10 border-artha-success/40 text-artha-success'
                          : 'bg-artha-surface border-artha-border text-artha-muted'
                      }`}
                    >
                      {done ? <CheckCircle2 size={12} /> : <Loader size={12} className="animate-spin" />}
                      Sub-task {i + 1}
                    </div>
                  </Tooltip>
                );
              })}
            </div>
          )}

          {/* Empty session — show prompt grid */}
          {sessionMessages.length === 0 && !isStreaming && (
            <div className="flex flex-col items-center gap-6 pt-8">
              <p className="text-artha-muted text-sm">What would you like to do?</p>
              <div className="grid grid-cols-2 gap-2 w-full max-w-md">
                {SUGGESTED_PROMPTS.map(({ icon, text }) => (
                  <button key={text} onClick={() => send(text)}
                    className="flex items-start gap-3 px-4 py-3 rounded-xl bg-artha-surface border border-artha-border hover:border-artha-accent hover:bg-artha-surface2 transition-all text-sm text-left text-artha-muted hover:text-artha-text shadow-soft">
                    <span className="text-base leading-none mt-0.5 shrink-0">{icon}</span>
                    <span className="leading-snug">{text}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Message bubbles */}
          {sessionMessages.map(msg => (
            <div key={msg.id} className={`flex gap-3 ${msg.senderType === 'user' ? 'justify-end' : 'justify-start'}`}>
              {msg.senderType === 'agent' && (
                <div className="w-7 h-7 rounded-full bg-artha-accent/10 border border-artha-accent/30 flex items-center justify-center shrink-0 mt-1">
                  <Bot size={13} className="text-artha-accent" />
                </div>
              )}
              <div className={`text-sm leading-relaxed rounded-2xl px-4 py-3
                ${msg.senderType === 'user'
                  ? 'max-w-[65%] bg-artha-accent text-white rounded-br-sm shadow-soft'
                  : 'max-w-[80%] bg-artha-surface border border-artha-border text-artha-text rounded-bl-sm shadow-soft'}`}>
                {msg.senderType === 'agent' ? (
                  <>
                    <ReactMarkdown components={mdComponents as never}>{msg.content || ''}</ReactMarkdown>
                    {msg.toolEvents && msg.toolEvents.length > 0 && (
                      <ToolCallInline events={msg.toolEvents} />
                    )}
                    {msg.citations && msg.citations.length > 0 && (
                      <Citations citations={msg.citations} />
                    )}
                  </>
                ) : (
                  <>
                    {msg.attachments && msg.attachments.length > 0 && (
                      <div className="flex flex-wrap gap-2 mb-2">
                        {msg.attachments.map((a, i) => (
                          <img
                            key={i}
                            src={`data:${a.mime};base64,${a.data}`}
                            alt={a.name}
                            title={a.name}
                            className="max-h-40 max-w-xs rounded-lg border border-white/40 object-cover"
                          />
                        ))}
                      </div>
                    )}
                    <span className="whitespace-pre-wrap">{msg.content}</span>
                  </>
                )}
              </div>
            </div>
          ))}

          {/* Streaming / thinking bubble */}
          {isStreaming && (
            <div className="flex gap-3 justify-start">
              <div className="w-7 h-7 rounded-full bg-artha-accent/10 border border-artha-accent/30 flex items-center justify-center shrink-0 mt-1">
                <Zap size={13} className="text-artha-accent animate-pulse" />
              </div>
              <div className="max-w-[80%] bg-artha-surface border border-artha-border text-artha-text rounded-2xl rounded-bl-sm px-4 py-3 text-sm leading-relaxed shadow-soft">
                {streamingContent ? (
                  <>
                    <ReactMarkdown components={mdComponents as never}>{streamingContent}</ReactMarkdown>
                    <span className="inline-block w-1.5 h-[1.1em] bg-artha-accent ml-0.5 animate-pulse rounded-sm align-middle" />
                    {pendingCitations.length > 0 && <Citations citations={pendingCitations} />}
                  </>
                ) : (
                  <span className="flex items-center gap-1 py-0.5">
                    <span className="w-1.5 h-1.5 bg-artha-muted rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                    <span className="w-1.5 h-1.5 bg-artha-muted rounded-full animate-bounce" style={{ animationDelay: '160ms' }} />
                    <span className="w-1.5 h-1.5 bg-artha-muted rounded-full animate-bounce" style={{ animationDelay: '320ms' }} />
                  </span>
                )}
              </div>
            </div>
          )}

          <div ref={bottomRef} />
        </div>
      </div>

      {/* Input */}
      <div className="px-6 pb-5 pt-2">
        <div className="max-w-3xl mx-auto relative">

          {/* Slash-command menu — lists enabled skills as the user types "/…" */}
          {showSlash && (
            <div className="absolute bottom-full mb-2 left-0 right-0 bg-artha-surface border border-artha-border rounded-xl shadow-lifted overflow-hidden z-20">
              <div className="px-3 py-1.5 text-[10px] uppercase tracking-wide text-artha-subtle border-b border-artha-border flex items-center gap-1.5">
                <Sparkles size={10} /> Skills
              </div>
              {slashResults.map((s, i) => (
                <button key={s.skill_id}
                  onMouseEnter={() => setSlashIndex(i)}
                  onClick={() => pickSkill(s)}
                  className={`w-full flex items-start gap-3 px-3 py-2 text-left transition-colors ${
                    i === Math.min(slashIndex, slashResults.length - 1) ? 'bg-artha-accent/10' : 'hover:bg-artha-surface2'
                  }`}>
                  <span className="text-base leading-none mt-0.5 shrink-0">{s.icon}</span>
                  <span className="min-w-0">
                    <span className="flex items-center gap-2">
                      <span className="text-sm text-artha-text">{s.name}</span>
                      <code className="text-[10px] text-artha-accent font-mono">/{s.slug}</code>
                    </span>
                    <span className="block text-xs text-artha-muted truncate">{s.description}</span>
                  </span>
                </button>
              ))}
            </div>
          )}

          {/* Per-chat scope chips — folders/files this chat is bound to. The
              agent is sandboxed to these; empty means full home-dir access. */}
          <div className="flex flex-wrap items-center gap-1.5 mb-2">
            {scopes.map(sc => (
              <Tooltip key={sc.scope_id} content={sc.path}>
                <span className="group flex items-center gap-1.5 pl-2 pr-1 py-1 rounded-full bg-artha-surface border border-artha-border text-xs text-artha-text">
                  {sc.kind === 'folder'
                    ? <Folder size={11} className="shrink-0 text-artha-accent" />
                    : <FileText size={11} className="shrink-0 text-artha-accent" />}
                  <span className="truncate max-w-[160px]">{baseName(sc.path)}</span>
                  {sc.kind === 'folder' && (
                    <Tooltip content="Re-index this folder">
                      <button
                        onClick={() => reindexScope(sc.scope_id)}
                        className={`text-artha-muted hover:text-artha-accent transition-colors ${reindexingScope === sc.scope_id ? '' : 'opacity-0 group-hover:opacity-100'}`}
                      >
                        <RefreshCw size={10} className={reindexingScope === sc.scope_id ? 'animate-spin' : ''} />
                      </button>
                    </Tooltip>
                  )}
                  <Tooltip content="Remove from chat">
                    <button
                      onClick={() => removeScope(sc.scope_id)}
                      className="text-artha-muted hover:text-artha-danger transition-colors"
                    >
                      <X size={11} />
                    </button>
                  </Tooltip>
                </span>
              </Tooltip>
            ))}
            <Tooltip content="Add a folder — the agent works only inside the chat's folders/files">
              <button
                onClick={addFolderScope}
                disabled={scopeBusy}
                className="flex items-center gap-1 px-2 py-1 rounded-full border border-dashed border-artha-border text-xs text-artha-muted hover:text-artha-text hover:border-artha-accent transition-colors disabled:opacity-40"
              >
                <FolderPlus size={11} /> Folder
              </button>
            </Tooltip>
            <Tooltip content="Add a file to this chat's context">
              <button
                onClick={addFileScope}
                disabled={scopeBusy}
                className="flex items-center gap-1 px-2 py-1 rounded-full border border-dashed border-artha-border text-xs text-artha-muted hover:text-artha-text hover:border-artha-accent transition-colors disabled:opacity-40"
              >
                <FilePlus2 size={11} /> File
              </button>
            </Tooltip>
          </div>

          {/* RAG index status — tells the user whether /ask has files to search */}
          {ragIndexes.length > 0 && (
            <Tooltip content={ragIndexes.map((i) => `${i.name} — ${i.doc_count ?? 0} chunks`).join('\n')}>
              <div className="flex items-center gap-1.5 mb-2 w-fit px-2.5 py-1 rounded-full bg-artha-surface border border-artha-border text-xs text-artha-muted">
                <span className="leading-none">📚</span>
                <span>
                  {ragIndexes.length} index{ragIndexes.length > 1 ? 'es' : ''} · {ragChunks} chunks —
                  type <span className="text-artha-accent font-medium">/ask</span> to search
                </span>
              </div>
            </Tooltip>
          )}

          {/* Active-skill badge — shown while a skill drives the current run */}
          {activeSkill && (
            <div className="flex items-center gap-1.5 mb-2 w-fit px-2.5 py-1 rounded-full bg-artha-accent/10 border border-artha-accent/30 text-xs text-artha-accent">
              <span className="leading-none">{activeSkill.icon}</span>
              <span className="font-medium">Skill: {activeSkill.name}</span>
            </div>
          )}

          {/* Poppler-missing warning — PDF attach needs pdftoppm installed */}
          {popplerWarning && (
            <div className="flex items-start gap-2 mb-2 px-3 py-2.5 rounded-xl bg-artha-danger/8 border border-artha-danger/30 text-sm text-artha-danger">
              <FileText size={14} className="shrink-0 mt-0.5" />
              <div className="flex-1 min-w-0">
                Poppler is required for PDF reading. Install it with:{' '}
                <code className="bg-artha-danger/12 px-1.5 py-0.5 rounded font-mono text-xs">brew install poppler</code>
              </div>
              <Tooltip content="Dismiss">
                <button
                  onClick={() => setPopplerWarning(false)}
                  className="shrink-0 text-artha-danger/70 hover:text-artha-danger transition-colors"
                >
                  <X size={13} />
                </button>
              </Tooltip>
            </div>
          )}

          {/* Pending image attachments — shown above composer */}
          {pendingAttachments.length > 0 && (
            <div className="flex flex-wrap gap-2 mb-2 px-1">
              {pendingAttachments.map((a, i) => (
                <div key={i} className="relative group">
                  <img
                    src={`data:${a.mime};base64,${a.data}`}
                    alt={a.name}
                    className="h-16 w-16 object-cover rounded-lg border border-artha-border"
                  />
                  <Tooltip content="Remove attachment">
                    <button
                      onClick={() => removeAttachment(i)}
                      className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full bg-artha-surface border border-artha-border flex items-center justify-center text-artha-muted hover:text-artha-text opacity-0 group-hover:opacity-100 transition-opacity"
                    >
                      <X size={9} />
                    </button>
                  </Tooltip>
                </div>
              ))}
            </div>
          )}

          <div className="flex items-end gap-3 bg-artha-surface border border-artha-border-strong rounded-2xl px-4 py-3 focus-within:border-artha-accent transition-colors shadow-soft">
            <textarea
              ref={textareaRef}
              value={input}
              onChange={handleInput}
              onKeyDown={onComposerKeyDown}
              placeholder="Ask Artha to do something…  (type / for skills)"
              rows={1}
              className="flex-1 bg-transparent text-sm resize-none outline-none text-artha-text placeholder-artha-subtle leading-relaxed"
              style={{ minHeight: '1.5rem', maxHeight: '10rem' }}
            />
            {/* Attach an image — opens native file dialog, adds to pendingAttachments */}
            <Tooltip content="Attach an image">
              <button
                onClick={attachImage}
                className="p-2 rounded-xl border border-artha-border text-artha-muted hover:text-artha-text hover:bg-artha-text/5 transition-colors shrink-0"
              >
                <Paperclip size={14} />
              </button>
            </Tooltip>
            {/* Attach a PDF — renders each page to an image via pdftoppm, then
                feeds the pages through the same multimodal pipeline */}
            <Tooltip content="Attach a PDF (renders pages for vision)">
              <button
                onClick={attachPdf}
                className="p-2 rounded-xl border border-artha-border text-artha-muted hover:text-artha-text hover:bg-artha-text/5 transition-colors shrink-0"
              >
                <FileText size={14} />
              </button>
            </Tooltip>
            {/* Voice input — mic button toggles speech recognition */}
            <Tooltip content={isListening ? 'Stop recording' : 'Voice input'}>
              <button
                onClick={toggleVoice}
                className={`p-2 rounded-xl border transition-colors shrink-0 ${
                  isListening
                    ? 'bg-artha-danger/12 border-artha-danger/40 text-artha-danger animate-pulse'
                    : 'border-artha-border text-artha-muted hover:text-artha-text hover:bg-artha-text/5'
                }`}
              >
                {isListening ? <MicOff size={14} /> : <Mic size={14} />}
              </button>
            </Tooltip>
            {/* Toggle the BrowserPane. Browser tools auto-open the pane via
                the `browser:autoOpen` IPC event the tool emitter pushes;
                this button is for the user-initiated case. */}
            <Tooltip content={isBrowserOpen ? 'Hide browser pane' : 'Show browser pane'}>
              <button
                onClick={() => setBrowserOpen(!isBrowserOpen)}
                className={`p-2 rounded-xl border transition-colors shrink-0
                  ${isBrowserOpen
                    ? 'bg-artha-accent/10 border-artha-accent/40 text-artha-accent'
                    : 'bg-transparent border-artha-border text-artha-muted hover:text-artha-text hover:bg-artha-text/5'}`}
              >
                <Globe size={14} />
              </button>
            </Tooltip>
            {isStreaming ? (
              <Tooltip content="Stop the agent">
                <button onClick={stop}
                  className="p-2 rounded-xl bg-artha-danger/12 hover:bg-artha-danger/20 border border-artha-danger/30 text-artha-danger transition-colors shrink-0">
                  <Square size={14} fill="currentColor" />
                </button>
              </Tooltip>
            ) : (
              <Tooltip content="Send message (⌘↩)">
                <button onClick={() => send()} disabled={!input.trim()}
                  className="p-2 rounded-xl bg-artha-accent hover:bg-artha-accent-hover text-white disabled:opacity-25 disabled:cursor-not-allowed transition-colors shrink-0">
                  <Send size={14} />
                </button>
              </Tooltip>
            )}
          </div>
          <p className="text-[11px] text-artha-subtle text-center mt-2">
            All processing happens locally · No data leaves your machine
          </p>
        </div>
      </div>
    </div>
  );
}
