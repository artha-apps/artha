/**
 * Pending human-in-the-loop interactions the renderer is showing as inline
 * cards (currently `ask_user` questions). Fed by `interaction:pending` /
 * `interaction:resolved` events and re-hydrated from
 * `interactions:listPending` on load, so a reload never loses a question the
 * run is still waiting on. Plan/confirm re-shows go to their existing modals.
 */
import { create } from 'zustand';
import { upsertPending, removePending, type PendingInteraction } from '../lib/askCard';

interface InteractionsState {
  /** Pending ask_user cards, oldest first. */
  asks: PendingInteraction[];
  addAsk: (i: PendingInteraction) => void;
  removeInteraction: (id: string) => void;
}

export const useInteractionsStore = create<InteractionsState>((set) => ({
  asks: [],
  addAsk: (i) => set(s => ({ asks: upsertPending(s.asks, i) })),
  removeInteraction: (id) => set(s => ({ asks: removePending(s.asks, id) })),
}));
