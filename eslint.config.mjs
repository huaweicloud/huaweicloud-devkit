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
// Type-aware rules (and projectService) run on src only: the test project
// is enforced by tsc (test/tsconfig.json), so linting it type-aware would
// re-pay the type-program cost for no extra gate.
const srcFiles = ['plugins/huaweicloud-core/src/**/*.ts', 'plugins/huaweicloud-core/src/**/*.tsx'];

export default [
  {
    ignores: ['node_modules/', '**/dist/**', '.codeartsdoer/', '*.zst', '*.db'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended.map((config) => ({ ...config, files: config.files ?? tsFiles })),
  ...tseslint.configs.recommendedTypeChecked
    // Select by entry name, not position: a typescript-eslint reshape must
    // not silently drop the type-aware gate.
    .filter((config) => config.name === 'typescript-eslint/recommended-type-checked')
    .map((config) => ({ ...config, files: srcFiles })),
  {
    files: srcFiles,
    languageOptions: {
      parserOptions: {
        projectService: true,
      },
    },
    rules: {
      // Handlers (pack tools, CLI subcommands) are async by contract: they
      // are dispatched through await and gain awaits as they evolve.
      // Removing async to satisfy the rule would churn sync-throw
      // semantics for zero safety gain.
      '@typescript-eslint/require-await': 'off',
    },
  },
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
      'no-empty': ['error', { allowEmptyCatch: false }],

      'n/no-missing-import': 'error',
      'n/no-unsupported-features/es-syntax': 'off',
      'n/no-unsupported-features/node-builtins': 'off',
    },
  },
  {
    files: tsFiles,
    rules: {
      // typescript-eslint's recommended set already turns no-undef off for TS
      // sources, and eslint-plugin-n does not resolve explicit ".ts"
      // specifiers. The base no-unused-vars stays off so it does not
      // double-report next to the @typescript-eslint variant below — and so
      // it does not false-positive on .d.mts declaration signatures.
      'no-unused-vars': 'off',
      'n/no-missing-import': 'off',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
    },
  },
  {
    // The SDK and zod are devDependencies inlined into dist/mcp-server.js at
    // build time (esbuild); they never ship as runtime imports, so the
    // publish-surface heuristic of n/no-unpublished-import cannot see them.
    files: [
      'plugins/huaweicloud-core/src/mcp-protocol.ts',
      'plugins/huaweicloud-core/src/mcp-stdio-transport.ts',
      'plugins/huaweicloud-core/src/mcp-server-remote.ts',
      'plugins/huaweicloud-core/src/tool-schemas.ts',
      'plugins/huaweicloud-core/src/tools.ts',
      'plugins/huaweicloud-core/src/capability-catalog.ts',
      'plugins/huaweicloud-core/src/lib/pack-types.ts',
      'plugins/huaweicloud-core/src/lib/tool-schema-parts.ts',
      'plugins/huaweicloud-core/src/packs/*/tools.ts',
      'plugins/huaweicloud-core/src/packs/*/schemas.ts',
      'test/upgrade-session.test.ts',
      'test/remote-mcp-server.test.ts',
    ],
    rules: {
      'n/no-unpublished-import': ['error', { allowModules: ['@modelcontextprotocol/sdk', 'zod'] }],
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
      'plugins/huaweicloud-core/src/lib/cli-io.ts',
      'plugins/huaweicloud-core/src/packs-policy.ts',
      'plugins/huaweicloud-core/src/install-plan.ts',
      'plugins/huaweicloud-core/src/install-prompts.ts',
      'plugins/huaweicloud-core/src/mcp-agent-config.ts',
      'plugins/huaweicloud-core/src/mcp-server.ts',
      'plugins/huaweicloud-core/src/mcp-stdio-transport.ts',
      'plugins/huaweicloud-core/hooks/huaweicloud-safety.mjs',
      'test/huaweicloud-agent-toolkit-test/scripts/invoke-mcp.mjs',
      'test/fixtures/**',
    ],
    rules: {
      'n/no-process-exit': 'off',
      'n/hashbang': 'off',
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
    // The safety hook is a runtime entry point over BUILT output: it prefers
    // the compiled dist/ module and falls back to the TypeScript source.
    // dist/ is a gitignored build artifact (never present on a fresh
    // checkout), so resolution-based rules cannot see the target — the
    // '../src/safety-policy.ts' fallback branch stays checked by
    // import/no-unresolved (resolver extensions include .ts).
    // n/no-missing-import has no pattern-ignore option (allowModules covers
    // bare module names only), so it is off here and import-x carries the
    // resolution gate for this file.
    files: ['plugins/huaweicloud-core/hooks/huaweicloud-safety.mjs'],
    rules: {
      'import/no-unresolved': ['error', { ignore: ['^node:', '^\\.\\./dist/'] }],
      'n/no-missing-import': 'off',
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
