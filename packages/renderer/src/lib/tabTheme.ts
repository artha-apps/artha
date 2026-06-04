/**
 * tabTheme — per-tab accent colours for the four working surfaces (Artha,
 * Workflows, Code, Delegate), so each reads as a distinct "room".
 *
 * These mirror the `artha-tab-*` tokens in tailwind.config.js / index.css, but
 * are exported as raw values for the cases where Tailwind can't help: dynamic
 * inline styles (the canvas accent line, the working-glow ring) where the
 * colour is chosen at runtime from `activeTab` and class names can't be
 * statically generated. Keep the two in sync if you change a hue.
 */
import type { ActiveTab } from '../stores/chat';

export interface TabTheme {
  /** Solid accent — text, borders, the canvas top line. */
  accent: string;
  /** ~10% accent — soft fills behind the active tab / avatars. */
  soft: string;
  /** ~4% accent — ambient canvas tint. */
  tint: string;
  /** Human label for the tab (also the source of truth for the rename). */
  label: string;
}

export const TAB_THEME: Record<ActiveTab, TabTheme> = {
  chat:      { accent: '#4F46E5', soft: 'rgba(79, 70, 229, 0.10)',  tint: 'rgba(79, 70, 229, 0.045)', label: 'Chat' },
  workflows: { accent: '#7C3AED', soft: 'rgba(124, 58, 237, 0.10)', tint: 'rgba(124, 58, 237, 0.045)', label: 'Workflows' },
  code:      { accent: '#059669', soft: 'rgba(5, 150, 105, 0.10)',  tint: 'rgba(5, 150, 105, 0.045)', label: 'Code' },
  delegate:  { accent: '#D97706', soft: 'rgba(217, 119, 6, 0.10)', tint: 'rgba(217, 119, 6, 0.045)', label: 'Delegate' },
};

/** Theme for the active tab, with a safe fallback to the Artha (indigo) room. */
export function tabTheme(tab: ActiveTab): TabTheme {
  return TAB_THEME[tab] ?? TAB_THEME.chat;
}
