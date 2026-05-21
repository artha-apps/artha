import { app, BrowserWindow, ipcMain, shell } from 'electron';
import { autoUpdater } from 'electron-updater';
import * as path from 'path';
import { registerIpcHandlers } from './ipc/handlers';
import { initDatabase } from './db/schema';
import { BrowserController } from './browser/controller';

const isDev = process.env.NODE_ENV === 'development';

let mainWindow: BrowserWindow | null = null;

async function createWindow(): Promise<void> {
  // Initialise local SQLite database on first launch
  try {
    await initDatabase();
  } catch (err) {
    console.error('[Artha] Database init failed:', err);
    console.error('[Artha] If you see a better-sqlite3 bindings error, run:');
    console.error('[Artha]   npx electron-rebuild -f -w better-sqlite3');
    // Continue loading the window anyway so the UI is visible
  }

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#0f1117',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
    show: true,
  });

  // The BrowserController owns the agent's BrowserView; bind it to the main
  // window before any IPC handler that might reach for it.
  BrowserController.getInstance().bindWindow(mainWindow);

  // Register all IPC handlers (agent, LLM, MCP, docs, RAG, web, browser)
  registerIpcHandlers(mainWindow);

  // Load renderer
  if (isDev) {
    await mainWindow.loadURL('http://localhost:5173');
  } else {
    await mainWindow.loadFile(
      path.join(__dirname, '../../renderer/dist/index.html')
    );
  }

  mainWindow.once('ready-to-show', () => mainWindow?.show());

  // Open external links in default browser, not Electron
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // Check for updates from GitHub Releases (production only).
  // Notification-only in v0.1 — user is prompted to download; no silent install.
  if (!isDev) {
    autoUpdater.autoDownload = false;
    autoUpdater.on('error', (err) => {
      console.error('[Artha] Auto-update check failed:', err);
    });
    autoUpdater.on('update-available', (info) => {
      console.log(`[Artha] Update available: ${info.version} (current ${app.getVersion()})`);
    });
    autoUpdater.on('update-not-available', () => {
      console.log(`[Artha] Up to date (${app.getVersion()})`);
    });
    autoUpdater.checkForUpdatesAndNotify().catch((err) => {
      console.error('[Artha] checkForUpdatesAndNotify rejected:', err);
    });
  }
}

// ── Single-instance lock ───────────────────────────────────────────────────
// Prevents a second Artha window from opening if the app is already running.
// If a second launch is attempted, focus the existing window instead.
const gotSingleInstanceLock = app.requestSingleInstanceLock();

if (!gotSingleInstanceLock) {
  // Another instance is already running — quit immediately
  app.quit();
} else {
  app.on('second-instance', () => {
    // User tried to open a second instance — bring the existing window forward
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(createWindow);

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}
