/**
 * Keep-awake while the agent is working.
 *
 * A long run (a folder reorganisation, a multi-step research task) dies if the
 * machine sleeps halfway. When the user opts in (`keepAwakeWhileRunning`,
 * default OFF) Artha holds an Electron `powerSaveBlocker` of type
 * 'prevent-app-suspension' for as long as ANY run is active, and releases it
 * the moment the last run ends. On battery the blocker is only held when
 * `keepAwakeOnBattery` is also on (default OFF) — draining a laptop overnight
 * is a worse failure than an interrupted run, which the resume offer covers.
 *
 * The controller is pure (dependencies injected) so the lifecycle is unit
 * tested without Electron; `installKeepAwake()` wires the real modules.
 */

/** The slice of Electron's powerSaveBlocker this module uses. */
export interface PowerSaveBlockerLike {
  start(type: 'prevent-app-suspension' | 'prevent-display-sleep'): number;
  stop(id: number): void;
}

/** The two user settings that govern the blocker. */
export interface KeepAwakeSettings {
  keepAwakeWhileRunning: boolean;
  keepAwakeOnBattery: boolean;
}

/** Everything the controller needs from the outside world. */
export interface KeepAwakeDeps {
  blocker: PowerSaveBlockerLike;
  /** Current power source; re-evaluated on every refresh. */
  onBattery: () => boolean;
  /** Current settings; re-read on every refresh so a toggle applies live. */
  settings: () => KeepAwakeSettings;
  log?: (msg: string) => void;
}

/** Tracks active runs and holds/releases the blocker to match. */
export class KeepAwakeController {
  private active = new Set<symbol>();
  private blockerId: number | null = null;

  constructor(private deps: KeepAwakeDeps) {}

  /** Mark a run as started. Returns a token to pass to runEnded — tokens (not
   *  run ids) so nested/child loops sharing an id are counted correctly. */
  runStarted(label = 'run'): symbol {
    const token = Symbol(label);
    this.active.add(token);
    this.refresh();
    return token;
  }

  /** Mark a run as finished (idempotent per token). */
  runEnded(token: symbol): void {
    this.active.delete(token);
    this.refresh();
  }

  /** Number of runs currently active. */
  get activeRuns(): number { return this.active.size; }

  /** Whether the blocker is currently held. */
  get holding(): boolean { return this.blockerId !== null; }

  /** Reconcile the blocker with (active runs, settings, power source). Called
   *  on every lifecycle change, settings change, and AC/battery switch. */
  refresh(): void {
    let want = false;
    if (this.active.size > 0) {
      let s: KeepAwakeSettings = { keepAwakeWhileRunning: false, keepAwakeOnBattery: false };
      try { s = this.deps.settings(); } catch { /* unreadable settings → off */ }
      let battery = false;
      try { battery = this.deps.onBattery(); } catch { /* unknown → treat as AC */ }
      want = s.keepAwakeWhileRunning && (!battery || s.keepAwakeOnBattery);
    }
    try {
      if (want && this.blockerId === null) {
        this.blockerId = this.deps.blocker.start('prevent-app-suspension');
        this.deps.log?.('[Artha] keep-awake: holding (agent run active)');
      } else if (!want && this.blockerId !== null) {
        this.deps.blocker.stop(this.blockerId);
        this.blockerId = null;
        this.deps.log?.('[Artha] keep-awake: released');
      }
    } catch (err) {
      this.deps.log?.(`[Artha] keep-awake failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/** Process-wide controller; null until installKeepAwake() runs (tests and
 *  pre-ready code paths then simply don't hold a blocker). */
let controller: KeepAwakeController | null = null;

/** Set (or clear) the process-wide controller. */
export function setKeepAwakeController(c: KeepAwakeController | null): void {
  controller = c;
}

/** Orchestrator hook: a run loop started. */
export function noteRunStarted(label?: string): symbol | null {
  return controller ? controller.runStarted(label) : null;
}

/** Orchestrator hook: a run loop ended. */
export function noteRunEnded(token: symbol | null): void {
  if (token && controller) controller.runEnded(token);
}

/** Re-evaluate after a settings change (Settings toggle IPC). */
export function refreshKeepAwake(): void {
  controller?.refresh();
}

/** Parse the two settings out of the users.settings_json blob. Both default
 *  to false when absent or malformed. */
export function readKeepAwakeSettings(settingsJson: string | null | undefined): KeepAwakeSettings {
  try {
    const s = JSON.parse(settingsJson ?? '{}') as Record<string, unknown>;
    return { keepAwakeWhileRunning: s.keepAwakeWhileRunning === true, keepAwakeOnBattery: s.keepAwakeOnBattery === true };
  } catch {
    return { keepAwakeWhileRunning: false, keepAwakeOnBattery: false };
  }
}

/**
 * Wire the controller to real Electron (main process, after app ready).
 * `readSettingsJson` returns the users.settings_json blob.
 */
export async function installKeepAwake(readSettingsJson: () => string | null | undefined): Promise<KeepAwakeController> {
  const { powerSaveBlocker, powerMonitor } = await import('electron');
  const c = new KeepAwakeController({
    blocker: powerSaveBlocker,
    onBattery: () => {
      const pm = powerMonitor as unknown as { isOnBatteryPower?: () => boolean; onBatteryPower?: boolean };
      return typeof pm.isOnBatteryPower === 'function' ? pm.isOnBatteryPower() : !!pm.onBatteryPower;
    },
    settings: () => readKeepAwakeSettings(readSettingsJson()),
    log: (m) => console.log(m),
  });
  // Power-source switches change whether the blocker should be held.
  try {
    powerMonitor.on('on-battery', () => c.refresh());
    powerMonitor.on('on-ac', () => c.refresh());
  } catch { /* powerMonitor unavailable on this platform */ }
  setKeepAwakeController(c);
  return c;
}
