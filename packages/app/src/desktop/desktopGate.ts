/**
 * Desktop action gate — the single check every grant-gated desktop action
 * passes through before it touches the real cursor or keyboard.
 *
 *   resolve target app → check grant → (ask the user | skip if unattended) → proceed?
 *
 * Side effects (app resolution, the confirmation prompt, the clock) are
 * injected so the decision flow is unit-tested without Electron or nut-js.
 */
import {
  type AppGrantStore, type GrantAnswer, GRANT_GATED_DESKTOP_TOOLS,
  checkAppGrant, applyGrantAnswer,
} from './appGrants';

/** Collaborators the gate needs. */
export interface DesktopGateDeps {
  store: AppGrantStore;
  /** The app the action will land in, or null if it can't be resolved. For
   *  desktop_open_app this is the app being opened; otherwise the frontmost app. */
  resolveApp(toolName: string, args: Record<string, unknown>): Promise<string | null>;
  /** Show "Allow Artha to control {App}?" and wait for the answer. */
  confirm(req: { appName: string; alwaysAllowed: boolean; reason: string }): Promise<GrantAnswer>;
  nowSec(): number;
}

/** Per-call context from the running loop. */
export interface DesktopGateContext {
  toolName: string;
  args: Record<string, unknown>;
  sessionId: string;
  projectId: string | null;
  unattended: boolean;
}

/** Gate verdict. `status` maps directly onto the receipt status. */
export type DesktopGateResult =
  | { proceed: true; appName: string | null }
  | { proceed: false; status: 'blocked' | 'skipped'; appName: string; message: string };

/** Run the grant check for one desktop action. Never throws: a failure to
 *  resolve the app is treated as an unknown app (which always asks). */
export async function gateDesktopAction(deps: DesktopGateDeps, ctx: DesktopGateContext): Promise<DesktopGateResult> {
  if (!GRANT_GATED_DESKTOP_TOOLS.has(ctx.toolName)) return { proceed: true, appName: null };

  let appName: string | null = null;
  try { appName = await deps.resolveApp(ctx.toolName, ctx.args); } catch { appName = null; }

  const decision = checkAppGrant(deps.store, {
    appName, sessionId: ctx.sessionId, projectId: ctx.projectId,
    unattended: ctx.unattended, nowSec: deps.nowSec(),
  });

  if (decision.kind === 'allow') return { proceed: true, appName: decision.appName };
  if (decision.kind === 'skip') {
    return {
      proceed: false, status: 'skipped', appName: decision.appName,
      message: `Skipped: ${ctx.toolName} was not run because ${decision.reason}. Report this to the user; do not claim the step was done.`,
    };
  }

  const answer = await deps.confirm({
    appName: decision.appName, alwaysAllowed: decision.alwaysAllowed, reason: decision.reason,
  });
  const ok = applyGrantAnswer(deps.store, answer, {
    appName: decision.appName, sessionId: ctx.sessionId, projectId: ctx.projectId, nowSec: deps.nowSec(),
  });
  if (!ok) {
    return {
      proceed: false, status: 'blocked', appName: decision.appName,
      message: `Error: The user did not allow Artha to control ${decision.appName}, so ${ctx.toolName} was not run. Do not retry it in that app — continue with the rest of the task or ask how they'd like to proceed.`,
    };
  }
  return { proceed: true, appName: decision.appName };
}
