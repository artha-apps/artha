/**
 * Native OS notifications via Electron's Notification API.
 *
 * All notification calls are gated on:
 *   1. `Notification.isSupported()` — not available on all Linux desktops.
 *   2. The `notifications_enabled` setting (default true).
 *
 * Callers that want a click-through to the main window pass `focusOnClick`.
 */
import { Notification, BrowserWindow, app } from 'electron';
import { getDb } from './db/schema';

/** Reads the current notification preference from the settings JSON blob. */
function notificationsEnabled(): boolean {
  try {
    const db = getDb();
    const row = db.prepare(`SELECT settings_json FROM users WHERE user_id='default'`).get() as { settings_json: string } | undefined;
    if (!row) return true;
    const s = JSON.parse(row.settings_json ?? '{}');
    // Default to enabled unless the user has explicitly disabled them.
    return s.notifications_enabled !== false;
  } catch {
    return true;
  }
}

/**
 * Fire a native OS notification.
 *
 * @param title   Short headline shown in bold.
 * @param body    Supporting detail line.
 * @param focusOnClick  Bring the main window to the foreground when clicked.
 */
export function sendNotification(
  title: string,
  body: string,
  focusOnClick = true,
): void {
  if (!Notification.isSupported()) return;
  if (!notificationsEnabled()) return;

  const n = new Notification({
    title,
    body,
    // TODO: supply the app icon path once asset bundling is confirmed;
    // both branches are undefined for now so the OS picks the default.
    icon: app.isPackaged ? undefined : undefined,
    silent: false,
  });

  if (focusOnClick) {
    n.on('click', () => {
      const win = BrowserWindow.getAllWindows()[0];
      if (win) {
        if (win.isMinimized()) win.restore();
        win.focus();
      }
    });
  }

  n.show();
}
