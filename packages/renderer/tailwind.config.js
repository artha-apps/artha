/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        artha: {
          blue:    '#1B4F72',
          accent:  '#2E86C1',
          surface: '#0f1117',
          s2:      '#161b22',
          border:  '#21262d',
          text:    '#e6edf3',
          muted:   '#8b949e',
        },
      },
    },
  },
  plugins: [],
};
