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
  revision_conflict: {
    title: 'Документ изменился с момента чтения',
    retryable: false,
    action: 'reread_and_preview',
    actionLabel: 'Перечитать и показать заново',
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
