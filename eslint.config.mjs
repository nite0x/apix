import parser from '@typescript-eslint/parser';
import hooks from 'eslint-plugin-react-hooks';

export default [
  {
    ignores: ['node_modules/**', 'runtime/**', 'test-results/**'],
  },
  {
    files: ['frontend/src/**/*.{ts,tsx}'],
    languageOptions: {
      parser,
      parserOptions: { ecmaVersion: 'latest', sourceType: 'module', ecmaFeatures: { jsx: true } },
    },
    plugins: { 'react-hooks': hooks },
    rules: { 'react-hooks/rules-of-hooks': 'error', 'react-hooks/exhaustive-deps': 'error' },
  },
];
