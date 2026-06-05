/**
 * Toast store — Zustand. A small, composable notification queue rendered by
 * <Toaster/> (bottom-right). Replaces the previous one-off fixed banners as the
 * single place transient feedback lands: send failures, tool failures, run
 * complete, model-offline, scheduled-run results, etc.
 *
 * Designed to be callable from outside React (IPC callbacks, store actions) via
 * the `toast` helper — `toast.error(...)` works anywhere, no hook required.
 */
import { create } from 'zustand';

export type ToastKind = 'info' | 'success' | 'error' | 'warning';

/** An optional inline action — e.g. a "Retry" button on a failed send. */
export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface Toast {
  id: string;
  kind: ToastKind;
  title: string;
  message?: string;
  action?: ToastAction;
  /** Auto-dismiss after this many ms. 0 = sticky until dismissed (errors). */
  duration: number;
  createdAt: number;
}

/** What a caller passes to `show` — id/createdAt are minted internally and
 *  duration defaults by kind (errors stick, everything else auto-dismisses). */
export type ToastInput = Omit<Toast, 'id' | 'createdAt' | 'duration'> & { duration?: number };

interface ToastState {
  toasts: Toast[];
  show: (t: ToastInput) => string;
  dismiss: (id: string) => void;
  clear: () => void;
}

const DEFAULT_DURATION: Record<ToastKind, number> = {
  info: 5000,
  success: 4000,
  warning: 7000,
  error: 0, // sticky — the user must see and dismiss/act on failures
};

export const useToastStore = create<ToastState>((set) => ({
  toasts: [],
  show: (t) => {
    const id = crypto.randomUUID();
    const duration = t.duration ?? DEFAULT_DURATION[t.kind];
    set((s) => ({ toasts: [...s.toasts, { ...t, id, duration, createdAt: Date.now() }] }));
    return id;
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) })),
  clear: () => set({ toasts: [] }),
}));

/**
 * Imperative helper usable anywhere (no React context needed). Prefer this in
 * IPC callbacks and store actions; components can also just read the store.
 */
export const toast = {
  info: (title: string, message?: string) => useToastStore.getState().show({ kind: 'info', title, message }),
  success: (title: string, message?: string) => useToastStore.getState().show({ kind: 'success', title, message }),
  warning: (title: string, message?: string) => useToastStore.getState().show({ kind: 'warning', title, message }),
  error: (title: string, message?: string, action?: ToastAction) =>
    useToastStore.getState().show({ kind: 'error', title, message, action }),
  dismiss: (id: string) => useToastStore.getState().dismiss(id),
};
