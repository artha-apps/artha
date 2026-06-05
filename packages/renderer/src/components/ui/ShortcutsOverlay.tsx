/**
 * ShortcutsOverlay — a keyboard cheatsheet toggled with `?` (Shift+/). The app
 * had no shortcuts reference; this lists the global and in-composer keys. The
 * `?` listener ignores keystrokes while the user is typing in a field so it
 * never hijacks a literal question mark in the composer.
 */
import { useEffect, useState } from 'react';
import { Keyboard, X } from 'lucide-react';

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
const MOD = isMac ? '⌘' : 'Ctrl';

const GROUPS: { title: string; items: { keys: string[]; label: string }[] }[] = [
  {
    title: 'Global',
    items: [
      { keys: [MOD, 'K'], label: 'Command palette' },
      { keys: [MOD, ','], label: 'Workspace settings' },
      { keys: ['?'], label: 'This shortcuts list' },
    ],
  },
  {
    title: 'Composer',
    items: [
      { keys: ['Enter'], label: 'Send message' },
      { keys: ['Shift', 'Enter'], label: 'New line' },
      { keys: ['/'], label: 'Skills menu' },
      { keys: ['@'], label: 'Mention a project, file, or tool' },
    ],
  },
  {
    title: 'Approvals & dialogs',
    items: [
      { keys: ['Enter'], label: 'Approve / confirm' },
      { keys: ['Esc'], label: 'Cancel / deny / close' },
    ],
  },
];

/** True when focus is in a text field — so `?` types a literal char instead of
 *  opening the cheatsheet. */
function isTypingTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable;
}

function Key({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="px-1.5 py-0.5 rounded-md bg-artha-bg border border-artha-border text-[11px] font-mono text-artha-text min-w-5 text-center">
      {children}
    </kbd>
  );
}

export default function ShortcutsOverlay() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === '?' && !isTypingTarget(e.target)) {
        e.preventDefault();
        setOpen((v) => !v);
      } else if (e.key === 'Escape' && open) {
        setOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[90] flex items-center justify-center bg-artha-bg/60 backdrop-blur-md animate-fade-in"
      onClick={() => setOpen(false)}
    >
      <div
        className="w-full max-w-md mx-4 rounded-2xl border border-artha-border bg-artha-surface-raised shadow-modal overflow-hidden animate-scale-in"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-artha-border">
          <div className="flex items-center gap-2">
            <Keyboard size={16} className="text-artha-accent" />
            <p className="text-sm font-semibold text-artha-text">Keyboard shortcuts</p>
          </div>
          <button onClick={() => setOpen(false)} className="text-artha-muted hover:text-artha-text transition-colors" aria-label="Close">
            <X size={15} />
          </button>
        </div>
        <div className="px-5 py-4 space-y-4 max-h-[70vh] overflow-auto">
          {GROUPS.map((g) => (
            <div key={g.title}>
              <p className="text-[10px] uppercase tracking-wide text-artha-subtle mb-2">{g.title}</p>
              <div className="space-y-1.5">
                {g.items.map((it) => (
                  <div key={it.label} className="flex items-center justify-between gap-3">
                    <span className="text-sm text-artha-text">{it.label}</span>
                    <span className="flex items-center gap-1 shrink-0">
                      {it.keys.map((k, i) => <Key key={i}>{k}</Key>)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
