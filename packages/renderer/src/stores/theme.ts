/**
 * Theme store — Zustand. Tracks the active color theme ('dark' | 'light'),
 * persists the choice to localStorage, and applies the `.dark` class to
 * <html> so the token palettes in index.css swap. Defaults to 'dark' (the
 * emerald + mint-glow look is the headline experience); the user can flip to
 * light via the Sidebar toggle.
 *
 * Note: an inline boot script in index.html applies the persisted theme before
 * React mounts to avoid a light-flash on cold start — this store keeps the
 * runtime state in sync and writes changes back.
 */
import { create } from 'zustand';

export type Theme = 'dark' | 'light';

const THEME_KEY = 'artha.theme';

/** Read the persisted theme; default to 'dark' for new users. */
function loadTheme(): Theme {
  if (typeof window === 'undefined') return 'dark';
  try {
    const raw = window.localStorage.getItem(THEME_KEY);
    if (raw === 'light' || raw === 'dark') return raw;
  } catch { /* storage blocked — fall through */ }
  return 'dark';
}

/** Reflect the theme onto <html> and persist it. */
function applyTheme(theme: Theme) {
  if (typeof document === 'undefined') return;
  document.documentElement.classList.toggle('dark', theme === 'dark');
  try { window.localStorage.setItem(THEME_KEY, theme); } catch { /* non-fatal */ }
}

interface ThemeState {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  toggleTheme: () => void;
}

export const useThemeStore = create<ThemeState>((set, get) => ({
  theme: loadTheme(),
  setTheme: (theme) => { applyTheme(theme); set({ theme }); },
  toggleTheme: () => {
    const next: Theme = get().theme === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    set({ theme: next });
  },
}));

// Ensure the runtime <html> class matches the store on module load. The boot
// script in index.html normally handles this first, but this is a safe
// idempotent backstop (e.g. if the boot script was stripped).
applyTheme(useThemeStore.getState().theme);
