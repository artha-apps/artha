/**
 * BrowserController — the singleton that owns the agent's browser surface.
 *
 * Architecture: we use Electron's own Chromium via a BrowserView attached to
 * the main window. That gives the user a *real* page (no screenshot
 * streaming) and turns "hand the agent the wheel" into a literal click —
 * the agent and the user share one webContents.
 *
 * Driving mode is a simple latch: when the user takes the wheel, every
 * agent-issued tool returns an error until they release it. There's also a
 * deferred-promise "handoff" channel used by `browser_request_user` — the
 * orchestrator awaits it and the user resolves it from the UI.
 */
import { BrowserView, BrowserWindow } from 'electron';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import { decideCrashAction, recoveryTarget } from './recovery';

/** Pixel rect (in renderer-window coordinates) where the BrowserView should
 *  be positioned. The renderer measures its pane and pushes these via IPC. */
export interface BrowserBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Who's currently allowed to drive the page. Switches via the driving-mode
 *  latch + handoff promise; consulted by `assertAgentMayAct`. */
export type DrivingMode = 'agent' | 'user';

/** Snapshot pushed to the renderer on every state change. `awaitingHandoff`
 *  is non-null while `browser_request_user` is waiting on the user. */
export interface BrowserState {
  attached: boolean;
  url: string;
  title: string;
  canGoBack: boolean;
  canGoForward: boolean;
  isLoading: boolean;
  drivingMode: DrivingMode;
  awaitingHandoff: { reason: string; since: number } | null;
  /** Non-null while the page's renderer process has crashed and a single
   *  silent auto-reload didn't bring it back — the pane shows a recovery
   *  overlay and the user retries via `recover()`. */
  crashed: { reason: string; since: number } | null;
}

/** Synthetic landing page rendered into the BrowserView before the agent
 *  navigates anywhere — gives the user something to look at and explains how
 *  the surface is meant to be driven. Served from a data: URL so there's no
 *  network dependency on first open. */
const ABOUT_BLANK = 'about:blank';

/** The Artha brand mark (mandala अ), inlined as a base64 data URI so the home
 *  page stays self-contained — a `data:` URL has no base, so it can't reference
 *  the renderer's `/logo-mark.png`. Read once at module load from the bundled
 *  renderer asset (same dir main.ts loads `index.html` from). If the file can't
 *  be read, we fall back to the Devanagari अ glyph so the page never breaks. */
const BRAND_MARK = (() => {
  try {
    const png = fs.readFileSync(path.join(__dirname, '../../../renderer/dist/logo-mark.png'));
    const uri = `data:image/png;base64,${png.toString('base64')}`;
    return `<img class="mark" src="${uri}" alt="Artha" width="56" height="56" />`;
  } catch {
    // Brand fallback — the अ glyph, not the old diya placeholder.
    return `<div class="glyph">अ</div>`;
  }
})();

const HOME_HTML = `
  <!doctype html><html><head><meta charset="utf-8"><title>Artha Browser</title>
  <style>
    html,body{margin:0;padding:0;height:100%;font-family:-apple-system,system-ui,sans-serif;
      background:#0f1117;color:#9ba1ad;display:flex;align-items:center;justify-content:center}
    .card{text-align:center;max-width:420px;padding:32px}
    .mark{margin-bottom:14px;border-radius:12px}
    .glyph{font-size:48px;line-height:1;color:#e6e8ec;margin-bottom:14px;font-weight:600}
    h1{font-size:15px;color:#e6e8ec;font-weight:600;margin:0 0 6px}
    p{font-size:13px;line-height:1.55;margin:0}
    code{background:#1a1d24;color:#7fb4ff;padding:2px 6px;border-radius:4px;font-size:12px}
  </style></head>
  <body><div class="card">
    ${BRAND_MARK}
    <h1>Artha Browser</h1>
    <p>Ready. Ask the agent to look something up, or paste a URL above.<br/>
    Run <code>web_search</code> + <code>browser_navigate</code> to start.</p>
  </div></body></html>
`;

export class BrowserController extends EventEmitter {
  private static instance: BrowserController | null = null;

  private window: BrowserWindow | null = null;
  private view: BrowserView | null = null;
  private attached = false;
  private drivingMode: DrivingMode = 'agent';
  private pendingHandoff: {
    reason: string;
    since: number;
    resolve: (value: 'resumed' | 'cancelled') => void;
  } | null = null;
  private bounds: BrowserBounds = { x: 0, y: 0, width: 0, height: 0 };
  /** Last real (non-data:) URL the view navigated to — the target a crash
   *  recovery re-navigates to. */
  private lastUrl: string = ABOUT_BLANK;
  /** Set when the renderer process is gone and auto-recovery has been
   *  exhausted; cleared once a navigation succeeds. */
  private crashed: { reason: string; since: number } | null = null;
  /** Timestamp of the last silent auto-reload, so a crash that recurs
   *  immediately surfaces the manual overlay instead of looping forever. */
  private lastAutoRecoverAt = 0;

  /** Return the process-wide singleton, creating it on first call. */
  static getInstance(): BrowserController {
    if (!BrowserController.instance) BrowserController.instance = new BrowserController();
    return BrowserController.instance;
  }

  /** Called once from main.ts after the BrowserWindow is created. */
  bindWindow(window: BrowserWindow): void {
    this.window = window;
    // Lazily create the underlying BrowserView so memory only goes to it once
    // the user actually opens the browser pane.
  }

  private ensureView(): BrowserView {
    if (this.view) return this.view;
    if (!this.window) throw new Error('BrowserController: window not bound yet');

    this.view = new BrowserView({
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        // No preload — this is the *open web* surface, not the trusted UI.
      },
    });

    const wc = this.view.webContents;

    // Mirror state changes to anyone listening (the IPC layer pipes these to
    // the renderer so the pane toolbar / URL bar stay in sync).
    wc.on('did-navigate', (_e, url) => {
      // Remember the last real destination so crash recovery can return to it.
      if (url && !url.startsWith('data:') && url !== ABOUT_BLANK) this.lastUrl = url;
      // A successful navigation means the renderer is healthy again.
      if (this.crashed) this.crashed = null;
      this.emitState();
    });
    wc.on('did-navigate-in-page', () => this.emitState());
    wc.on('did-start-loading', () => this.emitState());
    wc.on('did-stop-loading', () => this.emitState());
    wc.on('page-title-updated', () => this.emitState());

    // Crash recovery: a BrowserView whose renderer process dies leaves a blank
    // pane forever unless we react. Try one silent reload (most GPU/OOM
    // crashes recover cleanly); if it dies again right away, stop looping and
    // surface a recovery overlay the user can retry from.
    wc.on('render-process-gone', (_e, details) => {
      // 'clean-exit' is normal teardown (e.g. app quit) — not a crash.
      if (details?.reason === 'clean-exit') return;
      const reason = details?.reason ?? 'crashed';
      const now = Date.now();
      if (decideCrashAction(now, this.lastAutoRecoverAt) === 'auto-reload') {
        this.lastAutoRecoverAt = now;
        this.crashed = null;
        this.reloadLast();
        this.emitState();
        return;
      }
      // Crashed again within the window of an auto-reload → don't crashloop.
      this.crashed = { reason, since: now };
      this.emitState();
    });

    // Block window.open from spinning up new Electron BrowserWindows; force
    // them into the agent's view so the screenshot/state model stays sane.
    wc.setWindowOpenHandler(({ url }) => {
      void wc.loadURL(url);
      return { action: 'deny' };
    });

    void wc.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(HOME_HTML)}`);
    return this.view;
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────
  // attach/detach/setBounds are driven by the renderer's BrowserPane component
  // as it mounts/unmounts and resizes. Coordinates come straight from
  // getBoundingClientRect() on the pane container.

  /** Attach the BrowserView to the window and position it at `bounds`. Safe to
   *  call repeatedly — only adds the view once, then just updates the bounds. */
  attach(bounds: BrowserBounds): void {
    if (!this.window) return;
    const view = this.ensureView();
    if (!this.attached) {
      this.window.setBrowserView(view);
      this.attached = true;
    }
    this.setBounds(bounds);
    this.emitState();
  }

  /** Remove the BrowserView from the window (hides it) without destroying it,
   *  so re-attaching later is instant (no page reload). */
  detach(): void {
    if (!this.window || !this.view) return;
    if (this.attached) {
      this.window.setBrowserView(null);
      this.attached = false;
      this.emitState();
    }
  }

  /** Update the BrowserView's pixel rect. Coordinates are rounded to integers
   *  because Electron's setBounds rejects fractional pixels. */
  setBounds(bounds: BrowserBounds): void {
    this.bounds = bounds;
    if (this.view && this.attached) {
      this.view.setBounds({
        x: Math.round(bounds.x),
        y: Math.round(bounds.y),
        width: Math.round(bounds.width),
        height: Math.round(bounds.height),
      });
    }
  }

  // ── Driving mode ──────────────────────────────────────────────────────────

  /** Switch the driving-mode latch and broadcast the new state to the renderer.
   *  No-op if the mode is already set, avoiding a spurious state event. */
  setDrivingMode(mode: DrivingMode): void {
    if (this.drivingMode === mode) return;
    this.drivingMode = mode;
    this.emitState();
  }

  /** Return who currently holds the wheel without mutating anything. */
  getDrivingMode(): DrivingMode {
    return this.drivingMode;
  }

  /** Throws if the agent is not allowed to act right now. Every browser_*
   *  tool calls this before doing anything. */
  assertAgentMayAct(): void {
    if (this.drivingMode === 'user') {
      throw new Error(
        'The user currently has the wheel. Call browser_request_user or wait — ' +
        'the user must hand control back before you can act.'
      );
    }
  }

  // ── Handoff (request_user / resume) ───────────────────────────────────────

  /** Called by `browser_request_user`. Resolves when the user clicks Resume
   *  (or rejects if they cancel). Only one handoff can be pending at a time. */
  requestUser(reason: string): Promise<'resumed' | 'cancelled'> {
    if (this.pendingHandoff) {
      // A second concurrent request is almost certainly a bug; reject the old
      // one and accept the new so the orchestrator doesn't deadlock.
      this.pendingHandoff.resolve('cancelled');
      this.pendingHandoff = null;
    }
    this.setDrivingMode('user');
    return new Promise<'resumed' | 'cancelled'>((resolve) => {
      this.pendingHandoff = { reason, since: Date.now(), resolve };
      this.emitState();
    });
  }

  /** Called from the UI when the user hands control back. Resolves the pending
   *  handoff promise and switches the driving mode back to `agent`. */
  resumeAgent(): void {
    if (this.pendingHandoff) {
      this.pendingHandoff.resolve('resumed');
      this.pendingHandoff = null;
    }
    this.setDrivingMode('agent');
  }

  /** Called when the user dismisses the handoff request without resuming.
   *  Resolves the pending promise with `'cancelled'` and keeps driving mode as
   *  `user` — the agent must not act until the user explicitly resumes it. */
  cancelHandoff(): void {
    if (this.pendingHandoff) {
      this.pendingHandoff.resolve('cancelled');
      this.pendingHandoff = null;
    }
    // Stay in user mode — user explicitly cancelled, agent shouldn't barge in.
    this.emitState();
  }

  // ── Crash recovery ─────────────────────────────────────────────────────────

  /** Re-navigate to the last real URL (or the home page if there isn't one).
   *  Used by both the silent auto-reload and the manual recover() path. */
  private reloadLast(): void {
    const wc = this.view?.webContents;
    if (!wc) return;
    const home = `data:text/html;charset=utf-8,${encodeURIComponent(HOME_HTML)}`;
    void wc.loadURL(recoveryTarget(this.lastUrl, ABOUT_BLANK, home));
  }

  /** Called from the renderer's recovery overlay. Clears the crashed latch and
   *  reloads, resetting the auto-recover window so the next reload is allowed
   *  to retry silently again. */
  recover(): void {
    this.crashed = null;
    this.lastAutoRecoverAt = 0;
    this.reloadLast();
    this.emitState();
  }

  // ── Accessors ─────────────────────────────────────────────────────────────

  /** Returns the live webContents — used by the action helpers. Throws if the
   *  view hasn't been created yet (someone tried to drive before attaching). */
  getWebContents(): Electron.WebContents {
    const view = this.ensureView();
    return view.webContents;
  }

  /** Snapshot current state for the IPC layer to forward to the renderer. */
  getState(): BrowserState {
    const wc = this.view?.webContents;
    return {
      attached: this.attached,
      url: wc?.getURL() ?? ABOUT_BLANK,
      title: wc?.getTitle() ?? '',
      canGoBack: wc?.canGoBack() ?? false,
      canGoForward: wc?.canGoForward() ?? false,
      isLoading: wc?.isLoading() ?? false,
      drivingMode: this.drivingMode,
      awaitingHandoff: this.pendingHandoff
        ? { reason: this.pendingHandoff.reason, since: this.pendingHandoff.since }
        : null,
      crashed: this.crashed,
    };
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private emitState(): void {
    this.emit('state', this.getState());
  }

  /** Force-destroy the view (called on app quit). */
  async destroy(): Promise<void> {
    this.detach();
    if (this.view) {
      // Electron 29 has no destroy(); just drop the reference and let GC.
      this.view = null;
    }
  }
}
