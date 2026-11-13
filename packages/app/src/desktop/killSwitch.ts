/**
 * Global kill switch — one system-wide hotkey that stops everything Artha is
 * doing on the user's machine, even when Artha's window isn't focused (the
 * whole point: while the agent drives another app, the user's chat Stop button
 * may be buried or out of reach).
 *
 * The shortcut is registered only while at least one run is active and
 * unregistered when idle, so Artha never holds a global key the rest of the
 * time. Pressing it:
 *   1. cancels every active run through the normal cancel path (runs end as
 *      `cancelled` — a stop NEVER yields `completed`);
 *   2. rejects queued/in-flight desktop actions with `stopped_by_user`;
 *   3. hides the "Artha is in control" overlay;
 *   4. hands the browser driving latch back to the user;
 *   5. records a `stopped_by_user` receipt per stopped run.
 *
 * All Electron/DB side effects are injected (`KillSwitchDeps`) so the logic is
 * unit-testable without a running app.
 */

/** Default accelerator. `CommandOrControl` resolves to Ctrl on Windows/Linux;
 *  on macOS it would be ⌘, so there we bind Control explicitly — the stop key
 *  is Ctrl+Option+Shift+Period everywhere and the overlay hint ("⌃⌥⇧.") is
 *  literally true. */
export const DEFAULT_STOP_ACCELERATOR = defaultStopAccelerator(process.platform);

/** Platform-specific default (exported for tests). */
export function defaultStopAccelerator(platform: string): string {
  return platform === 'darwin' ? 'Control+Alt+Shift+.' : 'CommandOrControl+Alt+Shift+.';
}

/** Side effects the kill switch performs; wired to Electron in main.ts. */
export interface KillSwitchDeps {
  /** Register a global shortcut; returns false if the OS refused it. */
  register(accelerator: string, onPress: () => void): boolean;
  unregister(accelerator: string): void;
  /** Cancel these workflows via the existing cancel path. */
  cancelRuns(workflowIds: string[]): void;
  /** Reject queued/in-flight desktop actions; returns how many were affected. */
  rejectDesktopActions(): number;
  hideOverlay(): void;
  /** Flip the browser driving-mode latch to the user. */
  setBrowserDrivingToUser(): void;
  /** Persist a stopped_by_user receipt for one stopped run. */
  recordStopReceipt(info: { workflowId: string; actionsRejected: number; ts: number }): void;
}

/** Outcome of one trigger, returned for logging/tests. */
export interface StopReport {
  stoppedWorkflows: string[];
  actionsRejected: number;
}

/** Tracks active runs and owns the global stop shortcut's lifecycle. */
export class KillSwitch {
  /** Active workflowId → nesting count (a nested loop may reuse an id). */
  private active = new Map<string, number>();
  private registered = false;
  private accelerator: string;

  constructor(private readonly deps: KillSwitchDeps, accelerator = DEFAULT_STOP_ACCELERATOR) {
    this.accelerator = accelerator;
  }

  /** Current accelerator (used by the overlay hint). */
  get currentAccelerator(): string { return this.accelerator; }
  /** True while the global shortcut is held. */
  get isRegistered(): boolean { return this.registered; }
  /** Workflow ids currently running. */
  get activeWorkflows(): string[] { return [...this.active.keys()]; }

  /** Mark a run as started; registers the shortcut on the first active run. */
  runStarted(workflowId: string): void {
    this.active.set(workflowId, (this.active.get(workflowId) ?? 0) + 1);
    this.syncRegistration();
  }

  /** Mark a run as finished; unregisters the shortcut once idle. */
  runEnded(workflowId: string): void {
    const n = (this.active.get(workflowId) ?? 0) - 1;
    if (n > 0) this.active.set(workflowId, n); else this.active.delete(workflowId);
    this.syncRegistration();
  }

  /** Change the accelerator (settings). Re-registers if currently held.
   *  Falls back to the default when the new one can't be registered. */
  setAccelerator(accelerator: string): void {
    const next = accelerator.trim() || DEFAULT_STOP_ACCELERATOR;
    if (next === this.accelerator) return;
    const wasRegistered = this.registered;
    if (wasRegistered) { this.deps.unregister(this.accelerator); this.registered = false; }
    this.accelerator = next;
    if (wasRegistered) this.syncRegistration();
  }

  /** Stop everything now. Safe to call when idle (still clears desktop actions,
   *  the overlay and the browser latch). */
  trigger(): StopReport {
    const stoppedWorkflows = this.activeWorkflows;
    if (stoppedWorkflows.length) this.deps.cancelRuns(stoppedWorkflows);
    const actionsRejected = this.deps.rejectDesktopActions();
    this.deps.hideOverlay();
    this.deps.setBrowserDrivingToUser();
    const ts = Date.now();
    for (const workflowId of stoppedWorkflows) {
      this.deps.recordStopReceipt({ workflowId, actionsRejected, ts });
    }
    return { stoppedWorkflows, actionsRejected };
  }

  /** Hold the global shortcut iff a run is active. */
  private syncRegistration(): void {
    const want = this.active.size > 0;
    if (want && !this.registered) {
      let ok = false;
      try { ok = this.deps.register(this.accelerator, () => { this.trigger(); }); } catch { ok = false; }
      if (!ok && this.accelerator !== DEFAULT_STOP_ACCELERATOR) {
        // A custom binding the OS refused must not leave the user without a stop key.
        this.accelerator = DEFAULT_STOP_ACCELERATOR;
        try { ok = this.deps.register(this.accelerator, () => { this.trigger(); }); } catch { ok = false; }
      }
      this.registered = ok;
    } else if (!want && this.registered) {
      try { this.deps.unregister(this.accelerator); } catch { /* ignore */ }
      this.registered = false;
    }
  }
}

/** Render an accelerator as key glyphs for the overlay hint, e.g.
 *  "Control+Alt+Shift+." → "⌃⌥⇧.". CommandOrControl is ⌘ on macOS and ⌃
 *  elsewhere, matching what Electron actually binds. */
export function acceleratorHint(accelerator: string, platform: string = process.platform): string {
  const cmdOrCtrl = platform === 'darwin' ? '⌘' : '⌃';
  const glyph: Record<string, string> = {
    commandorcontrol: cmdOrCtrl, cmdorctrl: cmdOrCtrl, control: '⌃', ctrl: '⌃',
    command: '⌘', cmd: '⌘', super: '⌘', meta: '⌘',
    alt: '⌥', option: '⌥', shift: '⇧',
  };
  return accelerator.split('+').map(p => glyph[p.trim().toLowerCase()] ?? p.trim()).join('');
}

/** Pure helper used where a run would otherwise be marked completed: a run the
 *  user stopped is always `cancelled`, whatever the loop thought happened. */
export function terminalStatusAfterStop(
  proposed: 'completed' | 'failed' | 'cancelled',
  stopped: boolean,
): 'completed' | 'failed' | 'cancelled' {
  return stopped ? 'cancelled' : proposed;
}
