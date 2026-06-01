/**
 * Sentry event scrubbing — the privacy backstop, extracted as a pure,
 * dependency-free function so it can be unit-tested without the Electron
 * runtime (the parent `sentry.ts` imports `electron`/`@sentry/electron`).
 *
 * This is the LAST thing that runs before an event leaves the machine
 * (wired as Sentry's `beforeSend`). Even if some other code attaches data, this
 * strips anything that could identify the user or reveal their local data:
 *   - drops request/user/server_name/device payloads
 *   - replaces absolute file paths in stack frames + messages with basenames
 *   - drops frame-local variables (can hold file contents / prompts)
 *   - keeps ONLY the breadcrumbs we add ourselves (category 'artha.*')
 *
 * The Sentry Event type is imported type-only so this module pulls in NO
 * runtime dependency on `@sentry/electron`.
 */
import type * as Sentry from '@sentry/electron/main';

export function scrubEvent<T extends Sentry.Event>(event: T): T | null {
  // Replace absolute paths (……/Users/foo/bar/baz.ts → <path>/baz.ts) anywhere
  // they appear in human-readable text. Keeps the filename so stacks stay useful.
  const stripPaths = (text: string): string =>
    text.replace(/(?:\/[^\s/:]+)+\/([^\s/:]+)/g, '<path>/$1');

  // Exception values/messages may contain interpolated paths or content.
  if (event.exception?.values) {
    for (const ex of event.exception.values) {
      if (ex.value) ex.value = stripPaths(ex.value);
      for (const frame of ex.stacktrace?.frames ?? []) {
        // Keep only the basename of the source file — never the full path.
        if (frame.filename) frame.filename = frame.filename.replace(/^.*[\\/]/, '');
        if (frame.abs_path) delete frame.abs_path;
        // Local variables can hold file contents / prompts — drop them.
        if (frame.vars) delete frame.vars;
      }
    }
  }
  if (typeof event.message === 'string') event.message = stripPaths(event.message);

  // Hard-remove identifying / free-text surfaces regardless of who set them.
  delete event.user;
  delete event.request;
  delete event.server_name;
  delete event.contexts?.device;
  // Console breadcrumbs can capture logged prompts/content — drop them; keep
  // only the breadcrumbs we add ourselves (category 'artha.*').
  if (event.breadcrumbs) {
    event.breadcrumbs = event.breadcrumbs.filter(b => (b.category ?? '').startsWith('artha.'));
  }

  return event;
}
