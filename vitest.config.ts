import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { defineConfig } from 'vitest/config';

/**
 * Корень профилей на весь прогон — временный каталог.
 *
 * 2026-09-02 мутационный прогон сломал перенаправление внутри `env.ts`, и тесты записали
 * свои фикстуры в РЕАЛЬНЫЙ `~/.gconnect`: снесли токен и файл OAuth-клиента владельца.
 * Изоляция была договорённостью — «каждый тест ставит GCONNECT_HOME в beforeEach», — и
 * держалась до первого мутанта. Теперь она свойство прогона: даже тест без beforeEach и
 * даже сломанный резолвер переменных не дотянутся до домашнего каталога.
 */
const testHome = mkdtempSync(join(tmpdir(), 'gconnect-suite-'));

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    env: { GCONNECT_HOME: testHome },
  },
});
