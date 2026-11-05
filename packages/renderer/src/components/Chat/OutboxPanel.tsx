/**
 * OutboxPanel — the small queue shown above the composer when the user has
 * typed messages while Artha is working. Each item can be dragged to reorder,
 * edited inline, deleted, or used to "steer now" (injected into the live run
 * at its next tool-call boundary). The header shows pause state — notably
 * "Queue paused after cancel" — with a Pause/Resume toggle.
 *
 * Stateless apart from the inline-edit draft and drag index; all mutations go
 * through the outbox IPC and the parent re-renders from the returned snapshot.
 */
import { useState } from 'react';
import { GripVertical, Pencil, Trash2, CornerDownRight, Pause, Play, Check, X } from 'lucide-react';
import type { OutboxSnapshot } from '../../../../app/src/preload';
import { moveId, queueStatusLine } from '../../lib/outboxQueue';

interface Props {
  snapshot: OutboxSnapshot;
  /** Apply a fresh snapshot returned by an IPC call. */
  onSnapshot: (snap: OutboxSnapshot) => void;
}

export default function OutboxPanel({ snapshot, onSnapshot }: Props) {
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const status = queueStatusLine(snapshot);
  if (!status) return null;

  /** Run an outbox IPC call and apply the snapshot it returns (if any). */
  const apply = async (p: Promise<OutboxSnapshot | null>) => {
    try {
      const snap = await p;
      if (snap) onSnapshot(snap);
    } catch (err) {
      console.warn('[Artha] outbox action failed:', err);
    }
  };

  /** Drop handler: persist the new order computed from the drag. */
  const onDrop = (to: number) => {
    if (dragFrom === null) return;
    const ids = moveId(snapshot.items.map(i => i.id), dragFrom, to);
    setDragFrom(null);
    void apply(window.artha.outbox.reorder(snapshot.sessionId, ids));
  };

  /** Enter inline edit: holds the item (status 'editing') so it can't drain mid-edit. */
  const beginEdit = (id: string, content: string) => {
    setEditingId(id);
    setDraft(content);
    void apply(window.artha.outbox.edit(id, { editing: true }));
  };
  const saveEdit = (id: string) => {
    setEditingId(null);
    if (draft.trim()) void apply(window.artha.outbox.edit(id, { content: draft }));
    else void apply(window.artha.outbox.edit(id, { editing: false }));
  };
  const abandonEdit = (id: string) => {
    setEditingId(null);
    void apply(window.artha.outbox.edit(id, { editing: false }));
  };

  const btn = 'p-1 rounded-md text-artha-muted hover:text-artha-text hover:bg-artha-text/5 transition-colors disabled:opacity-30';

  return (
    <div className="mb-2 rounded-xl border border-artha-border bg-artha-surface/70 px-2.5 py-2 text-xs" aria-label="Queued messages">
      <div className="flex items-center justify-between mb-1.5 px-0.5">
        <span className={snapshot.paused ? 'text-artha-warn font-medium' : 'text-artha-subtle'}>{status}</span>
        {snapshot.paused ? (
          <button className={`${btn} inline-flex items-center gap-1`} onClick={() => void apply(window.artha.outbox.resume(snapshot.sessionId))}>
            <Play size={11} /> Resume
          </button>
        ) : (
          <button className={`${btn} inline-flex items-center gap-1`} onClick={() => void apply(window.artha.outbox.pause(snapshot.sessionId))}>
            <Pause size={11} /> Pause
          </button>
        )}
      </div>
      <ul className="flex flex-col gap-1">
        {snapshot.items.map((item, idx) => {
          const steering = snapshot.steering.includes(item.id);
          const locked = item.status === 'sending';
          return (
            <li
              key={item.id}
              draggable={!locked && editingId !== item.id}
              onDragStart={() => setDragFrom(idx)}
              onDragOver={e => e.preventDefault()}
              onDrop={() => onDrop(idx)}
              className="flex items-start gap-1.5 rounded-lg bg-artha-bg/60 border border-artha-border px-1.5 py-1"
            >
              <GripVertical size={12} className="mt-0.5 shrink-0 text-artha-subtle cursor-grab" aria-hidden />
              {editingId === item.id ? (
                <>
                  <textarea
                    autoFocus
                    value={draft}
                    onChange={e => setDraft(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); saveEdit(item.id); }
                      if (e.key === 'Escape') { e.preventDefault(); abandonEdit(item.id); }
                    }}
                    rows={2}
                    className="flex-1 bg-transparent outline-none resize-none text-artha-text"
                  />
                  <button className={btn} onClick={() => saveEdit(item.id)} aria-label="Save queued message"><Check size={12} /></button>
                  <button className={btn} onClick={() => abandonEdit(item.id)} aria-label="Cancel edit"><X size={12} /></button>
                </>
              ) : (
                <>
                  <span className="flex-1 min-w-0 truncate text-artha-text" title={item.content}>
                    {item.content}
                    {steering && <span className="ml-1.5 text-artha-accent">· steering at next step</span>}
                    {locked && <span className="ml-1.5 text-artha-subtle">· sending…</span>}
                  </span>
                  <button className={btn} disabled={locked || steering} title="Steer now — give this to Artha at its next step"
                    onClick={() => void window.artha.outbox.steer(item.id).then(r => { if (r.snapshot) onSnapshot(r.snapshot); })}
                    aria-label="Steer now"><CornerDownRight size={12} /></button>
                  <button className={btn} disabled={locked} onClick={() => beginEdit(item.id, item.content)} aria-label="Edit queued message"><Pencil size={12} /></button>
                  <button className={btn} disabled={locked} onClick={() => void apply(window.artha.outbox.cancel(item.id))} aria-label="Delete queued message"><Trash2 size={12} /></button>
                </>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
