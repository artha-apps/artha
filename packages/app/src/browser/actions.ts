/**
 * Browser actions — selector-based click / type / read / wait, plus a CDP
 * screenshot. All driven through `webContents.executeJavaScript` so we don't
 * have to bundle Playwright; the small set of primitives below covers the
 * 90% of agent automation use cases (forms, link clicks, content reads).
 *
 * Selectors accept CSS *or* a `text=…` pseudo-selector which falls through to
 * a case-insensitive substring match against innerText — handy when the
 * model knows the button label but not the markup.
 */
import type { WebContents } from 'electron';

const DEFAULT_WAIT_MS = 8_000;
const DEFAULT_POLL_MS = 100;

// ── Selector resolution (runs in page) ───────────────────────────────────────
// Compiled to a string so executeJavaScript can ship it across the contextIsolation
// boundary as code. Exposes `__arthaResolve(selector)` returning the first match.

const RESOLVER_SCRIPT = `
(function () {
  if (window.__arthaResolve) return;
  window.__arthaResolve = function (selector) {
    if (typeof selector !== 'string' || !selector) return null;
    if (selector.startsWith('text=')) {
      var needle = selector.slice(5).trim().toLowerCase();
      var nodes = document.querySelectorAll('a, button, [role=button], input[type=submit], input[type=button], label, summary');
      for (var i = 0; i < nodes.length; i++) {
        var t = (nodes[i].innerText || nodes[i].value || '').trim().toLowerCase();
        if (t.indexOf(needle) !== -1) return nodes[i];
      }
      // Fall back to any element whose text contains the needle
      var all = document.body ? document.body.querySelectorAll('*') : [];
      for (var j = 0; j < all.length; j++) {
        var el = all[j];
        if (el.children.length === 0) {
          var txt = (el.innerText || '').trim().toLowerCase();
          if (txt === needle || txt.indexOf(needle) !== -1) return el;
        }
      }
      return null;
    }
    try { return document.querySelector(selector); }
    catch (e) { return null; }
  };
  window.__arthaScrollIntoView = function (el) {
    if (!el || typeof el.scrollIntoView !== 'function') return;
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
  };
})();
`;

async function ensureResolver(wc: WebContents): Promise<void> {
  await wc.executeJavaScript(RESOLVER_SCRIPT, true);
}

// ── waitForSelector ──────────────────────────────────────────────────────────

/** Poll until `selector` is present in the page DOM, then return. Throws a
 *  timeout error if the element never appears. Polling runs in the main
 *  process rather than injecting a long-lived Promise into the page, which
 *  keeps cleanup simple if the page navigates while we're waiting. */
export async function waitForSelector(wc: WebContents, selector: string, timeoutMs = DEFAULT_WAIT_MS): Promise<void> {
  await ensureResolver(wc);
  const deadline = Date.now() + timeoutMs;
  // Poll from the main process rather than running a giant Promise inside the
  // page — keeps cancellation simple and avoids leaving intervals around if
  // the page navigates mid-wait.
  while (Date.now() < deadline) {
    const found = await wc.executeJavaScript(
      `!!window.__arthaResolve(${JSON.stringify(selector)})`,
      true,
    );
    if (found) return;
    await new Promise((r) => setTimeout(r, DEFAULT_POLL_MS));
  }
  throw new Error(`waitForSelector timed out after ${timeoutMs}ms: ${selector}`);
}

// ── navigate ─────────────────────────────────────────────────────────────────

/** Load `url` and wait for `did-finish-load`. Bare hostnames are prefixed with
 *  `https://`. Returns the resolved URL + page title after the load completes,
 *  or throws on navigation failure or timeout. */
export async function navigate(wc: WebContents, url: string, timeoutMs = 30_000): Promise<{ url: string; title: string }> {
  if (!/^https?:\/\//i.test(url) && !url.startsWith('about:')) {
    url = `https://${url}`;
  }
  // Cancel any in-flight load first. On a freshly-created view the controller
  // is loading its placeholder page (`data:…Artha Browser`) asynchronously;
  // without this, that load races ours and its `did-finish-load` can resolve us
  // prematurely — returning "ok" while the target page never actually loaded.
  try { wc.stop(); } catch { /* nothing in flight */ }

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`navigate timed out after ${timeoutMs}ms: ${url}`));
    }, timeoutMs);
    // Resolve only when a REAL page has finished — ignore the placeholder /
    // about:blank settling so a stale load event can't satisfy us. Uses `on`
    // (not `once`) so we can skip those and keep waiting for the target.
    const onDidFinish = () => {
      const cur = wc.getURL();
      if (!cur || cur === 'about:blank' || cur.startsWith('data:')) return; // keep waiting
      cleanup();
      resolve();
    };
    const onDidFail = (
      _e: unknown, code: number, desc: string, _failedUrl: string, isMainFrame: boolean,
    ) => {
      // Ignore sub-frame failures and superseded loads (ERR_ABORTED = -3, which
      // is exactly what `wc.stop()` / a redirect produces) — they're not real
      // navigation failures of our target.
      if (isMainFrame === false || code === -3) return;
      cleanup();
      reject(new Error(`navigate failed: ${desc}`));
    };
    const cleanup = () => {
      clearTimeout(timer);
      wc.removeListener('did-finish-load', onDidFinish);
      wc.removeListener('did-fail-load', onDidFail);
    };
    wc.on('did-finish-load', onDidFinish);
    wc.on('did-fail-load', onDidFail);
    void wc.loadURL(url);
  });
  return { url: wc.getURL(), title: wc.getTitle() };
}

// ── click / type / read ──────────────────────────────────────────────────────

/** Scroll `selector` into view and fire a click. Waits for the element first;
 *  throws if the element is not found after `waitMs`. Prefers `el.click()` for
 *  native form/link behaviour, falling back to a synthetic MouseEvent. */
export async function click(wc: WebContents, selector: string, waitMs = DEFAULT_WAIT_MS): Promise<void> {
  await waitForSelector(wc, selector, waitMs);
  const ok = await wc.executeJavaScript(
    `(function(){var el=window.__arthaResolve(${JSON.stringify(selector)});` +
    `if(!el)return false;window.__arthaScrollIntoView(el);` +
    // Prefer native .click() — handles forms/links/submit; fall through to
    // dispatching a synthetic event for elements that need it.
    `try{el.click()}catch(e){var ev=new MouseEvent('click',{bubbles:true,cancelable:true,view:window});el.dispatchEvent(ev)}` +
    `return true})()`,
    true,
  );
  if (!ok) throw new Error(`click: no element matched ${selector}`);
}

/** Focus `selector`, set its value/textContent to `text`, and fire input +
 *  change events so React/Vue controlled components update. When
 *  `opts.submit` is true, also synthesises an Enter keydown (and calls
 *  `form.requestSubmit()` when available) to trigger SPA form handlers. Uses
 *  the native value setter to bypass framework property descriptors that
 *  ignore direct `.value =` assignments. */
export async function typeInto(wc: WebContents, selector: string, text: string, opts: { submit?: boolean; waitMs?: number } = {}): Promise<void> {
  await waitForSelector(wc, selector, opts.waitMs ?? DEFAULT_WAIT_MS);
  const ok = await wc.executeJavaScript(
    `(function(){
      var el=window.__arthaResolve(${JSON.stringify(selector)});
      if(!el)return false;
      window.__arthaScrollIntoView(el);
      el.focus();
      var tag=(el.tagName||'').toLowerCase();
      var isContentEditable=el.isContentEditable===true;
      if(tag==='input'||tag==='textarea'){
        var setter=Object.getOwnPropertyDescriptor(el.__proto__,'value')&&Object.getOwnPropertyDescriptor(el.__proto__,'value').set;
        if(setter)setter.call(el,${JSON.stringify(text)});
        else el.value=${JSON.stringify(text)};
        el.dispatchEvent(new Event('input',{bubbles:true}));
        el.dispatchEvent(new Event('change',{bubbles:true}));
      } else if(isContentEditable){
        el.textContent=${JSON.stringify(text)};
        el.dispatchEvent(new Event('input',{bubbles:true}));
      } else {
        el.textContent=${JSON.stringify(text)};
      }
      return true;
    })()`,
    true,
  );
  if (!ok) throw new Error(`type: no element matched ${selector}`);

  if (opts.submit) {
    // Press Enter via CDP — synthesises a real keydown so SPA listeners fire.
    await wc.executeJavaScript(
      `(function(){var el=document.activeElement;if(!el)return;` +
      `['keydown','keypress','keyup'].forEach(function(t){` +
      `el.dispatchEvent(new KeyboardEvent(t,{key:'Enter',code:'Enter',which:13,keyCode:13,bubbles:true}));});` +
      `if(el.form&&typeof el.form.submit==='function'){try{el.form.requestSubmit?el.form.requestSubmit():el.form.submit()}catch(e){}}` +
      `})()`,
      true,
    );
  }
}

/** Cleaned-text payload returned by `readDom`. `truncated` lets the model
 *  decide whether to re-call with a narrower selector. */
export interface ReadResult {
  url: string;
  title: string;
  text: string;
  truncated: boolean;
}

/** Extract cleaned visible text from the page (or from a sub-tree when
 *  `selector` is given). Scripts and styles are stripped for readability.
 *  The result is capped at `maxChars`; `truncated` tells the caller whether
 *  the output was cut so they can retry with a narrower selector if needed. */
export async function readDom(wc: WebContents, selector?: string, maxChars = 12_000): Promise<ReadResult> {
  await ensureResolver(wc);
  const text = (await wc.executeJavaScript(
    `(function(){
      var root=${selector ? `window.__arthaResolve(${JSON.stringify(selector)})` : 'document.body'};
      if(!root)return '';
      var clone=root.cloneNode(true);
      // strip scripts/styles for cheap readability
      clone.querySelectorAll && clone.querySelectorAll('script,style,noscript').forEach(function(n){n.remove();});
      var t=(clone.innerText||clone.textContent||'').replace(/[\\t ]+/g,' ').replace(/\\n{3,}/g,'\\n\\n');
      return t.trim();
    })()`,
    true,
  )) as string;
  const truncated = text.length > maxChars;
  return {
    url: wc.getURL(),
    title: wc.getTitle(),
    text: truncated ? text.slice(0, maxChars) : text,
    truncated,
  };
}

// ── Screenshot via CDP ───────────────────────────────────────────────────────

/** Capture the current viewport as a base64-encoded PNG string (no data-URI
 *  prefix). `fullPage` is reserved for a future CDP-based implementation that
 *  would capture content scrolled below the fold. */
export async function screenshot(wc: WebContents, fullPage = false): Promise<string> {
  // Native Electron capturePage is the simplest path; CDP would only matter
  // if we needed fullPage > viewport, which we approximate by resizing capture.
  const img = await wc.capturePage();
  void fullPage; // reserved for future CDP-based full-page capture
  return img.toDataURL().replace(/^data:image\/png;base64,/, '');
}

// ── Navigation helpers ───────────────────────────────────────────────────────

/** Navigate back in the page history. Returns `false` (no-op) if there is no
 *  previous entry, so callers can surface a "can't go back" message. */
export function back(wc: WebContents): boolean {
  if (!wc.canGoBack()) return false;
  wc.goBack();
  return true;
}

/** Navigate forward in the page history. Returns `false` if there is no
 *  forward entry. */
export function forward(wc: WebContents): boolean {
  if (!wc.canGoForward()) return false;
  wc.goForward();
  return true;
}

/** Hard-reload the current page (equivalent to Ctrl+R). */
export function reload(wc: WebContents): void {
  wc.reload();
}

/** Return the current URL and page title without any I/O or side effects. */
export function getUrl(wc: WebContents): { url: string; title: string } {
  return { url: wc.getURL(), title: wc.getTitle() };
}
