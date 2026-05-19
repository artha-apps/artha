/**
 * HandoffBanner — appears over the browser pane when the agent calls
 * `browser_request_user`. Shows the reason, gives the user direct control
 * of the page, and a big "Resume" button to hand the wheel back.
 */
import { Hand, X, ChevronRight } from 'lucide-react';
import { useBrowserStore } from '../../stores/browser';

export default function HandoffBanner() {
  const { state } = useBrowserStore();
  const handoff = state.awaitingHandoff;
  if (!handoff) return null;

  const resume = () => window.artha.browser.resumeAgent();
  const cancel = () => window.artha.browser.cancelHandoff();

  return (
    <div className="absolute top-2 left-2 right-2 z-10 rounded-lg bg-amber-500/10 backdrop-blur border border-amber-500/40 shadow-lg">
      <div className="flex items-center gap-3 px-3 py-2.5">
        <div className="w-7 h-7 rounded-full bg-amber-500/20 border border-amber-500/40 flex items-center justify-center shrink-0">
          <Hand size={13} className="text-amber-300" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-xs font-semibold text-amber-200 mb-0.5">
            Agent needs your help
          </p>
          <p className="text-xs text-amber-100/80 truncate">{handoff.reason}</p>
        </div>
        <button
          onClick={resume}
          className="flex items-center gap-1 px-3 py-1.5 rounded-md bg-amber-500 hover:bg-amber-400 text-amber-950 text-xs font-semibold transition-colors"
        >
          Resume <ChevronRight size={12} />
        </button>
        <button
          onClick={cancel}
          title="Cancel"
          className="p-1.5 rounded-md text-amber-300/70 hover:text-amber-200 hover:bg-amber-500/10 transition-colors"
        >
          <X size={12} />
        </button>
      </div>
    </div>
  );
}
