/**
 * Каталог ошибок: код → человеческий текст и предлагаемое действие (DESIGN.md §13.7, D-15).
 *
 * Тексты живут ДАННЫМИ, а не литералами по месту броска: иначе один и тот же случай
 * приходит человеку в трёх формулировках, а половина — стектрейсом. На каждый код есть
 * тест, что title непустой и действие названо явно (в том числе явным «делать нечего»).
 */

export type ErrorCode =
  | 'no_profile'
  | 'no_credentials'
  | 'auth_expired'
  | 'write_outcome_unknown'
  | 'scope_missing'
  | 'offline'
  | 'google_unavailable'
  | 'quota_exceeded'
  | 'forbidden'
  | 'not_found'
  | 'provider_key_invalid'
  | 'model_unreachable'
  | 'policy_denied'
  | 'write_blocked'
  | 'revision_conflict'
  | 'undo_too_old'
  | 'stale_value'
  | 'doc_changed'
  | 'confirm_required'
  | 'plan_already_applied'
  | 'needs_grant'
  | 'grant_declined'
  | 'grant_key_missing'
  | 'google_locked'
  | 'unlock_declined'
  | 'seal_tool_missing'
  | 'token_unsealed'
  | 'ambiguous_target'
  | 'bad_request'
  | 'internal';

/** Что человек может сделать. `null` — делать нечего, и это сказано явно, а не пропущено. */
export type ActionKind =
  | 'connect_google'
  | 'reconnect_google'
  | 'put_credentials'
  | 'retry'
  | 'wait_and_retry'
  | 'request_access'
  | 'remove_target'
  | 'open_key_field'
  | 'start_local_model'
  | 'confirm_explicitly'
  | 'reread_and_preview'
  | 'clarify_target'
  | 'open_grant'
  | 'setup_grant_key'
  | 'unlock_google'
  | 'install_age'
  | 'seal_token'
  | null;

export interface CatalogEntry {
  /** Название проблемы на языке человека. Без кодов и без «Error:». */
  readonly title: string;
  /** Осмысленно ли повторять тот же вызов без вмешательства человека. */
  readonly retryable: boolean;
  readonly action: ActionKind;
  /** Подпись кнопки; null, если действия нет. */
  readonly actionLabel: string | null;
}

export const ERROR_CATALOG: Readonly<Record<ErrorCode, CatalogEntry>> = {
  no_profile: {
    title: 'Аккаунт Google не подключён',
    retryable: false,
    action: 'connect_google',
    actionLabel: 'Подключить Google',
  },
  no_credentials: {
    title: 'Нет OAuth-приложения для этого профиля',
    retryable: false,
    action: 'put_credentials',
    actionLabel: 'Указать credentials.json',
  },
  auth_expired: {
    title: 'Доступ к Google истёк',
    retryable: false,
    action: 'reconnect_google',
    actionLabel: 'Переподключить',
  },
  scope_missing: {
    title: 'Не выдано нужное право доступа',
    retryable: false,
    action: 'reconnect_google',
    actionLabel: 'Переподключить с этим правом',
  },
  offline: {
    title: 'Нет сети',
    retryable: true,
    action: 'retry',
    actionLabel: 'Повторить',
  },
  google_unavailable: {
    title: 'Google не отвечает',
    retryable: true,
    action: 'retry',
    actionLabel: 'Повторить',
  },
  quota_exceeded: {
    title: 'Превышен лимит запросов Google',
    retryable: true,
    action: 'wait_and_retry',
    actionLabel: 'Повторить позже',
  },
  forbidden: {
    title: 'Нет доступа к файлу',
    retryable: false,
    action: 'request_access',
    actionLabel: 'Запросить доступ',
  },
  not_found: {
    title: 'Файл не найден или удалён',
    retryable: false,
    action: 'remove_target',
    actionLabel: 'Убрать из реестра целей',
  },
  provider_key_invalid: {
    title: 'Ключ провайдера отклонён',
    retryable: false,
    action: 'open_key_field',
    actionLabel: 'Ввести ключ заново',
  },
  model_unreachable: {
    title: 'Локальная модель не отвечает',
    retryable: true,
    action: 'start_local_model',
    actionLabel: 'Проверить снова',
  },
  policy_denied: {
    title: 'Запрещено правилом',
    retryable: false,
    action: null,
    actionLabel: null,
  },
  write_blocked: {
    title: 'Писать сюда нельзя',
    retryable: false,
    action: 'confirm_explicitly',
    actionLabel: 'Подтвердить осознанно',
  },
  /**
   * Запись стара, а не документ изменился. Отдельный код, потому что живой прогон
   * 2026-09-04 получил заголовок «Документ изменился с момента чтения» на запись
   * восемнадцатичасовой давности при нетронутом документе — код и заголовок противоречили
   * собственному `detail`. Действия у человека нет: доуточняет вызов агент, назвав id.
   */
  undo_too_old: {
    title: 'Запись слишком стара, чтобы откатывать её без уточнения',
    retryable: false,
    action: null,
    actionLabel: null,
  },
  revision_conflict: {
    title: 'Документ изменился с момента чтения',
    retryable: false,
    action: 'reread_and_preview',
    actionLabel: 'Перечитать и показать заново',
  },
  confirm_required: {
    title: 'Запись требует кода плана',
    retryable: false,
    action: 'confirm_explicitly',
    actionLabel: 'Показать план и подтвердить',
  },
  /**
   * Запись из проекта, которому владелец не открыл G connect касанием (D-23). Действие —
   * у человека: агент не подпишет разрешение сам, подпись держит ключ Secure Enclave.
   */
  needs_grant: {
    title: 'Запись из этого проекта не разрешена',
    retryable: false,
    action: 'open_grant',
    actionLabel: 'Попросить владельца открыть G connect касанием',
  },
  grant_declined: {
    title: 'Разрешение не выдано: касания не было',
    retryable: true,
    action: 'open_grant',
    actionLabel: 'Открыть G connect ещё раз',
  },
  grant_key_missing: {
    title: 'Нет ключа для подписи разрешения',
    retryable: false,
    action: 'setup_grant_key',
    actionLabel: 'Создать ключ «G connect» в Secretive',
  },
  /**
   * Токен Google под пальцем (D-24): в этом процессе Google ещё не открыт или час истёк.
   * Повтор того же вызова не поможет — окно вызывает только `gc_unlock`, после строки
   * человеку.
   */
  google_locked: {
    title: 'Google закрыт для этой сессии',
    retryable: false,
    action: 'unlock_google',
    actionLabel: 'Сказать человеку, что G connect попросит палец, и вызвать gc_unlock',
  },
  unlock_declined: {
    title: 'Google не открыт: касания не было',
    retryable: true,
    action: 'unlock_google',
    actionLabel: 'Открыть Google ещё раз, если человек согласен',
  },
  seal_tool_missing: {
    title: 'Нет программ для шифрования токена',
    retryable: false,
    action: 'install_age',
    actionLabel: 'Установить: brew install age age-plugin-se',
  },
  token_unsealed: {
    title: 'Токен Google лежит открытым файлом',
    retryable: false,
    action: 'seal_token',
    actionLabel: 'Владелец запускает gc seal в терминале',
  },
  plan_already_applied: {
    title: 'Этот план уже записан',
    retryable: false,
    action: 'reread_and_preview',
    actionLabel: 'Перечитать и показать заново',
  },
  stale_value: {
    title: 'Значение в ячейке изменилось после превью',
    retryable: false,
    action: 'reread_and_preview',
    actionLabel: 'Перечитать и показать заново',
  },
  doc_changed: {
    // Отказ произносит СЕРВЕР Google (`writeControl.requiredRevisionId`), ядро только
    // переводит его: документ ушёл вперёд между превью и записью — план надо перестроить.
    title: 'Документ изменился после превью',
    retryable: false,
    action: 'reread_and_preview',
    actionLabel: 'Перечитать документ и показать план заново',
  },
  write_outcome_unknown: {
    // Запись повторялась после обрыва, и повтор упёрся в ушедшую ревизию: первая попытка
    // могла дойти до Google и записать. «Ни одной правки» здесь было бы неправдой
    // (находка читателя 2026-10-01: ретрай неидемпотентного batchUpdate).
    title: 'Неизвестно, прошла ли запись',
    retryable: false,
    action: 'reread_and_preview',
    actionLabel: 'Перечитать документ и проверить, легла ли правка',
  },
  ambiguous_target: {
    title: 'Непонятно, какой файл имеется в виду',
    retryable: false,
    action: 'clarify_target',
    actionLabel: 'Уточнить',
  },
  bad_request: {
    // Действия у человека здесь нет, и это сказано явно (§13.7 п.3): запрос составил
    // агент — исправляет он же. Что именно не так, обязано быть в `detail`.
    title: 'Запрос составлен неверно',
    retryable: false,
    action: null,
    actionLabel: null,
  },
  internal: {
    title: 'Внутренняя ошибка ядра',
    retryable: false,
    action: null,
    actionLabel: null,
  },
};
