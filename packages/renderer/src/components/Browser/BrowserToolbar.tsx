/**
 * BrowserToolbar — slim chrome above the BrowserView. Back / forward /
 * reload, an editable URL bar, and the wheel-mode indicator (agent vs user).
 */
import { useEffect, useState } from 'react';
import {
  ArrowLeft, ArrowRight, RotateCw, X, Hand, Bot, Loader2,
} from 'lucide-react';
import { useBrowserStore } from '../../stores/browser';

interface Props {
  onClose: () => void;
}

export default function BrowserToolbar({ onClose }: Props) {
  const { state } = useBrowserStore();
  const [urlInput, setUrlInput] = useState(state.url);

  // Keep input in sync with navigations the agent does
  useEffect(() => {
    setUrlInput(state.url === 'about:blank' ? '' : state.url);
  }, [state.url]);

  const submit = () => {
    const url = urlInput.trim();
    if (!url) return;
    void window.artha.browser.navigate(url);
  };

  const wheelToggle = () => {
    if (state.drivingMode === 'agent') {
      void window.artha.browser.takeWheel();
    } else {
      void window.artha.browser.resumeAgent();
    }
  };

  const userHasWheel = state.drivingMode === 'user';

  return (
    <div className="flex items-center gap-1.5 px-2 py-1.5 bg-artha-s2 border-b border-artha-border">
      {/* Back / forward / reload / stop */}
      <button
        onClick={() => window.artha.browser.back()}
        disabled={!state.canGoBack}
        title="Back"
        className="p-1.5 rounded-md text-artha-muted hover:text-white hover:bg-white/5 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
      >
        <ArrowLeft size={13} />
      </button>
      <button
        onClick={() => window.artha.browser.forward()}
        disabled={!state.canGoForward}
        title="Forward"
        className="p-1.5 rounded-md text-artha-muted hover:text-white hover:bg-white/5 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
      >
        <ArrowRight size={13} />
      </button>
      {state.isLoading ? (
        <button
          onClick={() => window.artha.browser.stop()}
          title="Stop"
          className="p-1.5 rounded-md text-artha-muted hover:text-white hover:bg-white/5 transition-colors"
        >
          <Loader2 size={13} className="animate-spin" />
        </button>
      ) : (
        <button
          onClick={() => window.artha.browser.reload()}
          title="Reload"
          className="p-1.5 rounded-md text-artha-muted hover:text-white hover:bg-white/5 transition-colors"
        >
          <RotateCw size={13} />
        </button>
      )}

      {/* URL bar */}
      <input
        value={urlInput}
        onChange={e => setUrlInput(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') submit(); }}
        placeholder="Enter a URL…"
        spellCheck={false}
        className="flex-1 mx-1.5 px-2 py-1 rounded-md bg-artha-surface border border-artha-border text-[11px] font-mono text-artha-text placeholder-artha-muted focus:border-artha-accent/40 focus:outline-none transition-colors truncate"
      />

      {/* Wheel mode toggle */}
      <button
        onClick={wheelToggle}
        title={userHasWheel ? 'Give the wheel back to the agent' : 'Take the wheel yourself'}
        className={`flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium transition-colors
          ${userHasWheel
            ? 'bg-amber-400/15 text-amber-300 border border-amber-400/30 hover:bg-amber-400/20'
            : 'bg-artha-accent/15 text-artha-accent border border-artha-accent/30 hover:bg-artha-accent/20'}`}
      >
        {userHasWheel ? <Hand size={11} /> : <Bot size={11} />}
        {userHasWheel ? 'You' : 'Agent'}
      </button>

      {/* Close pane */}
      <button
        onClick={onClose}
        title="Close browser pane"
        className="p-1.5 rounded-md text-artha-muted hover:text-white hover:bg-white/5 transition-colors"
      >
        <X size={13} />
      </button>
    </div>
  );
}
