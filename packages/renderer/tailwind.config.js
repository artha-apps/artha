/** @type {import('tailwindcss').Config} */

// All artha color tokens resolve to CSS variables holding *space-separated RGB
// channels* (e.g. `--artha-accent: 16 185 129`). Wrapping them in
// `rgb(... / <alpha-value>)` lets Tailwind opacity modifiers keep working
// (`bg-artha-accent/20`) while the actual values swap between the `:root`
// (light) and `.dark` (emerald) palettes defined in index.css. One token edit,
// every component re-themes — no per-file color churn.
const token = (v) => `rgb(var(${v}) / <alpha-value>)`;

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        artha: {
          bg:              token('--artha-bg'),
          surface:         token('--artha-surface'),
          surface2:        token('--artha-surface2'),
          'surface-raised': token('--artha-surface-raised'),
          border:          token('--artha-border'),
          'border-strong': token('--artha-border-strong'),
          text:            token('--artha-text'),
          muted:           token('--artha-muted'),
          subtle:          token('--artha-subtle'),
          accent:          token('--artha-accent'),
          'accent-hover':  token('--artha-accent-hover'),
          'on-accent':     token('--artha-on-accent'),
          mint:            token('--artha-mint'),
          danger:          token('--artha-danger'),
          success:         token('--artha-success'),
          warn:            token('--artha-warn'),

          // Per-tab accent colors — the three working surfaces are colour-coded
          // so they read as distinct rooms (from main's brand pass; mirrored in
          // src/lib/tabTheme.ts for inline-style use). Kept as literals so the
          // tab-coded components introduced on main keep resolving.
          'tab-artha':   '#4F46E5',  // indigo  — Artha (conversational)
          'tab-flows':   '#7C3AED',  // violet  — Workflows
          'tab-code':    '#059669',  // emerald — Code

          // Compatibility aliases — kept so existing utility classes keep
          // resolving without a token rename in every component file:
          blue:    token('--artha-text'),       // legacy: primary text color
          s2:      token('--artha-surface2'),    // legacy: secondary surface
        },
      },
      fontFamily: {
        sans: ['Inter', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'JetBrains Mono', 'Menlo', 'monospace'],
      },
      boxShadow: {
        // Light theme keeps restrained hairline shadows; dark theme layers a
        // mint glow on top via the `glow` utilities below.
        'soft':    '0 1px 2px rgba(10, 22, 40, 0.04)',
        'lifted':  '0 4px 12px rgba(10, 22, 40, 0.06)',
        'modal':   '0 12px 32px rgba(10, 22, 40, 0.10)',
        // Emerald/mint glows — driven by --artha-glow so they soften in light.
        'glow':       '0 0 0 1px rgb(var(--artha-accent) / 0.30), 0 4px 20px var(--artha-glow)',
        'glow-sm':    '0 0 12px var(--artha-glow)',
        'glow-strong':'0 0 0 1px rgb(var(--artha-accent) / 0.45), 0 6px 28px var(--artha-glow)',
      },
      keyframes: {
        'fade-in':   { '0%': { opacity: '0' }, '100%': { opacity: '1' } },
        'fade-up':   { '0%': { opacity: '0', transform: 'translateY(6px)' }, '100%': { opacity: '1', transform: 'translateY(0)' } },
        'scale-in':  { '0%': { opacity: '0', transform: 'scale(0.96)' }, '100%': { opacity: '1', transform: 'scale(1)' } },
        'glow-pulse':{ '0%,100%': { boxShadow: '0 0 0 0 var(--artha-glow)' }, '50%': { boxShadow: '0 0 18px 2px var(--artha-glow)' } },
        'shimmer':   { '100%': { transform: 'translateX(100%)' } },
        'spin-slow': { '100%': { transform: 'rotate(360deg)' } },
      },
      animation: {
        'fade-in':  'fade-in 160ms ease-out',
        'fade-up':  'fade-up 220ms cubic-bezier(0.16,1,0.3,1)',
        'scale-in': 'scale-in 160ms cubic-bezier(0.16,1,0.3,1)',
        'glow-pulse':'glow-pulse 2.4s ease-in-out infinite',
        'shimmer':  'shimmer 1.5s infinite',
        'spin-slow':'spin-slow 1s linear infinite',
      },
    },
  },
  plugins: [],
};
