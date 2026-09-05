/*
 * Единственный список почтовых хостов.
 *
 * Раньше он был продублирован в четырёх местах — и мы уже поймали на этом
 * ошибку: в коде значился `mail360.yandex.ru`, тогда как Яндекс 360 живёт на
 * `mail.360.yandex.ru`, из-за чего на этом сервисе расширение вообще не
 * работало. Теперь фон и список задач читают отсюда, а совпадение с
 * manifest.json (он статичный JSON и импортировать модуль не может)
 * проверяет самотест.
 */

export const MAIL_HOSTS = [
  'mail.google.com',
  'mail.yandex.ru',
  'mail.yandex.com',
  'mail.yandex.by',
  'mail.yandex.kz',
  'mail.360.yandex.ru',
  'mail.360.yandex.com',
  '360.yandex.ru',
  'e.mail.ru'
];

/** Match patterns для manifest.json, контекстного меню и внедрения скриптов. */
export const MAIL_MATCH_PATTERNS = MAIL_HOSTS.map((host) => `https://${host}/*`);

export function isMailHost(host) {
  return MAIL_HOSTS.includes(host);
}

/** Открыта ли во вкладке поддерживаемая почта. */
export function isMailUrl(url) {
  try {
    return isMailHost(new URL(url).host);
  } catch (error) {
    return false;
  }
}
