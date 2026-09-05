/*
 * Открытие письма и запасной поиск.
 *
 * Два правила, продиктованных практикой:
 * 1. Письмо всегда открывается в НОВОЙ вкладке. Переиспользование вкладки почты
 *    ломает работу с несколькими ящиками: вкладка уже авторизована под другим
 *    аккаунтом, и переход по ссылке уводит не туда.
 * 2. Запасной поиск идёт по адресу отправителя, а НЕ по теме. Тему задачи
 *    пользователь правит под себя, а адрес отправителя у письма неизменен.
 */

import { taskLink } from '../common/model.js';

const DEFAULT_HOSTS = {
  gmail: 'mail.google.com',
  yandex: 'mail.yandex.ru',
  mailru: 'e.mail.ru'
};

/** Адрес сервиса берём из самой задачи: у Яндекса это mail.yandex.ru или mail.360.yandex.ru. */
function originOf(task) {
  const link = task.messageLink || task.threadLink || task.searchLink || '';
  try {
    return new URL(link).origin;
  } catch (error) {
    return `https://${DEFAULT_HOSTS[task.serviceId] || DEFAULT_HOSTS.gmail}`;
  }
}

/** Gmail ждёт адрес ящика как есть: %40 вместо @ ломает переход. */
function gmailAccount(task) {
  const account = task.accountEmail || task.accountId || '0';
  return encodeURIComponent(account).replace(/%40/g, '@');
}

/** Яндекс различает ящики параметром uid (новый интерфейс) или префиксом /uN/. */
function withYandexAccount(url, task) {
  if (!task.accountId) return url;
  try {
    const parsed = new URL(url);
    if (/^\d+$/.test(task.accountId)) {
      parsed.searchParams.set('uid', task.accountId);
      return parsed.toString();
    }
    if (/^u\d+$/.test(task.accountId) && !parsed.pathname.startsWith(`/${task.accountId}/`)) {
      parsed.pathname = `/${task.accountId}/`;
      return parsed.toString();
    }
    return url;
  } catch (error) {
    return url;
  }
}

/**
 * Поиск писем этого отправителя. Тема сюда не попадает намеренно: задачу
 * переименовывают, и поиск по новому названию письма бы не нашёл.
 */
export function searchUrl(task) {
  if (!task) return '';
  const email = (task.senderEmail || '').trim();
  // Отправитель неизвестен — остаётся ссылка, собранная при захвате письма.
  if (!email) return task.searchLink || '';

  const origin = originOf(task);

  if (task.serviceId === 'gmail') {
    const query = encodeURIComponent(`from:${email} in:anywhere`).replace(/%20/g, '+');
    return `https://mail.google.com/mail/u/${gmailAccount(task)}/#search/${query}`;
  }

  if (task.serviceId === 'yandex') {
    const isNew = origin.includes('360.');
    const url = `${origin}/${isNew ? '#/search?request=' : '#search?request='}${encodeURIComponent(email)}`;
    return withYandexAccount(url, task);
  }

  if (task.serviceId === 'mailru') {
    return `${origin}/search/?q_query=${encodeURIComponent(email)}`;
  }

  return task.searchLink || '';
}

/** Итоговый URL: прямая ссылка на письмо либо поиск по отправителю. */
export function resolveUrl(task, { fallback = false } = {}) {
  if (!task) return '';
  if (fallback) return searchUrl(task) || taskLink(task);

  const direct = taskLink(task);
  if (!direct) return searchUrl(task);

  if (task.serviceId === 'gmail' && task.accountEmail && direct.includes('mail.google.com')) {
    try {
      const parsed = new URL(direct);
      // Форма /mail/u/<email>/ — документированный deep-link на конкретный
      // ящик. Числовой индекс /u/0/ «уезжает», когда меняется порядок входа.
      parsed.pathname = `/mail/u/${gmailAccount(task)}/`;
      return parsed.toString();
    } catch (error) {
      return direct;
    }
  }

  if (task.serviceId === 'yandex') return withYandexAccount(direct, task);

  return direct;
}

/**
 * Открывает письмо новой вкладкой рядом с текущей. Существующие вкладки почты
 * не трогаем: в них может быть открыт другой ящик.
 */
export async function openTask(task, options = {}) {
  const url = resolveUrl(task, options);
  if (!url) return { ok: false, error: 'у задачи нет ссылки на письмо' };

  const [current] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const tab = await chrome.tabs.create({
    url,
    active: true,
    ...(current ? { windowId: current.windowId, index: current.index + 1 } : {})
  });

  return { ok: true, url, tabId: tab.id };
}
