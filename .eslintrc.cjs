/**
 * ESLint config (eslint 8 legacy format — matches the installed toolchain).
 *
 * Scope: lints `packages/app/src` and `packages/renderer/src` (the `lint`
 * script's glob). The Next.js landing site has no `src/` dir and is linted
 * separately via `next lint`.
 *
 * Philosophy: catch real correctness/safety issues, not stylistic noise. The
 * codebase leans on `any`, `require()` (Electron lazy imports) and intentional
 * empty catches, so those are relaxed rather than fought.
 */
module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
    ecmaFeatures: { jsx: true },
  },
  plugins: ['@typescript-eslint', 'react-hooks'],
  extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended'],
  env: { node: true, browser: true, es2022: true },
  ignorePatterns: [
    'dist/',
    'node_modules/',
    '**/*.config.ts',
    '**/*.config.js',
    'packages/landing/',
  ],
  rules: {
    // The agent/tool layer is intentionally loosely typed at the IPC boundary.
    '@typescript-eslint/no-explicit-any': 'off',
    // Electron requires lazy `require()` for some native/main-only modules.
    '@typescript-eslint/no-var-requires': 'off',
    '@typescript-eslint/no-require-imports': 'off',
    // Surface dead code as a warning (non-blocking); allow _-prefixed throwaways.
    '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    'no-unused-vars': 'off',
    // Empty catch blocks are a deliberate "best-effort" pattern here.
    'no-empty': ['warn', { allowEmptyCatch: true }],
    // Control chars appear in legitimate parsing/regex code.
    'no-control-regex': 'off',
    // React hooks safety — `rules-of-hooks` is non-negotiable; missing-deps is
    // a warning so it surfaces in CI without blocking refactors that legitimately
    // close over stable values (Zustand actions, etc.).
    'react-hooks/rules-of-hooks': 'error',
    'react-hooks/exhaustive-deps': 'warn',
  },
};
