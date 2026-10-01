#!/usr/bin/env node
/**
 * Артефакт-оракул: сервер стартует ИЗ `dist/` и говорит по протоколу MCP.
 *
 * Зачем скриптом в репозитории, а не разовым файлом: в фазе 2 эта проба гонялась вручную,
 * и `artifact_oracle` в STATUS стоял `n/a` — объявленный оракул без файла есть снятая
 * проверка с видом усиления (§4.6). Здесь она исполняемая.
 *
 *   node scripts/probe_mcp.mjs           # только протокол: ничего не пишет, Google не нужен
 *   node scripts/probe_mcp.mjs --live    # плюс превью на живой цели (нужен профиль)
 *
 * Живой режим НИЧЕГО не записывает: он берёт превью и проверяет, что код плана есть, а
 * запись без кода отклоняется. Отказ судится операцией ВНЕ конверта цели: конвертные
 * (auto.ops) владелец подписал идти без кода, для них «отказ без кода» — не свойство
 * продукта. Если контур сломан и вставка прошла — проба сама откатывает её и краснеет.
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LIVE = process.argv.includes('--live');
const TARGET = process.env.GCONNECT_PROBE_TARGET ?? 'infra-test';

const failures = [];
const check = (name, ok, detail = '') => {
  process.stdout.write(`${ok ? '  OK  ' : '  FAIL'} ${name}${detail === '' ? '' : ` — ${detail}`}\n`);
  if (!ok) failures.push(name);
};

const server = spawn('node', [join(ROOT, 'dist/mcp/server.js')], {
  env: { ...process.env, GCONNECT_ACCOUNT: process.env.GCONNECT_ACCOUNT ?? 'default' },
  stdio: ['pipe', 'pipe', 'pipe'],
});
let stderr = '';
server.stderr.on('data', (d) => (stderr += d.toString()));

const pending = new Map();
let buffer = '';
let nextId = 1;
server.stdout.on('data', (chunk) => {
  buffer += chunk.toString();
  const lines = buffer.split('\n');
  buffer = lines.pop() ?? '';
  for (const line of lines) {
    if (line.trim() === '') continue;
    const message = JSON.parse(line);
    const resolve = pending.get(message.id);
    if (resolve !== undefined) {
      pending.delete(message.id);
      resolve(message);
    }
  }
});

const send = (method, params) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, resolve);
    server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    setTimeout(() => reject(new Error(`таймаут на ${method}`)), 30_000);
  });

const callTool = async (name, args) => {
  const message = await send('tools/call', { name, arguments: args });
  const text = message.result?.content?.[0]?.text ?? '{}';
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
};

try {
  const init = await send('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'probe', version: '0' },
  });
  check('initialize отвечает', init.result?.serverInfo?.name === 'g-connect', init.result?.serverInfo?.version);
  check('instructions непустые', (init.result?.instructions ?? '').length > 1000);
  server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);

  const tools = await send('tools/list', {});
  const names = (tools.result?.tools ?? []).map((t) => t.name);
  check('инструментов ровно шесть', names.length === 6, names.join(', '));

  const applySchema = (tools.result?.tools ?? []).find((t) => t.name === 'gc_apply')?.inputSchema;
  check('gc_apply объявляет confirm', applySchema?.properties?.confirm !== undefined);
  // Поправка D-20 (2026-10-01): фраза человека пишет только с кодом плана из превью —
  // без поля в схеме транспорта агенту нечем его приложить (урок L21: схема ≠ ядро).
  check('gc_apply объявляет planId', applySchema?.properties?.planId !== undefined);

  // Сквозная проверка связи схемы транспорта с ядром. Живой прогон 2026-09-04 нашёл, что
  // схема объявляла девять операций при двадцати одной в ядре: правки отклонялись ДО
  // ядра, а правила уверяли агента, что они есть. В процессе такое не видно — схему входа
  // применяет только сервер, — поэтому проверка живёт здесь, где говорят по протоколу.
  const { OPERATION_NAMES } = await import('../dist/core/ops.js');
  const declared = applySchema?.properties?.op?.enum ?? [];
  const missing = OPERATION_NAMES.filter((name) => !declared.includes(name));
  const extra = declared.filter((name) => !OPERATION_NAMES.includes(name));
  check(
    'протокол отдаёт ровно те операции, которые знает ядро',
    missing.length === 0 && extra.length === 0,
    `объявлено ${declared.length}, ядро знает ${OPERATION_NAMES.length}` +
      `${missing.length === 0 ? '' : `, нет в схеме: ${missing.join(', ')}`}` +
      `${extra.length === 0 ? '' : `, лишние: ${extra.join(', ')}`}`,
  );
  // Уровень 3: doc-операции обязаны быть в СХЕМЕ транспорта, а не только в ядре — тот же
  // класс, что блокер 2026-09-04 (девять операций из двадцати одной). Список берётся из
  // ядра, поэтому расхождение здесь означает, что схему собрали не из него.
  const { DOC_OPERATION_NAMES } = await import('../dist/core/ops.js');
  const missingDocs = DOC_OPERATION_NAMES.filter((name) => !declared.includes(name));
  check(
    'протокол отдаёт doc-операции уровня 3',
    missingDocs.length === 0,
    `doc-операций ${DOC_OPERATION_NAMES.length}` +
      `${missingDocs.length === 0 ? '' : `, нет в схеме: ${missingDocs.join(', ')}`}`,
  );
  // Схема gc_read обязана знать mode=text: без него агент не прочитает абзацы документа.
  const readSchema = (tools.result?.tools ?? []).find((t) => t.name === 'gc_read')?.inputSchema;
  const modes = readSchema?.properties?.mode?.enum ?? [];
  check('gc_read объявляет режимы карты, строк и абзацев', modes.includes('text'), modes.join(', '));

  // D-18: конверт цели виден там же, где права. Иначе о разрешении узнают по факту записи.
  check(
    'instructions объясняют конверт',
    (init.result?.instructions ?? '').includes('конверт'),
  );
  // Правила, уходящие модели, обязаны говорить про документы: иначе агент узнает об
  // адресации по факту отказа (тот же класс, что L6 — обещание без механизма).
  const { policyText } = await import('../dist/core/policy.js');
  const rulesText = policyText();
  check(
    'policy://rules объясняет адресацию документов',
    rulesText.includes('mode=map') && rulesText.includes('textStartsWith'),
  );

  const resources = await send('resources/list', {});
  const uris = (resources.result?.resources ?? []).map((r) => r.uri);
  check('ресурс policy://rules отдаётся', uris.includes('policy://rules'));

  if (LIVE) {
    const map = await callTool('gc_read', { target: TARGET, mode: 'map' });
    check('gc_read map читает лист', typeof map.sheet === 'string', `лист ${map.sheet}, шапка ${map.headerRow}`);

    // Ключевую колонку берём из РЕЕСТРА, а не из первой колонки листа: на живой таблице
    // первая колонка — не ключ, и проба падала на needs_clarification вместо проверки.
    const targets = await callTool('gc_targets', {});
    const entry = (targets.targets ?? []).find((x) => x.alias === TARGET);
    const key = entry?.key?.[0] ?? map.columns?.[0]?.name;
    check('реестр объявляет ключ строки', typeof key === 'string', String(key));
    // Значение превью уникально КАЖДОМУ прогону: проба со значением «как в таблице»
    // получала no_change вместо плана (порядок веток L11) и зависела от того, что в
    // ячейке живой таблицы сегодня. Внутри прогона значение одно — код плана стабилен.
    const PROBE_NOTE = `проба кода плана ${new Date().toISOString()} — не записывается`;
    const preview = await callTool('gc_apply', {
      op: 'upsertRow',
      target: TARGET,
      key: { [key]: 'G connect' },
      values: { 'Риски/комментарий': PROBE_NOTE },
    });
    check(
      'превью отдаёт код плана из шести символов',
      /^[0-9a-f]{6}$/.test(preview.planId ?? ''),
      `status=${preview.status}, planId=${preview.planId}`,
    );
    check('превью ничего не записало', preview.status === 'preview' || preview.status === 'no_change');

    // D-18: код плана не зависит от ревизии документа. На живой таблице `version` Drive
    // растёт сам (замерено 37 → 39 без записей), и раньше второй превью давал ДРУГОЙ код —
    // человек получал plan_mismatch на честном подтверждении. Протокольный режим этого не
    // видит: там ревизия не двигается.
    const again = await callTool('gc_apply', {
      op: 'upsertRow',
      target: TARGET,
      key: { [key]: 'G connect' },
      values: { 'Риски/комментарий': PROBE_NOTE },
    });
    check(
      'два превью одной правки дают один код плана',
      again.planId === preview.planId,
      `${preview.planId} → ${again.planId}, ревизии ${preview.baseRevision} → ${again.baseRevision}`,
    );

    // Конверт цели: проба СУДИТ, а не пишет. Боевую запись на живой таблице делает
    // человек — у пробы нет права расширять разрешение, которое подписывал не она.
    const combat = entry?.auto;
    check(
      'конверт цели виден в gc_targets',
      combat === null || typeof combat === 'object' || typeof combat === 'string',
      combat === null ? 'конверта нет: запись через план и код' : JSON.stringify(combat),
    );

    // Фаза 2.5b: структурные операции. Превью вставки — ничего не пишем; живую вставку с
    // откатом делает человек (см. чек-лист поставки), потому что подтверждение — его.
    const insert = await callTool('gc_apply', {
      op: 'insertRows',
      target: TARGET,
      where: { [key]: 'G connect' },
      count: 1,
    });
    check(
      'превью вставки строки описывает позицию и якорь',
      insert.structural?.kind === 'insertRows' && typeof insert.structural?.at === 'number',
      `status=${insert.status}, at=${insert.structural?.at}, anchor=${insert.structural?.anchor}`,
    );
    check(
      'вставка ничего не записала на превью',
      insert.status === 'preview',
      String(insert.status),
    );

    // ── Документы (уровень 3). Цель берётся из реестра по виду: подписывать её конвертом
    // и править живьём — дело человека, проба только СУДИТ превью и отказы.
    const docEntry = (targets.targets ?? []).find((x) => x.type === 'doc');
    if (docEntry === undefined) {
      check('doc-цель в реестре есть', true, 'нет doc-цели — doc-проба пропущена (не дефект)');
    } else {
      const docMap = await callTool('gc_read', { target: docEntry.alias, mode: 'map' });
      check(
        'gc_read map читает документ: табы и оглавление',
        Array.isArray(docMap.tabs) && docMap.tabs.length > 0,
        `табов ${docMap.tabs?.length}, заголовков ${docMap.tabs?.[0]?.headings?.length}`,
      );
      const firstTab = docMap.tabs?.[0];
      const textPage = await callTool('gc_read', {
        target: docEntry.alias,
        mode: 'text',
        tab: firstTab?.title,
        limit: 3,
      });
      // Абзацы — ДАННЫЕ с пометкой источника (content.is-data): живьём, через протокол.
      const page = textPage.paragraphs?.value;
      check(
        'gc_read text отдаёт абзацы с номерами — как данные с источником',
        textPage.paragraphs?.kind === 'data' &&
          Array.isArray(page) &&
          typeof page?.[0]?.n === 'number',
        `абзацев ${page?.length}, источник ${textPage.paragraphs?.origin}, ревизия ${textPage.revisionId}`,
      );
      // Превью вставки: НИЧЕГО не пишем. Значение уникально прогону (урок L24), но здесь
      // даже уникальность не нужна — вставка не зависит от содержимого.
      const docPreview = await callTool('gc_apply', {
        op: 'appendText',
        target: docEntry.alias,
        tab: firstTab?.title,
        text: `проба уровня 3 ${new Date().toISOString()} — не записывается`,
      });
      check(
        'превью вставки в документ отдаёт код плана и якорь',
        /^[0-9a-f]{6}$/.test(docPreview.planId ?? '') &&
          typeof docPreview.changes?.[0]?.anchor === 'string',
        `status=${docPreview.status}, anchor=${docPreview.changes?.[0]?.anchor}`,
      );
      check('превью документа ничего не записало', docPreview.status === 'preview');
      // Разрушающая doc-правка просит НАЗВАНИЕ предмета (D-20), а не код.
      const docDelete = await callTool('gc_apply', {
        op: 'deleteParagraph',
        target: docEntry.alias,
        tab: firstTab?.title,
        where: { paragraphIndex: 1 },
        dryRun: true,
      });
      check(
        'удаление абзаца просит назвать предмет правки',
        (docDelete.notes ?? []).join(' ').includes('удаляю'),
        (docDelete.notes ?? []).slice(-1)[0] ?? String(docDelete.status),
      );
      // Локальная картинка отклоняется ДО обращения к Google (P19b).
      const localImage = await callTool('gc_apply', {
        op: 'insertInlineImage',
        target: docEntry.alias,
        tab: firstTab?.title,
        uri: '/tmp/probe.png',
        dryRun: false,
      });
      check(
        'локальный источник картинки отклонён до сети',
        (localImage.error?.cause ?? localImage.raw ?? '').toString().includes('image.local-source') ||
          (localImage.detail ?? '').includes('https'),
        JSON.stringify(localImage).slice(0, 160),
      );
    }

    // Разрушающая правка обязана просить НАЗВАНИЕ, а не код и не «да» (D-20).
    const remove = await callTool('gc_apply', {
      op: 'deleteRows',
      target: TARGET,
      where: { [key]: 'G connect' },
    });
    check(
      'удаление строки просит назвать предмет правки',
      typeof remove.structural?.confirmPhrase === 'string' &&
        remove.structural.confirmPhrase.includes('G connect'),
      String(remove.structural?.confirmPhrase),
    );
    check(
      'план удаления перечисляет, что именно исчезнет',
      Array.isArray(remove.changes) && remove.changes.length > 0,
      `${remove.changes?.length ?? 0} ячеек в плане`,
    );

    // Фаза 2.5a: вид и замена — тоже только превью, ничего не записываем.
    const format = await callTool('gc_apply', {
      op: 'formatCells',
      target: TARGET,
      where: { [key]: 'G connect' },
      columns: ['Статус'],
      format: { bold: true },
    });
    check(
      'превью правки вида отдаёт код плана',
      /^[0-9a-f]{6}$/.test(format.planId ?? '') || format.status === 'no_change',
      `status=${format.status}, planId=${format.planId}`,
    );
    check(
      'правка вида не выглядит записью',
      format.status === 'preview' || format.status === 'no_change',
      String(format.status),
    );
    const formatCell = format.changes?.[0];
    check(
      'в плане вида есть «было → станет» по виду',
      format.status === 'no_change' ||
        (formatCell?.kind === 'format' && formatCell?.afterFormat !== undefined),
      formatCell === undefined ? 'плана нет' : `${formatCell.a1}: ${JSON.stringify(formatCell.afterFormat)}`,
    );

    const replace = await callTool('gc_apply', {
      op: 'findReplace',
      target: TARGET,
      find: 'G connect',
      replace: 'G connect',
      matchEntireCell: true,
    });
    check(
      'превью замены перечисляет ячейки, а не число',
      replace.status === 'no_change' ||
        (Array.isArray(replace.changes) && replace.changes.every((c) => typeof c.a1 === 'string')),
      `status=${replace.status}, ячеек=${replace.changes?.length ?? 0}`,
    );

    const badRegex = await callTool('gc_apply', {
      op: 'findReplace',
      target: TARGET,
      find: '[',
      replace: 'x',
      searchByRegex: true,
      dryRun: false,
    });
    check(
      'битое регулярное выражение отклонено до записи',
      badRegex.code === 'bad_request' || badRegex.raw?.includes('bad_regex'),
      badRegex.cause ?? badRegex.code ?? '',
    );

    // Отказ «без кода» судится операцией ВНЕ конверта. Прежний upsertRow здесь ошибался
    // дважды: владелец подписал его в auto.ops — «без кода» для него законная запись, а
    // не отказ (проба противоречила конверту и при несовпавшем значении ПИСАЛА бы в живую
    // таблицу); а при совпавшем значении no_change приходил раньше любой проверки
    // (порядок L11), и оракул зависел от состояния таблицы. У вставки строки «нечего
    // менять» недостижимо, в конверт она не пускается правилами — статус детерминирован.
    const noConfirm = await callTool('gc_apply', {
      op: 'insertRows',
      target: TARGET,
      where: { [key]: 'G connect' },
      count: 1,
      dryRun: false,
    });
    const refused =
      noConfirm.status === 'confirm_required' || noConfirm.raw?.includes('confirm_required');
    if (!refused && noConfirm.status === 'ok') {
      // Контур сломан и строка вставилась: вернуть таблицу и покраснеть, а не оставить след.
      await callTool('gc_undo', { target: TARGET });
    }
    check(
      'запись без кода плана отклонена (операция вне конверта)',
      refused,
      `status=${noConfirm.status ?? noConfirm.code ?? ''}` +
        (noConfirm.status === 'ok' ? ' — строка вставилась, откачено gc_undo' : ''),
    );
  }
} catch (error) {
  check(`проба упала: ${error.message}`, false, stderr.slice(0, 300));
} finally {
  server.kill();
}

if (failures.length > 0) {
  process.stdout.write(`probe_mcp: красные проверки — ${failures.join('; ')}\n`);
  process.exit(1);
}
process.stdout.write(`probe_mcp: всё зелёное${LIVE ? ' (живой режим)' : ' (протокол)'}\n`);
