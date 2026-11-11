/**
 * Тип содержимого файла с компьютера по расширению — для загрузки на Drive (D-27, Q45–Q47).
 *
 * Таблица — внутри функции, а не константой модуля (урок бюджета мутаций: константа модуля
 * исполняется при импорте, и её мутантов гоняет весь сьют). `Map`, а не объект: расширение
 * `.constructor` не должно найти в таблице `Object.prototype.constructor`.
 */

import { extname } from 'node:path';

/** Тип по расширению имени, без учёта регистра; незнакомое — `application/octet-stream`. */
export function mimeTypeOf(name: string): string {
  const officeXml = 'application/vnd.openxmlformats-officedocument';
  const types = new Map([
    ['md', 'text/markdown'],
    ['txt', 'text/plain'],
    ['csv', 'text/csv'],
    ['json', 'application/json'],
    ['html', 'text/html'],
    ['pdf', 'application/pdf'],
    ['png', 'image/png'],
    ['jpg', 'image/jpeg'],
    ['jpeg', 'image/jpeg'],
    ['gif', 'image/gif'],
    ['webp', 'image/webp'],
    ['svg', 'image/svg+xml'],
    ['mp4', 'video/mp4'],
    ['mov', 'video/quicktime'],
    ['webm', 'video/webm'],
    ['mp3', 'audio/mpeg'],
    ['wav', 'audio/wav'],
    ['zip', 'application/zip'],
    ['docx', `${officeXml}.wordprocessingml.document`],
    ['xlsx', `${officeXml}.spreadsheetml.sheet`],
    ['pptx', `${officeXml}.presentationml.presentation`],
  ]);
  return types.get(extname(name).slice(1).toLowerCase()) ?? 'application/octet-stream';
}
