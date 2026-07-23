/**
 * Built-in Browser Tools — gives Artha hands on a real Chromium tab.
 *
 * Backed by BrowserController (Electron's own webContents). The tools below
 * are the verbs the LLM uses to read and act on web pages. Every call:
 *   1. asserts the agent currently has the wheel
 *   2. forwards to actions.ts helpers
 *   3. emits a citation for the current URL so the chat picks it up
 *
 * The single soft-pause primitive — `browser_request_user` — yields control
 * to a human (login, captcha, 2FA), waits on the controller's deferred
 * promise, and reports back whether the user resumed or cancelled.
 */
import OpenAI from 'openai';
import { BrowserController } from '../browser/controller';
import {
  back, click, forward, getUrl, navigate, readDom,
  reload, screenshot, typeInto, waitForSelector,
} from '../browser/actions';
import { recordCitation, allowedLocalHosts } from './web';
import { assertPublicURL } from '../net/ssrfGuard';

// ── Tool schemas (OpenAI function format) ────────────────────────────────────

export const BROWSER_TOOL_SCHEMAS: OpenAI.ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'browser_navigate',
      description:
        'Open a URL in the agent browser. Opens the visible browser pane if it is closed. ' +
        'Use this for any page the user must SEE (auth flows, SPAs, dynamic content) — for ' +
        'simple article reads, prefer web_fetch.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Absolute or scheme-less URL (https:// added if missing).' },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_click',
      description:
        'Click an element in the browser. Selector is a CSS selector OR "text=Some label" ' +
        'to match by visible text. Auto-scrolls into view.',
      parameters: {
        type: 'object',
        properties: {
          selector: { type: 'string', description: 'CSS or "text=…" pseudo-selector.' },
        },
        required: ['selector'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_type',
      description: 'Type text into an input / textarea / contenteditable. Optionally press Enter to submit.',
      parameters: {
        type: 'object',
        properties: {
          selector: { type: 'string', description: 'CSS selector for the field.' },
          text: { type: 'string', description: 'Text to type.' },
          submit: { type: 'boolean', description: 'If true, press Enter after typing.' },
        },
        required: ['selector', 'text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_wait_for',
      description: 'Wait until a selector exists on the page (used after navigations that load async). Default timeout 8s.',
      parameters: {
        type: 'object',
        properties: {
          selector: { type: 'string' },
          timeout_ms: { type: 'number', description: 'Optional, defaults to 8000.' },
        },
        required: ['selector'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_read_dom',
      description:
        'Read visible text from the current page (or a specific element). Returns up to 12k chars ' +
        'of cleaned text — use selector to narrow down to a specific region.',
      parameters: {
        type: 'object',
        properties: {
          selector: { type: 'string', description: 'Optional CSS selector to read.' },
          max_chars: { type: 'number', description: 'Truncate output. Default 12000.' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_screenshot',
      description:
        'Capture a screenshot of the current visible viewport. Returns a base64 PNG. Use sparingly — ' +
        'prefer browser_read_dom for text. Useful for visual confirmation or vision models.',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_get_url',
      description: 'Return the current URL and page title.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_back',
      description: 'Navigate back in browser history.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_forward',
      description: 'Navigate forward in browser history.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_reload',
      description: 'Reload the current page.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_request_user',
      description:
        'Hand the wheel to the human. Call this when the page needs a login, a captcha, a 2FA code, ' +
        'a paywall click, or any other thing the agent cannot do safely. The user will see your ' +
        'reason in a banner and can complete the action manually, then resume the agent. ' +
        'Returns "resumed" if the user finished, or "cancelled" if they aborted.',
      parameters: {
        type: 'object',
        properties: {
          reason: {
            type: 'string',
            description: 'Short, human-readable explanation of what you need them to do.',
          },
        },
        required: ['reason'],
      },
    },
  },
];

// ── Dispatch ─────────────────────────────────────────────────────────────────

/** Minimal interface — anything with an `emit(channel, payload)` works.
 *  Decouples this main-process module from Electron's BrowserWindow type. */
interface ToolEmitter {
  emit?: (channel: string, payload: unknown) => void;
}

/** Module-scoped emitter installed by `setBrowserToolEmitter()`. Defaults to
 *  the empty object so calls during tests / boot don't throw. */
let emitter: ToolEmitter = {};

/** The IPC layer registers an emitter so browser tools can push events to
 *  the renderer (e.g. auto-opening the pane on first navigate, raising the
 *  handoff banner). Decoupled so this module stays main-process-only. */
export function setBrowserToolEmitter(e: ToolEmitter): void {
  emitter = e;
}

/** Ask the renderer to open + attach the browser pane, so a subsequent drive
 *  happens in a RENDERED view. email_send uses this: Gmail's send only fires
 *  reliably when the view is actually attached/painted (a hidden BrowserView
 *  clicks Send but nothing dispatches). */
export function requestBrowserPaneOpen(): void {
  emitter.emit?.('browser:autoOpen', null);
}

/**
 * Dispatch a browser tool call. Fetches the singleton BrowserController and
 * asserts agent ownership before forwarding to the appropriate action helper.
 *
 * Returns serialised JSON on success, or throws on unknown tool name. Individual
 * action helpers throw on Electron/webContents errors, which the orchestrator
 * surfaces to the model as tool-call failures.
 */
export async function invokeBrowserTool(name: string, args: Record<string, unknown>): Promise<string> {
  const controller = BrowserController.getInstance();
  const wc = controller.getWebContents();

  if (name !== 'browser_request_user') {
    // Every tool except the handoff request requires the wheel.
    controller.assertAgentMayAct();
  }

  switch (name) {
    case 'browser_navigate': {
      const url = String(args.url ?? '');
      // SSRF guard (agent-driven nav only — the user's toolbar bypasses this):
      // normalise the scheme the same way navigate() does, then refuse
      // internal/private targets unless the host is allowlisted.
      const normalized = /^[a-z]+:\/\//i.test(url) ? url : `https://${url}`;
      await assertPublicURL(normalized, allowedLocalHosts());
      // Make sure the pane is visible to the user before we drive it.
      emitter.emit?.('browser:autoOpen', null);
      const result = await navigate(wc, url);
      recordCitation({ url: result.url, title: result.title, fetched_at: Math.floor(Date.now() / 1000) });
      return JSON.stringify(result);
    }
    case 'browser_click': {
      await click(wc, String(args.selector ?? ''));
      const { url, title } = getUrl(wc);
      return JSON.stringify({ clicked: args.selector, url, title });
    }
    case 'browser_type': {
      const report = await typeInto(wc, String(args.selector ?? ''), String(args.text ?? ''), {
        submit: Boolean(args.submit),
      });
      // `submitted` used to echo the REQUEST (`args.submit`), so the agent
      // would tell the user "I submitted your application" for a submit that
      // was validation-blocked, disabled, or intercepted. Report the observed
      // outcome, and make an unconfirmed submit an explicit failure so the
      // model cannot treat it as done.
      const wantedSubmit = Boolean(args.submit);
      if (wantedSubmit && report && !report.formSubmitted) {
        return `Error: typed into ${String(args.selector ?? '')} but the form was NOT submitted (${report.reason ?? 'unconfirmed'}). Verify the page state before claiming the submission happened.`;
      }
      return JSON.stringify({
        typed_into: args.selector,
        submitted: wantedSubmit ? Boolean(report?.formSubmitted) : false,
        submit_detail: report?.reason,
      });
    }
    case 'browser_wait_for': {
      await waitForSelector(wc, String(args.selector ?? ''), typeof args.timeout_ms === 'number' ? args.timeout_ms : undefined);
      return JSON.stringify({ found: args.selector });
    }
    case 'browser_read_dom': {
      const r = await readDom(
        wc,
        typeof args.selector === 'string' ? args.selector : undefined,
        typeof args.max_chars === 'number' ? args.max_chars : undefined,
      );
      recordCitation({ url: r.url, title: r.title, fetched_at: Math.floor(Date.now() / 1000) });
      return JSON.stringify(r);
    }
    case 'browser_screenshot': {
      const b64 = await screenshot(wc);
      const { url, title } = getUrl(wc);
      return JSON.stringify({ url, title, image_base64_png: b64 });
    }
    case 'browser_get_url':
      return JSON.stringify(getUrl(wc));
    case 'browser_back': {
      const wentBack = await back(wc);
      const after = getUrl(wc);
      return JSON.stringify({ went_back: wentBack, url: after.url, title: after.title });
    }
    case 'browser_forward': {
      const wentFwd = await forward(wc);
      const after = getUrl(wc);
      return JSON.stringify({ went_forward: wentFwd, url: after.url, title: after.title });
    }
    case 'browser_reload': {
      await reload(wc);
      const after = getUrl(wc);
      return JSON.stringify({ reloaded: true, url: after.url, title: after.title });
    }
    case 'browser_request_user': {
      const reason = String(args.reason ?? 'manual step required');
      emitter.emit?.('browser:autoOpen', null);
      emitter.emit?.('browser:handoffRequested', { reason });
      const outcome = await controller.requestUser(reason);
      emitter.emit?.('browser:handoffResolved', { outcome });
      return JSON.stringify({ outcome, reason });
    }
    default:
      throw new Error(`Unknown browser tool: ${name}`);
  }
}

/** Returns true when `name` is a built-in browser tool — used by MCPRegistry
 *  for routing without importing the full schema list. */
export function isBrowserTool(name: string): boolean {
  return name.startsWith('browser_');
}

// Browser pages count as web sources, so we feed them through the same
// citation collector web.ts uses. The orchestrator sets the active token at
// loop start, and recordCitation no-ops if no workflow is collecting.
