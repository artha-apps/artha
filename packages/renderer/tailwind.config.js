/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  // 'class' placeholder so a future dark-mode toggle is a config change,
  // not a refactor. No dark UI ships in this work.
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        artha: {
          // Cool & crisp light palette — clean slate/white surfaces, deep-navy
          // text, and a vivid indigo accent. Replaces the older warm-beige set;
          // every component reads these tokens, so the whole app re-themes here.
          bg:            '#F7F8FA',  // page background (cool off-white)
          surface:       '#FFFFFF',  // cards, elevated panels
          surface2:      '#EEF1F5',  // secondary surface (cool light gray)
          border:        '#E6E9EF',  // hairline borders
          'border-strong': '#D4D9E2',// hover / emphasized borders
          text:          '#0B1220',  // near-black navy primary text
          muted:         '#5A6473',  // secondary text
          subtle:        '#818B9C',  // tertiary text / labels
          accent:        '#4F46E5',  // indigo — primary action / focus
          'accent-hover':'#4338CA',
          danger:        '#DC2626',
          success:       '#059669',
          warn:          '#D97706',

          // Per-tab accent colors — the three working surfaces are colour-coded
          // so they read as distinct rooms. Mirrored in src/lib/tabTheme.ts for
          // dynamic (inline-style) use where Tailwind can't generate classes.
          'tab-artha':   '#4F46E5',  // indigo  — Artha (conversational)
          'tab-flows':   '#7C3AED',  // violet  — Workflows
          'tab-code':    '#059669',  // emerald — Code

          // Compatibility aliases — kept so existing utility classes keep
          // resolving without a token rename in every component file:
          blue:    '#0B1220',  // legacy: deep navy, now primary text color
          s2:      '#EEF1F5',  // legacy: secondary surface
        },
      },
      fontFamily: {
        sans: ['Inter', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'JetBrains Mono', 'Menlo', 'monospace'],
      },
      boxShadow: {
        // Cool-tinted hairline shadows — slightly deeper than before so cards
        // lift cleanly off the cooler background without feeling heavy.
        'soft':    '0 1px 2px rgba(11, 18, 32, 0.05)',
        'lifted':  '0 4px 14px rgba(11, 18, 32, 0.08)',
        'modal':   '0 16px 40px rgba(11, 18, 32, 0.14)',
      },
    },
  },
  plugins: [],
};
