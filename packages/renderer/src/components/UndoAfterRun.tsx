/**
 * UndoAfterRun — proactive "Artha changed N files · Undo" toast.
 *
 * The Trust feed makes file changes visible after the fact, but the moment a
 * user most wants to reverse a bad move is right after it happens. This watches
 * the run lifecycle (isStreaming true→false) and, by diffing the undo registry
 * against a baseline snapshot taken at run start, surfaces exactly THIS run's
 * reversible changes with a one-click Undo — per-run scoping without needing a
 * run-id on the registry. Renders nothing; it's a behavioural watcher.
 */
import { useEffect, useRef } from 'react';
import { useChatStore } from '../stores/chat';
import { useToastStore, toast } from '../stores/toast';

export default function UndoAfterRun() {
  const isStreaming = useChatStore(s => s.isStreaming);
  const prev = useRef(false);
  const baseline = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (isStreaming && !prev.current) {
      // Run started — snapshot the ids already reversible so we can tell this
      // run's new changes apart from earlier ones.
      window.artha.undo.list()
        .then(u => { baseline.current = new Set(u.map(x => x.id)); })
        .catch(() => { baseline.current = new Set(); });
    } else if (!isStreaming && prev.current) {
      // Run ended — anything reversible that wasn't in the baseline is from this run.
      window.artha.undo.list().then(u => {
        const fresh = u.filter(x => !baseline.current.has(x.id));
        if (fresh.length === 0) return;
        useToastStore.getState().show({
          kind: 'info',
          title: `Artha changed ${fresh.length} file${fresh.length > 1 ? 's' : ''}`,
          message: fresh[0].label + (fresh.length > 1 ? ` · +${fresh.length - 1} more` : ''),
          duration: 12000,
          action: {
            label: 'Undo',
            onClick: async () => {
              let ok = 0;
              // Newest first so nested changes unwind cleanly.
              for (const f of fresh) { if ((await window.artha.undo.revert(f.id)).ok) ok++; }
              toast.success('Undone', `${ok} change${ok === 1 ? '' : 's'} reverted`);
            },
          },
        });
      }).catch(() => { /* undo unavailable — skip */ });
    }
    prev.current = isStreaming;
  }, [isStreaming]);

  return null;
}
