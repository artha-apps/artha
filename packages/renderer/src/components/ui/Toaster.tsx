/**
 * Toaster — renders the toast queue as a bottom-right stack. Newest on top.
 * Each toast auto-dismisses after its `duration` (errors are sticky, duration
 * 0). Hovering pauses nothing fancy — kept deliberately simple; the value is a
 * single, consistent surface for transient feedback (see stores/toast.ts).
 *
 * Sits at z-[70] so it floats above the update/sentry banners and modals but
 * below onboarding (z-[100]).
 */
import { useEffect } from 'react';
import { CheckCircle2, AlertTriangle, XCircle, Info, X } from 'lucide-react';
import { useToastStore, type Toast, type ToastKind } from '../../stores/toast';

const ICON: Record<ToastKind, typeof Info> = {
  info: Info,
  success: CheckCircle2,
  warning: AlertTriangle,
  error: XCircle,
};

const ACCENT: Record<ToastKind, string> = {
  info: 'text-artha-accent',
  success: 'text-artha-success',
  warning: 'text-amber-500',
  error: 'text-artha-danger',
};

const BORDER: Record<ToastKind, string> = {
  info: 'border-artha-border',
  success: 'border-artha-success/40',
  warning: 'border-amber-500/40',
  error: 'border-artha-danger/40',
};

function ToastRow({ t }: { t: Toast }) {
  const dismiss = useToastStore((s) => s.dismiss);
  const Icon = ICON[t.kind];

  // Auto-dismiss timer. duration 0 = sticky (errors).
  useEffect(() => {
    if (!t.duration) return;
    const handle = window.setTimeout(() => dismiss(t.id), t.duration);
    return () => window.clearTimeout(handle);
  }, [t.id, t.duration, dismiss]);

  return (
    <div
      role="status"
      className={`pointer-events-auto w-80 flex items-start gap-3 px-4 py-3 rounded-xl bg-artha-surface border ${BORDER[t.kind]} shadow-lifted text-sm animate-scale-in`}
    >
      <Icon size={16} className={`${ACCENT[t.kind]} shrink-0 mt-0.5`} />
      <div className="flex-1 min-w-0">
        <p className="text-artha-text font-medium leading-snug break-words">{t.title}</p>
        {t.message && (
          <p className="text-artha-muted text-xs leading-snug mt-0.5 break-words">{t.message}</p>
        )}
        {t.action && (
          <button
            onClick={() => { t.action!.onClick(); dismiss(t.id); }}
            className="mt-2 px-2.5 py-1 rounded-lg bg-artha-accent hover:bg-artha-accent-hover text-artha-on-accent text-xs font-medium transition-colors active:scale-95"
          >
            {t.action.label}
          </button>
        )}
      </div>
      <button
        onClick={() => dismiss(t.id)}
        className="text-artha-muted hover:text-artha-text transition-colors shrink-0"
        aria-label="Dismiss notification"
      >
        <X size={14} />
      </button>
    </div>
  );
}

export default function Toaster() {
  const toasts = useToastStore((s) => s.toasts);
  if (toasts.length === 0) return null;
  return (
    <div className="fixed bottom-4 right-4 z-[70] flex flex-col-reverse gap-2 pointer-events-none">
      {toasts.map((t) => <ToastRow key={t.id} t={t} />)}
    </div>
  );
}
