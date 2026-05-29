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
          // New light-palette tokens (matching artha.space landing).
          bg:            '#FAFAF7',
          surface:       '#FFFFFF',
          surface2:      '#F4F1EA',
          border:        '#E8E4DA',
          'border-strong': '#D1CCC0',
          text:          '#0A1628',
          muted:         '#5B6577',
          subtle:        '#8A93A3',
          accent:        '#0035ED',
          'accent-hover':'#0028B8',
          danger:        '#B42318',
          success:       '#15803D',
          warn:          '#B45309',

          // Compatibility aliases — kept so existing utility classes keep
          // resolving without a token rename in every component file:
          blue:    '#0A1628',  // was deep navy in dark theme; now primary text color
          s2:      '#F4F1EA',  // was a darker neutral; now warm secondary surface
        },
      },
      fontFamily: {
        sans: ['Inter', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'JetBrains Mono', 'Menlo', 'monospace'],
      },
      boxShadow: {
        // Hairline-only shadows; brand stays restrained.
        'soft':    '0 1px 2px rgba(10, 22, 40, 0.04)',
        'lifted':  '0 4px 12px rgba(10, 22, 40, 0.06)',
        'modal':   '0 12px 32px rgba(10, 22, 40, 0.10)',
      },
    },
  },
  plugins: [],
};
