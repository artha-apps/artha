/**
 * Tailwind CSS configuration for the Artha landing package.
 *
 * Extends the default theme with:
 *   - `font-sans` → Inter (loaded via Google Fonts in layout.tsx)
 *   - `artha` colour palette — an indigo-based ramp used throughout the site
 *     for brand accents (buttons, borders, glows). artha-600 is the primary
 *     action colour; artha-500 is the hover state.
 */
import type { Config } from 'tailwindcss';

const config: Config = {
  // Scan all JS/TS/JSX/TSX/MDX files in app/ and components/ for class names.
  // Only these paths are included so Tailwind's JIT purge stays tight.
  content: [
    './app/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      fontFamily: {
        // Inter is declared first; system-ui / sans-serif are fallbacks if the
        // web font fails to load.
        sans: ['Inter', 'system-ui', 'sans-serif'],
      },
      colors: {
        // Brand colour ramp — based on Tailwind's indigo palette but shifted
        // slightly purple to match the Artha logo mark. Use artha-{50..950}
        // throughout components; don't introduce ad-hoc hex values.
        artha: {
          50:  '#f0f4ff',
          100: '#e0eaff',
          200: '#c7d7fe',
          300: '#a5b8fc',
          400: '#818cf8',
          500: '#6366f1',
          600: '#4f46e5', // primary action (buttons, glows)
          700: '#4338ca',
          800: '#3730a3',
          900: '#312e81',
          950: '#1e1b4b',
        },
      },
    },
  },
  plugins: [],
};

export default config;
