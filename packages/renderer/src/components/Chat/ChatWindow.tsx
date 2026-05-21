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
import { Send, Square, Bot, Zap, Copy, Check, Globe, Sparkles } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import { useChatStore } from '../../stores/chat';
import { useBrowserStore } from '../../stores/browser';
import ToolCallInline from './ToolCallInline';
import Citations from './Citations';

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
      <pre className="bg-black/40 border border-white/10 rounded-lg p-3 text-xs font-mono overflow-x-auto text-green-300/80 leading-relaxed">
        <code>{children}</code>
      </pre>
      <button
        onClick={copy}
        className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity p-1 rounded bg-white/10 hover:bg-white/20 text-artha-muted"
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
      : <code className="bg-black/30 px-1.5 py-0.5 rounded text-xs font-mono text-artha-accent">{children}</code>;
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
  strong({ children }: any) { return <strong className="font-semibold text-white">{children}</strong>; },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  blockquote({ children }: any) {
    return <blockquote className="border-l-2 border-artha-accent/50 pl-3 text-artha-muted my-2">{children}</blockquote>;
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
  } = useChatStore();
  const { isOpen: isBrowserOpen, setOpen: setBrowserOpen } = useBrowserStore();
  const [input, setInput] = useState('');
  const [skills, setSkills] = useState<SkillOption[]>([]);
  const [ragIndexes, setRagIndexes] = useState<{ name: string; doc_count: number }[]>([]);
  const [slashIndex, setSlashIndex] = useState(0);
  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, streamingContent]);

  // Load enabled skills once for the "/" slash-menu in the composer.
  useEffect(() => {
    window.artha.skills.listEnabled().then((s) => setSkills(s as SkillOption[]));
  }, []);

  // Load RAG index status so the composer can tell the user whether /ask has
  // anything to search. Refreshes when a run finishes (indexes may have changed
  // via the RAG panel between turns).
  useEffect(() => {
    window.artha.rag
      .listIndexes()
      .then((r) => setRagIndexes(r as { name: string; doc_count: number }[]))
      .catch(() => setRagIndexes([]));
  }, [isStreaming]);
  const ragChunks = ragIndexes.reduce((n, i) => n + (i.doc_count ?? 0), 0);

  // The slash-menu is open when the input is a bare "/partial-slug" with no
  // space yet. We filter the enabled skills by that partial slug/name.
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
    setInput('');
    if (textareaRef.current) textareaRef.current.style.height = 'auto';
    setStreaming(true);
    addUserMessage(activeSessionId, msg);
    await window.artha.agent.sendMessage(activeSessionId, msg);
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
          <div className="w-12 h-12 rounded-2xl bg-artha-accent/20 border border-artha-accent/20 flex items-center justify-center mx-auto mb-4">
            <Bot size={22} className="text-artha-accent" />
          </div>
          <h1 className="text-2xl font-semibold text-white mb-1">Artha</h1>
          <p className="text-artha-muted text-sm">Your local AI agent. Fully private, runs on your Mac.</p>
        </div>
        <div className="grid grid-cols-2 gap-2 w-full max-w-md">
          {SUGGESTED_PROMPTS.map(({ icon, text }) => (
            <button key={text} onClick={() => send(text)}
              className="flex items-start gap-3 px-4 py-3 rounded-xl bg-artha-s2 border border-artha-border hover:border-artha-accent/40 hover:bg-white/[0.03] transition-all text-sm text-left text-artha-muted hover:text-artha-text">
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

          {/* Empty session — show prompt grid */}
          {sessionMessages.length === 0 && !isStreaming && (
            <div className="flex flex-col items-center gap-6 pt-8">
              <p className="text-artha-muted text-sm">What would you like to do?</p>
              <div className="grid grid-cols-2 gap-2 w-full max-w-md">
                {SUGGESTED_PROMPTS.map(({ icon, text }) => (
                  <button key={text} onClick={() => send(text)}
                    className="flex items-start gap-3 px-4 py-3 rounded-xl bg-artha-s2 border border-artha-border hover:border-artha-accent/40 hover:bg-white/[0.03] transition-all text-sm text-left text-artha-muted hover:text-artha-text">
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
                <div className="w-7 h-7 rounded-full bg-artha-accent/15 border border-artha-accent/25 flex items-center justify-center shrink-0 mt-1">
                  <Bot size={13} className="text-artha-accent" />
                </div>
              )}
              <div className={`text-sm leading-relaxed rounded-2xl px-4 py-3
                ${msg.senderType === 'user'
                  ? 'max-w-[65%] bg-artha-accent text-white rounded-br-sm'
                  : 'max-w-[80%] bg-artha-s2 border border-artha-border text-artha-text rounded-bl-sm'}`}>
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
                  <span className="whitespace-pre-wrap">{msg.content}</span>
                )}
              </div>
            </div>
          ))}

          {/* Streaming / thinking bubble */}
          {isStreaming && (
            <div className="flex gap-3 justify-start">
              <div className="w-7 h-7 rounded-full bg-artha-accent/15 border border-artha-accent/25 flex items-center justify-center shrink-0 mt-1">
                <Zap size={13} className="text-artha-accent animate-pulse" />
              </div>
              <div className="max-w-[80%] bg-artha-s2 border border-artha-border text-artha-text rounded-2xl rounded-bl-sm px-4 py-3 text-sm leading-relaxed">
                {streamingContent ? (
                  <>
                    <ReactMarkdown components={mdComponents as never}>{streamingContent}</ReactMarkdown>
                    <span className="inline-block w-1.5 h-[1.1em] bg-artha-accent ml-0.5 animate-pulse rounded-sm align-middle" />
                    {pendingCitations.length > 0 && <Citations citations={pendingCitations} />}
                  </>
                ) : (
                  <span className="flex items-center gap-1 py-0.5">
                    <span className="w-1.5 h-1.5 bg-artha-muted/60 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                    <span className="w-1.5 h-1.5 bg-artha-muted/60 rounded-full animate-bounce" style={{ animationDelay: '160ms' }} />
                    <span className="w-1.5 h-1.5 bg-artha-muted/60 rounded-full animate-bounce" style={{ animationDelay: '320ms' }} />
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
            <div className="absolute bottom-full mb-2 left-0 right-0 bg-artha-s2 border border-artha-border rounded-xl shadow-xl overflow-hidden z-20">
              <div className="px-3 py-1.5 text-[10px] uppercase tracking-wide text-artha-muted border-b border-artha-border flex items-center gap-1.5">
                <Sparkles size={10} /> Skills
              </div>
              {slashResults.map((s, i) => (
                <button key={s.skill_id}
                  onMouseEnter={() => setSlashIndex(i)}
                  onClick={() => pickSkill(s)}
                  className={`w-full flex items-start gap-3 px-3 py-2 text-left transition-colors ${
                    i === Math.min(slashIndex, slashResults.length - 1) ? 'bg-artha-accent/15' : 'hover:bg-white/5'
                  }`}>
                  <span className="text-base leading-none mt-0.5 shrink-0">{s.icon}</span>
                  <span className="min-w-0">
                    <span className="flex items-center gap-2">
                      <span className="text-sm text-white">{s.name}</span>
                      <code className="text-[10px] text-artha-accent font-mono">/{s.slug}</code>
                    </span>
                    <span className="block text-xs text-artha-muted truncate">{s.description}</span>
                  </span>
                </button>
              ))}
            </div>
          )}

          {/* RAG index status — tells the user whether /ask has files to search */}
          {ragIndexes.length > 0 && (
            <div
              className="flex items-center gap-1.5 mb-2 w-fit px-2.5 py-1 rounded-full bg-artha-s2 border border-artha-border text-xs text-artha-muted"
              title={ragIndexes.map((i) => `${i.name} — ${i.doc_count ?? 0} chunks`).join('\n')}
            >
              <span className="leading-none">📚</span>
              <span>
                {ragIndexes.length} index{ragIndexes.length > 1 ? 'es' : ''} · {ragChunks} chunks —
                type <span className="text-artha-accent font-medium">/ask</span> to search
              </span>
            </div>
          )}

          {/* Active-skill badge — shown while a skill drives the current run */}
          {activeSkill && (
            <div className="flex items-center gap-1.5 mb-2 w-fit px-2.5 py-1 rounded-full bg-artha-accent/15 border border-artha-accent/30 text-xs text-artha-accent">
              <span className="leading-none">{activeSkill.icon}</span>
              <span className="font-medium">Skill: {activeSkill.name}</span>
            </div>
          )}

          <div className="flex items-end gap-3 bg-artha-s2 border border-artha-border rounded-2xl px-4 py-3 focus-within:border-artha-accent/40 transition-colors shadow-lg">
            <textarea
              ref={textareaRef}
              value={input}
              onChange={handleInput}
              onKeyDown={onComposerKeyDown}
              placeholder="Ask Artha to do something…  (type / for skills)"
              rows={1}
              className="flex-1 bg-transparent text-sm resize-none outline-none text-artha-text placeholder-artha-muted leading-relaxed"
              style={{ minHeight: '1.5rem', maxHeight: '10rem' }}
            />
            {/* Toggle the BrowserPane. Browser tools auto-open the pane via
                the `browser:autoOpen` IPC event the tool emitter pushes;
                this button is for the user-initiated case. */}
            <button
              onClick={() => setBrowserOpen(!isBrowserOpen)}
              title={isBrowserOpen ? 'Hide browser pane' : 'Show browser pane'}
              className={`p-2 rounded-xl border transition-colors shrink-0
                ${isBrowserOpen
                  ? 'bg-artha-accent/20 border-artha-accent/40 text-artha-accent'
                  : 'bg-transparent border-artha-border text-artha-muted hover:text-white hover:bg-white/5'}`}
            >
              <Globe size={14} />
            </button>
            {isStreaming ? (
              <button onClick={stop} title="Stop"
                className="p-2 rounded-xl bg-red-500/20 hover:bg-red-500/30 border border-red-500/30 text-red-400 transition-colors shrink-0">
                <Square size={14} fill="currentColor" />
              </button>
            ) : (
              <button onClick={() => send()} disabled={!input.trim()}
                className="p-2 rounded-xl bg-artha-accent hover:bg-artha-accent/80 disabled:opacity-25 disabled:cursor-not-allowed transition-colors shrink-0">
                <Send size={14} />
              </button>
            )}
          </div>
          <p className="text-[11px] text-artha-muted/60 text-center mt-2">
            All processing happens locally · No data leaves your machine
          </p>
        </div>
      </div>
    </div>
  );
}
