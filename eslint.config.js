const js = require('@eslint/js');
const prettier = require('eslint-config-prettier');
const pluginPrettier = require('eslint-plugin-prettier');
const globals = require('globals');

const sharedRules = {
  ...js.configs.recommended.rules,
  ...prettier.rules,
  'prettier/prettier': 'error',
  'no-console': ['warn', { allow: ['warn', 'error'] }],
  'eqeqeq': ['error', 'always'],
  'curly': 'error',
  'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
  'no-debugger': 'warn',
};

module.exports = [
  {
    ignores: ['node_modules/**', 'release/**', 'dist/**', '**/*.min.js', '**/*.min.css'],
  },
  {
    files: ['main.js', 'preload.js', 'src/**/*.js'],
    plugins: { prettier: pluginPrettier },
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: sharedRules,
  },
  {
    files: ['renderer.js'],
    plugins: { prettier: pluginPrettier },
    languageOptions: {
      globals: { ...globals.browser },
    },
    rules: sharedRules,
  },
];
