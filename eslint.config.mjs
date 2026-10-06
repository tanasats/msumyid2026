import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['**/node_modules/**', '**/dist/**', '**/.next/**', '**/next-env.d.ts', '**/coverage/**'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // สคริปต์ .mjs รันบน Node (ไม่ผ่าน TypeScript) จึงต้องประกาศ global ของ Node เอง
    files: ['**/*.mjs'],
    languageOptions: {
      globals: { process: 'readonly', console: 'readonly' },
    },
  },
  {
    rules: {
      // ห้ามใช้ any (CLAUDE.md หัวข้อ 6) ถ้าจำเป็นให้ปิดเฉพาะบรรทัดพร้อมคอมเมนต์เหตุผล
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
);
