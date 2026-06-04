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
  /** Non-null while the page renderer crashed and auto-recovery was exhausted;
   *  drives the recovery overlay in BrowserPane. */
  crashed: { reason: string; since: number } | null;
}

/** Minimum width (px) each side of the chat|browser split may shrink to while
 *  dragging the divider — keeps both panes usable no matter how far the user
 *  drags. Shared by BrowserResizer (clamps the drag) and BrowserPane (re-clamps
 *  on window resize). */
export const MIN_BROWSER_W = 360;
export const MIN_CHAT_W = 400;
/** Default browser-pane width on first open (≈ the old hardcoded 44% on a
 *  typical window). Overridden by the persisted value once the user drags. */
const DEFAULT_BROWSER_W = 560;
const BROWSER_WIDTH_KEY = 'artha.browserWidth.v1';

/** Read the persisted browser-pane width; fall back to the default. */
function loadBrowserWidth(): number {
  if (typeof window === 'undefined') return DEFAULT_BROWSER_W;
  try {
    const raw = window.localStorage.getItem(BROWSER_WIDTH_KEY);
    const n = raw ? parseInt(raw, 10) : NaN;
    return Number.isFinite(n) && n >= MIN_BROWSER_W ? n : DEFAULT_BROWSER_W;
  } catch {
    return DEFAULT_BROWSER_W;
  }
}

function saveBrowserWidth(w: number) {
  if (typeof window === 'undefined') return;
  try { window.localStorage.setItem(BROWSER_WIDTH_KEY, String(Math.round(w))); } catch { /* non-fatal */ }
}

/** Store contract. `isOpen` is renderer-only (pane visibility); `state` is the
 *  last snapshot received from `browser:state` IPC events. `browserWidth` /
 *  `isResizing` drive the draggable chat|browser divider. */
interface BrowserStore {
  isOpen: boolean;
  state: BrowserState;
  /** Width (px) of the browser pane in the chat|browser split. Persisted so the
   *  user's preferred split survives relaunch. The chat pane flexes to fill the
   *  rest. */
  browserWidth: number;
  /** True while the user is dragging the divider. BrowserPane detaches the
   *  native BrowserView for the duration so it can't swallow the mouse-move
   *  stream (it's a separate native layer above the renderer). */
  isResizing: boolean;
  setOpen: (open: boolean) => void;
  setState: (state: BrowserState) => void;
  setBrowserWidth: (w: number) => void;
  setResizing: (resizing: boolean) => void;
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
  crashed: null,
};

export const useBrowserStore = create<BrowserStore>((set) => ({
  isOpen: false,
  state: INITIAL_STATE,
  browserWidth: loadBrowserWidth(),
  isResizing: false,
  setOpen: (isOpen) => set({ isOpen }),
  setState: (state) => set({ state }),
  setBrowserWidth: (browserWidth) => {
    saveBrowserWidth(browserWidth);
    set({ browserWidth });
  },
  setResizing: (isResizing) => set({ isResizing }),
}));
