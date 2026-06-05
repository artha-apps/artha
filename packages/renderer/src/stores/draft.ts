/**
 * Draft hand-off store — a tiny channel for pre-filling a form in one surface
 * from an action in another, without threading props or bloating the chat store.
 *
 * Current use: "Save as Workflow" on a past run stashes a scheduler prefill here,
 * then jumps to Workflows ▸ Scheduled, where SchedulerPanel consumes it on mount.
 */
import { create } from 'zustand';

export interface SchedulerPrefill {
  name: string;
  prompt: string;
}

interface DraftState {
  schedulerPrefill: SchedulerPrefill | null;
  setSchedulerPrefill: (d: SchedulerPrefill | null) => void;
}

export const useDraftStore = create<DraftState>((set) => ({
  schedulerPrefill: null,
  setSchedulerPrefill: (d) => set({ schedulerPrefill: d }),
}));
