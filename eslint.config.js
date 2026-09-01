// Конфиг eslint для ядра. Роль в контуре — «сложность функций под контролем»
// (CQG §3, гейт complexity) и «warnings линтера не растут» (гейт eslint-warnings).
// Порог сложности принадлежит ГЕЙТУ, а не этому файлу: гейт передаёт правила
// через --rule, поэтому здесь их нет.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    // Вендоренный payload контура не судим: чужое авторство, правится каноном (§6).
    ignores: ['node_modules/**', 'scripts/**', 'dist/**', 'coverage/**', '.stryker-tmp/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      // Ошибки не молчат (CQG §2.4): пустой catch и проглоченный await — запрещены.
      'no-empty': ['error', { allowEmptyCatch: false }],
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': 'warn',
      eqeqeq: ['error', 'always'],
    },
  },
  {
    files: ['tests/**/*.ts'],
    rules: {
      // В тестах `!` на фикстурах законен: форма данных известна автору теста.
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      // Фейки реализуют async-интерфейс ядра, и `await` внутри им не нужен —
      // требовать его значило бы портить заглушку ради правила.
      '@typescript-eslint/require-await': 'off',
      // Тесты БРОСАЮТ форму чужой ошибки (`{ code: 429 }`) намеренно: ровно так её
      // отдаёт googleapis, и разбор проверяется на настоящей форме, а не на Error.
      '@typescript-eslint/only-throw-error': 'off',
      // Метод фейка передаётся как значение — в тесте это законно.
      '@typescript-eslint/unbound-method': 'off',
    },
  },
);
