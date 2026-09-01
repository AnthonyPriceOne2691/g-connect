/**
 * Направление зависимостей (CQG §3, гейт layers). Правила канона переписаны под
 * слои ЭТОГО проекта: роль та же — «ядро не знает про фасады», — область другая
 * (DESIGN.md §2: core / mcp / http / agent / cli).
 */
module.exports = {
  forbidden: [
    {
      name: 'core-is-leaf',
      severity: 'error',
      comment: 'Ядро не знает про фасады: ни MCP, ни CLI, ни HTTP, ни раннер (DESIGN §2, §13.2)',
      from: { path: '^src/core' },
      to: { path: '^src/(cli|mcp|http|agent|ui)' },
    },
    {
      name: 'library-seam-is-one',
      severity: 'error',
      comment: 'googleapis виден только в src/core/google/** — иначе тесты потребуют сети',
      from: { path: '^src/core', pathNot: '^src/core/google' },
      to: { path: 'node_modules/googleapis' },
    },
    {
      name: 'no-circular',
      severity: 'error',
      comment: 'Циклы между модулями',
      from: {},
      to: { circular: true },
    },
    {
      name: 'no-orphans',
      severity: 'warn',
      comment: 'Модуль, который никто не импортирует',
      from: { orphan: true, pathNot: ['^src/cli/', '\\.d\\.ts$'] },
      to: {},
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.json' },
    exclude: { path: '^(scripts|delivery|coverage)/' },
  },
};
