/**
 * BrowserToolbar — slim chrome above the BrowserView. Back / forward /
 * reload, an editable URL bar, and the wheel-mode indicator (agent vs user).
 */
import { useEffect, useState } from 'react';
import {
  ArrowLeft, ArrowRight, RotateCw, X, Hand, Bot, Loader2,
} from 'lucide-react';
import { useBrowserStore } from '../../stores/browser';
import { Tooltip } from '../ui/Tooltip';

/** Props for BrowserToolbar. `onClose` is called when the user clicks the × to
 *  collapse the entire BrowserPane back to the ExecutionLog column. */
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

  // Toggle between the two driving modes:
  //   'agent' → user calls takeWheel() to take manual control.
  //   'user'  → user calls resumeAgent() to hand control back to the agent.
  // Main's BrowserController tracks this and suppresses agent actions while the
  // user has the wheel.
  const wheelToggle = () => {
    if (state.drivingMode === 'agent') {
      void window.artha.browser.takeWheel();
    } else {
      void window.artha.browser.resumeAgent();
    }
  };

  const userHasWheel = state.drivingMode === 'user';

  return (
    <div className="flex items-center gap-1.5 px-2 py-1.5 bg-artha-surface2 border-b border-artha-border">
      {/* Back / forward / reload / stop */}
      <Tooltip content="Back">
        <button
          onClick={() => window.artha.browser.back()}
          disabled={!state.canGoBack}
          className="p-1.5 rounded-md text-artha-muted hover:text-artha-text hover:bg-artha-text/5 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
        >
          <ArrowLeft size={13} />
        </button>
      </Tooltip>
      <Tooltip content="Forward">
        <button
          onClick={() => window.artha.browser.forward()}
          disabled={!state.canGoForward}
          className="p-1.5 rounded-md text-artha-muted hover:text-artha-text hover:bg-artha-text/5 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
        >
          <ArrowRight size={13} />
        </button>
      </Tooltip>
      {state.isLoading ? (
        <Tooltip content="Stop loading">
          <button
            onClick={() => window.artha.browser.stop()}
            className="p-1.5 rounded-md text-artha-muted hover:text-artha-text hover:bg-artha-text/5 transition-colors"
          >
            <Loader2 size={13} className="animate-spin" />
          </button>
        </Tooltip>
      ) : (
        <Tooltip content="Reload this page">
          <button
            onClick={() => window.artha.browser.reload()}
            className="p-1.5 rounded-md text-artha-muted hover:text-artha-text hover:bg-artha-text/5 transition-colors"
          >
            <RotateCw size={13} />
          </button>
        </Tooltip>
      )}

      {/* URL bar */}
      <input
        value={urlInput}
        onChange={e => setUrlInput(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') submit(); }}
        placeholder="Enter a URL…"
        spellCheck={false}
        className="flex-1 mx-1.5 px-2 py-1 rounded-md bg-artha-surface border border-artha-border text-[11px] font-mono text-artha-text placeholder-artha-subtle focus:border-artha-accent focus:outline-none transition-colors truncate"
      />

      {/* Wheel mode toggle */}
      <Tooltip content={userHasWheel ? 'Give the wheel back to the agent' : 'Take the wheel yourself'}>
        <button
          onClick={wheelToggle}
          className={`flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium transition-colors
            ${userHasWheel
              ? 'bg-amber-100 text-amber-800 border border-amber-300 hover:bg-amber-200'
              : 'bg-artha-accent/10 text-artha-accent border border-artha-accent/30 hover:bg-artha-accent/15'}`}
        >
          {userHasWheel ? <Hand size={11} /> : <Bot size={11} />}
          {userHasWheel ? 'You' : 'Agent'}
        </button>
      </Tooltip>

      {/* Close pane */}
      <Tooltip content="Close browser pane">
        <button
          onClick={onClose}
          className="p-1.5 rounded-md text-artha-muted hover:text-artha-text hover:bg-artha-text/5 transition-colors"
        >
          <X size={13} />
        </button>
      </Tooltip>
    </div>
  );
}
