import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

// Deliberately selected correctness rules, without formatting or style presets.
export default defineConfig({
  files: ['src/lifecycle/correction.ts', 'src/lifecycle/correction-contract.ts', 'src/lifecycle/correction-planner.ts', 'src/lifecycle/evidence-qualification.ts'],
  languageOptions: { parser: tseslint.parser, parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } },
  plugins: { '@typescript-eslint': tseslint.plugin },
  rules: {
    'constructor-super': 'error', 'no-constant-condition': 'error', 'no-dupe-args': 'error',
    'no-dupe-else-if': 'error', 'no-duplicate-case': 'error', 'no-unreachable': 'error',
    'no-unsafe-finally': 'error', 'use-isnan': 'error', 'valid-typeof': 'error',
    '@typescript-eslint/no-floating-promises': 'error', '@typescript-eslint/no-misused-promises': 'error',
    '@typescript-eslint/await-thenable': 'error', '@typescript-eslint/no-unsafe-argument': 'error',
    '@typescript-eslint/no-unsafe-call': 'error', '@typescript-eslint/no-unsafe-return': 'error'
  }
});
