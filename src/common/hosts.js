/*
 * Единственный источник знаний о почтовых доменах: какие хосты поддерживаются
 * и какому сервису принадлежит ссылка.
 *
 * Раньше список хостов был продублирован в четырёх местах, а соответствие
 * «хост → сервис» ещё в двух. На первом дубле мы уже поймали ошибку: в коде
 * значился `mail360.yandex.ru`, тогда как Яндекс 360 живёт на
 * `mail.360.yandex.ru`, и на нём расширение не работало вовсе.
 *
 * Здесь всё выводится из одной таблицы. Совпадение с manifest.json (он
 * статичный JSON и импортировать модуль не может) сторожит самотест.
 */

const SERVICES = [
  {
    id: 'gmail',
    hosts: ['mail.google.com'],
    // Домены второго уровня, по которым узнаём сервис у неподдерживаемого
    // хоста — например, в ссылке из задачи, сохранённой прежней версией.
    domains: []
  },
  {
    id: 'yandex',
    hosts: [
      'mail.yandex.ru',
      'mail.yandex.com',
      'mail.yandex.by',
      'mail.yandex.kz',
      'mail.360.yandex.ru',
      'mail.360.yandex.com',
      '360.yandex.ru'
    ],
    domains: ['yandex.ru', 'yandex.com', 'yandex.by', 'yandex.kz', 'yandex.com.tr']
  },
  {
    id: 'mailru',
    hosts: ['e.mail.ru'],
    domains: ['mail.ru']
  }
];

export const MAIL_HOSTS = SERVICES.flatMap((service) => service.hosts);

/** Match patterns для manifest.json, контекстного меню и внедрения скриптов. */
export const MAIL_MATCH_PATTERNS = MAIL_HOSTS.map((host) => `https://${host}/*`);

export function isMailHost(host) {
  return MAIL_HOSTS.includes(host);
}

function hostOf(url) {
  if (!url) return '';
  try {
    return new URL(url).host.toLowerCase();
  } catch (error) {
    // Допускаем и голый хост: старые задачи хранят ссылки в разном виде.
    return /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(String(url)) ? String(url).toLowerCase() : '';
  }
}

/** Открыта ли во вкладке поддерживаемая почта. */
export function isMailUrl(url) {
  return isMailHost(hostOf(url));
}

/**
 * Какому сервису принадлежит ссылка: 'gmail' | 'yandex' | 'mailru' | 'other'.
 * Сравниваем именно хост, а не подстроку в адресе: иначе ссылка вида
 * https://example.com/?u=mail.google.com выдала бы себя за Gmail.
 */
export function serviceOf(url) {
  const host = hostOf(url);
  if (!host) return 'other';

  const exact = SERVICES.find((service) => service.hosts.includes(host));
  if (exact) return exact.id;

  const byDomain = SERVICES.find((service) =>
    service.domains.some((domain) => host === domain || host.endsWith(`.${domain}`))
  );
  return byDomain ? byDomain.id : 'other';
}

/**
 * Основной адрес сервиса — на случай, когда у задачи нет разбираемой ссылки
 * и origin взять неоткуда.
 */
export function defaultHostOf(serviceId) {
  const service = SERVICES.find((item) => item.id === serviceId);
  return service ? service.hosts[0] : SERVICES[0].hosts[0];
}

/** Идентификаторы сервисов — для сверки с подписями в model.js. */
export const SERVICE_IDS = SERVICES.map((service) => service.id);
