import js from '@eslint/js';
import nodePlugin from 'eslint-plugin-n';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

export default [
  {
    ignores: ['node_modules/', 'dist/', '*.zst', '*.db'],
  },
  js.configs.recommended,
  nodePlugin.configs['flat/recommended'],
  prettier,
  {
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.node,
      },
    },
    rules: {
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
    files: ['plugins/huaweicloud-core/src/proxy/proxy-agent.mjs'],
    rules: {
      'n/prefer-node-protocol': 'off',
      'n/no-missing-import': ['error', { allowModules: ['undici'] }],
    },
  },
  {
    files: [
      'scripts/**/*.mjs',
      'bin/*.cjs',
      'plugins/huaweicloud-core/src/setup-cli.mjs',
      'plugins/huaweicloud-core/skills/huawei-cloud-find-skills/scripts/search-skills.mjs',
      'test/huaweicloud-agent-toolkit-test/scripts/invoke-mcp.mjs',
    ],
    rules: {
      'n/no-process-exit': 'off',
    },
  },
  {
    files: ['test/**/*.mjs'],
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
];
