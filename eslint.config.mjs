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
  {
    // หน้าเว็บต้องใช้ semantic token (bg-surface, text-danger-fg ...) ไม่ใช้สี palette ของ Tailwind ตรง ๆ
    // เพื่อให้โหมดสว่าง/มืดและการเปลี่ยนโทนสีทำที่ globals.css ที่เดียว (docs/design/ui-guidelines.md หัวข้อ 3)
    files: ['apps/web/src/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-syntax': [
        'error',
        ...['Literal[value', 'TemplateElement[value.raw'].map((node) => ({
          selector: `${node}=/(^|[\\s:'"\`])(bg|text|border|ring|divide|outline|fill|stroke|from|via|to|accent|placeholder|decoration|shadow)-((slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\\d|white\\b|black\\b)/]`,
          message: 'ใช้ semantic token จาก globals.css (เช่น bg-surface, text-danger-fg) แทนสี palette ตรง ๆ',
        })),
      ],
    },
  },
);
