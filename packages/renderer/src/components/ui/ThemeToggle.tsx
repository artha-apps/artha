/**
 * ThemeToggle — sun/moon switch wired to the theme store. Crossfades the icon
 * and flips the `.dark` class on <html> (persisted to localStorage). Defaults
 * to dark; clicking moves to light and back.
 */
import { Moon, Sun } from 'lucide-react';
import { useThemeStore } from '../../stores/theme';
import { Tooltip } from './Tooltip';

export default function ThemeToggle() {
  const theme = useThemeStore(s => s.theme);
  const toggleTheme = useThemeStore(s => s.toggleTheme);
  const isDark = theme === 'dark';

  return (
    <Tooltip content={isDark ? 'Switch to light' : 'Switch to dark'} side="right" sideOffset={10}>
      <button
        onClick={toggleTheme}
        aria-label="Toggle color theme"
        className="no-drag relative grid place-items-center w-8 h-8 rounded-lg
                   text-artha-muted hover:text-artha-text hover:bg-artha-surface
                   border border-transparent hover:border-artha-border
                   transition-all duration-200 active:scale-95"
      >
        {/* Both icons stacked; opacity/rotation crossfade between them. */}
        <Sun
          size={15}
          className={`absolute transition-all duration-300 ${
            isDark ? 'opacity-0 -rotate-90 scale-50' : 'opacity-100 rotate-0 scale-100 text-artha-warn'
          }`}
        />
        <Moon
          size={15}
          className={`absolute transition-all duration-300 ${
            isDark ? 'opacity-100 rotate-0 scale-100 text-artha-accent' : 'opacity-0 rotate-90 scale-50'
          }`}
        />
      </button>
    </Tooltip>
  );
}
