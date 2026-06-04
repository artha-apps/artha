/**
 * ClarificationModal — pre-flight Q&A before the agent starts planning.
 *
 * When the orchestrator's detectClarificationNeeded() returns questions it
 * pauses the ReAct loop and emits `agent:clarifyRequest`. This modal catches
 * that event (via the Zustand store), shows the questions to the user, and
 * sends answers (or null for "skip") back via `agent:clarifyRespond`.
 *
 * Design mirrors PlanApproval: it floats above the chat, dims the background,
 * and is keyboard-accessible (Enter on last field submits, Escape skips).
 */
import { useState, useEffect, useRef } from 'react';
import { HelpCircle, ArrowRight, SkipForward } from 'lucide-react';
import { useChatStore } from '../../stores/chat';

export default function ClarificationModal() {
  const { pendingClarify, setPendingClarify, setStreaming } = useChatStore();
  const [answers, setAnswers] = useState<string[]>([]);
  const firstRef = useRef<HTMLInputElement>(null);

  // Reset answer fields whenever a new clarification request arrives.
  useEffect(() => {
    if (pendingClarify) {
      setAnswers(pendingClarify.questions.map(() => ''));
      // Small delay lets the modal paint before we steal focus.
      setTimeout(() => firstRef.current?.focus(), 80);
    }
  }, [pendingClarify]);

  if (!pendingClarify) return null;

  const { workflowId, questions } = pendingClarify;

  const submit = () => {
    // Send whatever the user typed — empty strings are fine (the orchestrator
    // treats them as "not answered" and proceeds with the original goal).
    window.artha.agent.clarifyRespond(workflowId, answers);
    setPendingClarify(null);
    setStreaming(true);
  };

  const skip = () => {
    // null = skip entirely; orchestrator proceeds with original goal immediately.
    window.artha.agent.clarifyRespond(workflowId, null);
    setPendingClarify(null);
    setStreaming(true);
  };

  const handleKey = (e: React.KeyboardEvent, idx: number) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      // Move to next field, or submit on the last one.
      if (idx < questions.length - 1) {
        const next = document.getElementById(`clarify-answer-${idx + 1}`) as HTMLInputElement | null;
        next?.focus();
      } else {
        submit();
      }
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      skip();
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-artha-bg/60 backdrop-blur-md animate-fade-in">
      <div className="w-full max-w-lg mx-4 rounded-2xl border border-artha-border bg-artha-surface-raised shadow-modal overflow-hidden animate-scale-in">

        {/* Header */}
        <div className="flex items-start gap-3 px-5 pt-5 pb-4 border-b border-artha-border">
          <div className="w-8 h-8 rounded-xl bg-artha-accent/10 border border-artha-accent/30 flex items-center justify-center shrink-0 mt-0.5">
            <HelpCircle size={15} className="text-artha-accent" />
          </div>
          <div>
            <p className="text-sm font-semibold text-artha-text">A few quick questions</p>
            <p className="text-xs text-artha-muted mt-0.5">
              Answering helps the agent plan better. You can skip if you prefer.
            </p>
          </div>
        </div>

        {/* Goal preview */}
        <div className="px-5 pt-4">
          <p className="text-xs text-artha-muted mb-3 line-clamp-2">
            <span className="text-artha-subtle font-medium">Goal: </span>
            {pendingClarify.goal}
          </p>
        </div>

        {/* Questions */}
        <div className="px-5 pb-4 space-y-4">
          {questions.map((q, i) => (
            <div key={i} className="space-y-1.5">
              <label className="block text-xs font-medium text-artha-muted">
                <span className="text-artha-accent mr-1.5">{i + 1}.</span>{q}
              </label>
              <input
                id={`clarify-answer-${i}`}
                ref={i === 0 ? firstRef : undefined}
                type="text"
                value={answers[i] ?? ''}
                onChange={e => setAnswers(prev => prev.map((a, j) => j === i ? e.target.value : a))}
                onKeyDown={e => handleKey(e, i)}
                placeholder="Your answer…"
                className="w-full bg-artha-bg border border-artha-border rounded-lg px-3 py-2 text-sm text-artha-text placeholder-artha-subtle focus:outline-none focus:border-artha-accent transition-colors"
              />
            </div>
          ))}
        </div>

        {/* Actions */}
        <div className="flex items-center justify-between px-5 py-4 border-t border-artha-border">
          <button
            onClick={skip}
            className="flex items-center gap-1.5 text-xs text-artha-muted hover:text-artha-text transition-colors"
          >
            <SkipForward size={13} />
            Skip and proceed
          </button>
          <button
            onClick={submit}
            className="flex items-center gap-2 px-4 py-2 rounded-lg bg-artha-accent hover:bg-artha-accent-hover hover:shadow-glow-sm text-white text-sm font-medium transition-all duration-200 active:scale-95"
          >
            Continue
            <ArrowRight size={14} />
          </button>
        </div>
      </div>
    </div>
  );
}
