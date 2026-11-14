import js from '@eslint/js';
import globals from 'globals';

export default [
  {
    ignores: [
      '**/node_modules/**',
      'frontend/public/vdgo/**',
      'services/ollama/prisma/generated/**',
      'services/ollama/prisma/migrations/**',
      'tests/fixtures/legacy-frontend/**',
      'services/vdgo/output/**',
      'services/vdgo/uploads/**',
    ],
  },
  js.configs.recommended,
  {
    files: ['services/ollama/api/**/*.js', 'tests/node/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
      'no-undef': 'error',
      'no-var': 'error',
      'prefer-const': 'warn',
      'eqeqeq': ['warn', 'smart'],
      'no-console': 'off',
      'no-control-regex': 'off',
    },
  },
];