/**
 * Browser store — Zustand. Mirrors the main-process BrowserController state
 * into the renderer so the pane / toolbar / handoff banner can render off
 * a single source of truth. `isOpen` is renderer-local (the user controls
 * whether the pane is visible), everything else is reflected from main.
 */
import { create } from 'zustand';

/** Mirror of the main-process `DrivingMode`. Duplicated rather than imported
 *  so the renderer doesn't pull a node-only type via the preload boundary. */
export type DrivingMode = 'agent' | 'user';

/** Mirror of the main-process `BrowserState` snapshot. Shape must stay in
 *  sync with `BrowserController.getState()`. */
export interface BrowserState {
  attached: boolean;
  url: string;
  title: string;
  canGoBack: boolean;
  canGoForward: boolean;
  isLoading: boolean;
  drivingMode: DrivingMode;
  awaitingHandoff: { reason: string; since: number } | null;
}

/** Store contract. `isOpen` is renderer-only (pane visibility); `state` is the
 *  last snapshot received from `browser:state` IPC events. */
interface BrowserStore {
  isOpen: boolean;
  state: BrowserState;
  setOpen: (open: boolean) => void;
  setState: (state: BrowserState) => void;
}

const INITIAL_STATE: BrowserState = {
  attached: false,
  url: 'about:blank',
  title: '',
  canGoBack: false,
  canGoForward: false,
  isLoading: false,
  drivingMode: 'agent',
  awaitingHandoff: null,
};

export const useBrowserStore = create<BrowserStore>((set) => ({
  isOpen: false,
  state: INITIAL_STATE,
  setOpen: (isOpen) => set({ isOpen }),
  setState: (state) => set({ state }),
}));
