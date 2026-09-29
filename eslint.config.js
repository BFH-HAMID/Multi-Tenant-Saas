import js from '@eslint/js';

/**
 * Globals the Node runtime provides. Declared rather than pulled from the
 * `globals` package so the lint config has no dependency of its own — the list
 * only needs to cover what this repo actually touches.
 */
const nodeGlobals = {
  process: 'readonly',
  console: 'readonly',
  Buffer: 'readonly',
  URL: 'readonly',
  URLSearchParams: 'readonly',
  TextEncoder: 'readonly',
  TextDecoder: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
  setImmediate: 'readonly',
  queueMicrotask: 'readonly',
  AbortController: 'readonly',
  structuredClone: 'readonly',
  fetch: 'readonly',
  Response: 'readonly',
  Request: 'readonly',
  Headers: 'readonly',
  crypto: 'readonly',
  performance: 'readonly',
  globalThis: 'readonly',
  NodeJS: 'readonly',
  Intl: 'readonly',
};
import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';

export default [
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/coverage/**',
      'loadtests/results/**',
      'infra/**',
      '.github/**',
      // k6 scripts are generated (tools/loadgen --emit-k6): they run in the k6
      // runtime, not Node, so its globals (__ENV/__VU/k6/*) are not defined
      // here. CI keeps them honest by regenerating and diffing, and by
      // actually executing the smoke script in the compose-smoke job.
      'loadtests/smoke.js',
      'loadtests/load.js',
      'loadtests/tenant-isolation.js',
    ],
  },
  js.configs.recommended,
  {
    files: ['**/*.{ts,mts,cts}'],
    languageOptions: {
      parser: tsParser,
      globals: nodeGlobals,
      parserOptions: {
        ecmaVersion: 2023,
        sourceType: 'module',
        projectService: false,
      },
      // `no-undef` is switched off for TypeScript on purpose: tsc already proves
      // every identifier resolves, and the ESLint rule cannot see ambient globals
      // (`NodeJS.Timeout`, `Performance`) because it does not run the type
      // checker. Leaving it on produces confident-looking false positives that
      // teach people to ignore the linter.
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-floating-promises': 'off', // needs type info; covered by tsc + no-misused-promises in CI typecheck
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      'no-undef': 'off',
      'no-console': ['error', { allow: ['warn', 'error'] }],
      // The base rule double-reports everything the TypeScript-aware one below
      // already covers, and it mis-handles type-only imports and interface
      // parameters (it flags a parameter that is only used in a type position).
      'no-unused-vars': 'off',
      eqeqeq: ['error', 'smart'],
      'no-var': 'error',
      'prefer-const': 'error',
      'object-shorthand': 'error',
      'require-await': 'off',
      curly: ['error', 'all'],
    },
  },
  {
    // CLIs, scripts and tooling talk to a human; the services talk to a log
    // pipeline. Same globals, but `console.log` is the correct primitive here.
    files: [
      '**/tests/**/*.ts',
      'tools/**/*.{mjs,js}',
      '**/*.mjs',
      'db/src/cli.ts',
      'packages/*/scripts/**',
    ],
    languageOptions: { globals: nodeGlobals },
    rules: {
      'no-console': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      'no-undef': 'off',
    },
  },
];
