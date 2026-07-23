/**
 * Desktop control tools — let the ReAct loop drive native macOS apps via
 * keyboard/mouse simulation and screen capture.
 *
 * Mouse/keyboard automation uses `@nut-tree-fork/nut-js` (the maintained, free
 * fork of the now-private `@nut-tree/nut-js`) — an OPTIONAL dependency loaded
 * lazily so the app still boots if it isn't installed/built. Screen capture
 * uses Electron's `desktopCapturer` (main-process API). App launching shells
 * out to `open -a`.
 *
 * These tools are DANGEROUS (they move the real cursor and type real keys), so
 * the orchestrator only exposes them when `desktop_control_enabled` is set.
 */
import OpenAI from 'openai';
import { desktopCapturer } from 'electron';

export const DESKTOP_TOOL_SCHEMAS: OpenAI.ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'desktop_screenshot',
      description: 'Capture the full screen and return it as a base64-encoded PNG. Use to see the current state of the desktop before clicking or typing.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'desktop_click',
      description: 'Move the mouse to (x, y) in screen pixels and click. button defaults to "left".',
      parameters: {
        type: 'object',
        properties: {
          x: { type: 'number', description: 'X coordinate in screen pixels.' },
          y: { type: 'number', description: 'Y coordinate in screen pixels.' },
          button: { type: 'string', enum: ['left', 'right', 'double'], description: 'Which click to perform.' },
        },
        required: ['x', 'y'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'desktop_type',
      description: 'Type a string of text at the current focus, as if typed on the keyboard.',
      parameters: {
        type: 'object',
        properties: { text: { type: 'string', description: 'The text to type.' } },
        required: ['text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'desktop_key',
      description: 'Press a key or keyboard shortcut, e.g. "cmd+c", "enter", "cmd+shift+4". Use "+" to combine modifiers.',
      parameters: {
        type: 'object',
        properties: { key: { type: 'string', description: 'Key combo, e.g. "cmd+c".' } },
        required: ['key'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'desktop_move_mouse',
      description: 'Move the mouse cursor to (x, y) in screen pixels without clicking.',
      parameters: {
        type: 'object',
        properties: {
          x: { type: 'number', description: 'X coordinate in screen pixels.' },
          y: { type: 'number', description: 'Y coordinate in screen pixels.' },
        },
        required: ['x', 'y'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'desktop_find_on_screen',
      description: 'Find a template image on the screen via pixel matching. Pass a base64-encoded PNG. Returns {x, y} of the match centre, or null if not found.',
      parameters: {
        type: 'object',
        properties: { image: { type: 'string', description: 'Base64-encoded PNG of the template to locate.' } },
        required: ['image'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'desktop_get_active_window',
      description: 'Return the title and bounds of the currently focused window.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'desktop_open_app',
      description: 'Launch (or focus) a native macOS application by name, e.g. "Safari", "Notes".',
      parameters: {
        type: 'object',
        properties: { appName: { type: 'string', description: 'The application name as shown in Finder.' } },
        required: ['appName'],
      },
    },
  },
];

const DESKTOP_TOOL_NAMES = new Set(DESKTOP_TOOL_SCHEMAS.map(t => t.function.name));

/** Returns true when `name` is a built-in desktop tool — used by MCPRegistry
 *  to route calls without importing the full schema list. */
export function isDesktopTool(name: string): boolean {
  return DESKTOP_TOOL_NAMES.has(name);
}

/** Lazily load nut-js. Throws a friendly error if the native module is absent. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function loadNut(): Promise<any> {
  try {
    return await import('@nut-tree-fork/nut-js');
  } catch (err) {
    throw new Error(
      'Desktop automation backend (@nut-tree-fork/nut-js) is not available. ' +
      'It is an optional dependency — install it and run `npx electron-rebuild -f -w @nut-tree-fork/nut-js`. ' +
      `Original error: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/** Capture the primary screen as a base64 PNG (no data: prefix). */
async function captureScreenshot(): Promise<string> {
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: 1920, height: 1080 },
  });
  const first = sources[0];
  if (!first) throw new Error('No screen source available.');
  return first.thumbnail.toPNG().toString('base64');
}

/** Resolve a "cmd+shift+c"-style combo into an array of nut-js Key values
 *  suitable for spread into `keyboard.pressKey(...keys)`. Tokens not found in
 *  the named map are looked up as `Key[token.toUpperCase()]` — covers letters
 *  (a–z) and function keys (f1–f12) without enumerating them explicitly. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function resolveKeys(nut: any, combo: string): unknown[] {
  const Key = nut.Key;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  /** Human-friendly modifier and special-key aliases → nut-js Key enum values. */
  const named: Record<string, any> = {
    cmd: Key.LeftSuper, command: Key.LeftSuper, meta: Key.LeftSuper, win: Key.LeftSuper, super: Key.LeftSuper,
    ctrl: Key.LeftControl, control: Key.LeftControl,
    alt: Key.LeftAlt, option: Key.LeftAlt, opt: Key.LeftAlt,
    shift: Key.LeftShift,
    enter: Key.Enter, return: Key.Return ?? Key.Enter, tab: Key.Tab,
    esc: Key.Escape, escape: Key.Escape, space: Key.Space,
    backspace: Key.Backspace, delete: Key.Delete, del: Key.Delete,
    up: Key.Up, down: Key.Down, left: Key.Left, right: Key.Right,
    home: Key.Home, end: Key.End,
  };
  return combo.split('+').map(p => p.trim().toLowerCase()).filter(Boolean).map(p => {
    if (named[p] !== undefined) return named[p];
    if (p.length === 1) return Key[p.toUpperCase()] ?? Key[p];
    // f1..f12 and other named keys
    const cap = p.charAt(0).toUpperCase() + p.slice(1);
    return Key[cap] ?? Key[p.toUpperCase()];
  }).filter((k): k is unknown => k !== undefined);
}

/**
 * Dispatch a desktop tool call. All errors are caught and returned as
 * `"Error: ..."` strings rather than thrown, so the ReAct loop can relay the
 * message to the model and retry or gracefully stop without crashing.
 */
export async function invokeDesktopTool(name: string, args: Record<string, unknown>): Promise<string> {
  try {
    switch (name) {
      case 'desktop_screenshot': {
        return await captureScreenshot();
      }

      case 'desktop_click': {
        const nut = await loadNut();
        const x = Number(args.x);
        const y = Number(args.y);
        const button = String(args.button ?? 'left');
        await nut.mouse.setPosition(new nut.Point(x, y));
        if (button === 'right') {
          await nut.mouse.click(nut.Button.RIGHT);
        } else if (button === 'double') {
          await nut.mouse.doubleClick(nut.Button.LEFT);
        } else {
          await nut.mouse.click(nut.Button.LEFT);
        }
        return `Clicked (${button}) at ${x}, ${y}.`;
      }

      case 'desktop_type': {
        const nut = await loadNut();
        const text = String(args.text ?? '');
        await nut.keyboard.type(text);
        return `Typed ${text.length} character${text.length === 1 ? '' : 's'}.`;
      }

      case 'desktop_key': {
        const nut = await loadNut();
        const combo = String(args.key ?? '');
        const keys = resolveKeys(nut, combo);
        if (!keys.length) return `Error: could not resolve key combo "${combo}".`;
        await nut.keyboard.pressKey(...keys);
        await nut.keyboard.releaseKey(...keys);
        return `Pressed ${combo}.`;
      }

      case 'desktop_move_mouse': {
        const nut = await loadNut();
        const x = Number(args.x);
        const y = Number(args.y);
        await nut.mouse.setPosition(new nut.Point(x, y));
        return `Moved mouse to ${x}, ${y}.`;
      }

      case 'desktop_find_on_screen': {
        const nut = await loadNut();
        const b64 = String(args.image ?? '');
        if (!b64) return 'Error: image (base64 PNG) is required.';
        try {
          const fs = await import('fs');
          const os = await import('os');
          // nut-js imageResource() requires a file path, not a buffer, so we
          // write a temp PNG and clean up immediately after the match attempt.
          const tmp = `${os.tmpdir()}/artha-find-${Date.now()}.png`;
          fs.writeFileSync(tmp, Buffer.from(b64, 'base64'));
          const region = await nut.screen.find(nut.imageResource(tmp));
          try { fs.unlinkSync(tmp); } catch { /* ignore */ }
          const cx = region.left + region.width / 2;
          const cy = region.top + region.height / 2;
          return JSON.stringify({ found: true, x: Math.round(cx), y: Math.round(cy) });
        } catch (err) {
          // "Not found on screen" and "image matching isn't available on this
          // machine" are DIFFERENT facts — collapsing both to null let the
          // model confidently report the element was absent when the feature
          // was simply missing (audit H30). Distinguish them.
          const msg = err instanceof Error ? err.message : String(err);
          const providerMissing = /provider|not implemented|opencv|no such|module|dylib|\.node/i.test(msg);
          if (providerMissing) {
            return 'Error: on-screen image matching is not available on this machine, so the target could not be searched for. Do NOT conclude it is absent.';
          }
          return JSON.stringify({ found: false });
        }
      }

      case 'desktop_get_active_window': {
        const nut = await loadNut();
        const win = await nut.getActiveWindow();
        const title = await win.getTitle();
        const region = await win.getRegion();
        return JSON.stringify({
          title,
          bounds: { x: region.left, y: region.top, width: region.width, height: region.height },
        });
      }

      case 'desktop_open_app': {
        const appName = String(args.appName ?? '').trim();
        if (!appName) return 'Error: appName is required.';
        const { execFile } = await import('child_process');
        const { promisify } = await import('util');
        await promisify(execFile)('open', ['-a', appName]);
        return `Opened "${appName}".`;
      }

      default:
        return `Unknown desktop tool: ${name}`;
    }
  } catch (err) {
    return `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
}
