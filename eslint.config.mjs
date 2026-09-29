import js from '@eslint/js';
import nodePlugin from 'eslint-plugin-n';
import importPlugin from 'eslint-plugin-import-x';
import unicornPlugin from 'eslint-plugin-unicorn';
import prettier from 'eslint-config-prettier';
import globals from 'globals';
import tseslint from 'typescript-eslint';

// Scope every typescript-eslint config to TS sources. Recommended applies
// globally by default, which would run TS-only rules (no-require-imports,
// no-unused-vars) against the repo's .mjs files.
const tsFiles = ['**/*.ts', '**/*.tsx', '**/*.mts', '**/*.cts'];

export default [
  {
    ignores: ['node_modules/', '**/dist/**', '.codeartsdoer/', '*.zst', '*.db'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended.map((config) => ({ ...config, files: config.files ?? tsFiles })),
  nodePlugin.configs['flat/recommended'],
  prettier,
  {
    plugins: { import: importPlugin, unicorn: unicornPlugin },
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.node,
      },
    },
    settings: {
      'import/resolver': {
        node: {
          extensions: ['.js', '.mjs', '.cjs', '.ts'],
        },
      },
    },
    rules: {
      // --- Import rules ---
      'import/extensions': ['error', 'ignorePackages', { js: 'always', mjs: 'always', cjs: 'always', ts: 'always' }],
      'import/no-unresolved': ['error', { ignore: ['^node:'] }],
      'import/order': [
        'warn',
        {
          groups: [['builtin', 'external'], 'internal', ['parent', 'sibling', 'index']],
          'newlines-between': 'always',
        },
      ],
      'import/no-duplicates': 'error',
      'import/newline-after-import': 'warn',
      'import/first': 'error',
      'import/no-mutable-exports': 'error',
      'import/no-absolute-path': 'error',
      'import/no-self-import': 'error',
      'import/no-cycle': 'warn',

      // --- Unicorn safety / bug rules ---
      'unicorn/catch-error-name': 'error',
      'unicorn/prefer-type-error': 'error',
      'unicorn/error-message': 'error',
      'unicorn/no-unsafe-buffer-conversion': 'error',
      'unicorn/require-array-sort-compare': 'error',
      'unicorn/no-instanceof-array': 'error',
      'unicorn/prefer-number-is-safe-integer': 'error',
      'unicorn/prefer-set-has': 'error',
      'unicorn/no-array-callback-reference': 'error',
      'unicorn/no-static-only-class': 'warn',

      // --- Project rules ---
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
      'no-var': 'warn',
      'prefer-const': 'warn',
      'no-undef': 'error',
      'no-empty': ['error', { allowEmptyCatch: true }],

      'n/no-missing-import': 'error',
      'n/no-unsupported-features/es-syntax': 'off',
      'n/no-unsupported-features/node-builtins': 'off',
    },
  },
  {
    files: ['**/*.ts'],
    rules: {
      // TypeScript resolves types itself, and eslint-plugin-n does not resolve
      // explicit ".ts" specifiers. Keep both out of the .ts path.
      'no-undef': 'off',
      'n/no-missing-import': 'off',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
    },
  },
  {
    files: ['plugins/huaweicloud-core/src/sandbox/hdkitservice-api.ts'],
    rules: {
      'n/no-missing-import': ['error', { allowModules: ['undici'] }],
    },
  },
  {
    files: ['plugins/huaweicloud-core/src/proxy/proxy-agent.ts'],
    rules: {
      'n/prefer-node-protocol': 'off',
      'n/no-missing-import': ['error', { allowModules: ['undici'] }],
    },
  },
  {
    files: [
      'scripts/**/*.mjs',
      'bin/*.cjs',
      'plugins/huaweicloud-core/src/setup-cli.ts',
      'plugins/huaweicloud-core/src/mcp-server.ts',
      'test/huaweicloud-agent-toolkit-test/scripts/invoke-mcp.mjs',
      'test/fixtures/**',
    ],
    rules: {
      'n/no-process-exit': 'off',
      'n/hashbang': 'off',
    },
  },
  {
    files: ['test/**/*.ts'],
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
    },
  },
  {
    files: ['bin/setup.cjs'],
    languageOptions: {
      sourceType: 'commonjs',
    },
    rules: {
      'n/no-missing-require': 'error',
    },
  },
  {
    files: ['plugins/huaweicloud-core/src/ws-exec/hwlink-*'],
    rules: {
      'unicorn/prefer-number-is-safe-integer': 'off',
      'unicorn/no-unsafe-buffer-conversion': 'off',
    },
  },
];
