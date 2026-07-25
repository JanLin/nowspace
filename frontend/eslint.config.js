import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    rules: {
      // Conventional: an underscore prefix marks an intentionally-unused
      // binding (e.g. the `_group` arg threaded through drag handlers).
      '@typescript-eslint/no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
      }],
      // The newer eslint-plugin-react-hooks ships React-Compiler / HMR rules as
      // errors. This codebase predates them and trips them on intentional,
      // pre-existing patterns in non-DnD components (ref-seeded state init,
      // co-located hooks, manual memoization). They are advisory/perf/DX rather
      // than correctness, so we keep them visible as warnings instead of failing
      // lint. See loopback/STATUS.md. Revisit as a dedicated cleanup pass.
      'react-hooks/refs': 'warn',
      'react-hooks/immutability': 'warn',
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/preserve-manual-memoization': 'warn',
      'react-refresh/only-export-components': 'warn',
    },
  },
])
