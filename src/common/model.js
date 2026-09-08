/* Модель задачи TaskMail: схема, значения по умолчанию, ключи дедупликации. */

export const SCHEMA_VERSION = 2;

const PRIORITIES = [
  { id: 'high', label: 'Высокий', short: 'Высокий', order: 0 },
  { id: 'normal', label: 'Обычный', short: 'Обычный', order: 1 },
  { id: 'low', label: 'Низкий', short: 'Низкий', order: 2 }
];

export function priorityInfo(id) {
  return PRIORITIES.find((item) => item.id === id) || PRIORITIES[1];
}

export const SERVICES = {
  gmail: { id: 'gmail', label: 'Gmail' },
  yandex: { id: 'yandex', label: 'Яндекс Почта' },
  mailru: { id: 'mailru', label: 'Mail.ru' },
  other: { id: 'other', label: 'Почта' }
};

export function serviceLabel(id) {
  return (SERVICES[id] || SERVICES.other).label;
}

function newId() {
  return `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** Пустая задача со всеми полями схемы — единственный источник правды по форме объекта. */
export function makeTask(fields = {}) {
  const now = Date.now();
  return {
    id: newId(),
    schemaVersion: SCHEMA_VERSION,

    // Данные письма
    subject: '',
    senderName: '',
    senderEmail: '',
    serviceId: 'other',
    accountId: '',
    accountEmail: '',
    messageId: '',
    threadId: '',
    messageLink: '',
    threadLink: '',
    searchLink: '',
    useThreadLink: false,

    // Пользовательские поля
    comment: '',
    excerpt: '',
    priority: 'normal',
    dueLocal: null, // 'YYYY-MM-DD'
    dueAt: null,
    remindLocal: null, // 'YYYY-MM-DDTHH:mm'
    remindAt: null,
    remindTz: timeZone(),

    // Объединённая задача по нескольким письмам
    items: null,

    // Служебное
    done: false,
    createdAt: now,
    updatedAt: now,
    completedAt: null,
    lastNotifiedAt: null,
    ...fields
  };
}

export function timeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || '';
  } catch (error) {
    return '';
  }
}

/** Активная ссылка задачи с учётом выбора «письмо или вся переписка». */
export function taskLink(task) {
  if (!task) return '';
  if (task.useThreadLink && task.threadLink) return task.threadLink;
  return task.messageLink || task.threadLink || task.searchLink || '';
}

/*
 * Признаки того, что ссылка ведёт к письму, а не к папке. Ссылка на список
 * писем внешне неотличима от рабочей: она открывается, но показывает ящик —
 * и «Открыть» выглядит сломанным. Такие ссылки появляются, когда почта
 * перерисовала вёрстку и идентификатор письма достать не удалось.
 */
const MESSAGE_LINK = {
  // #all/16be0868ae18c6a7, #inbox/FMfcgz… — но не #search/from%3A…
  gmail: (url) => /^#(?!search\/)[^/]+\/[A-Za-z0-9_-]{8,}/.test(url.hash),
  // #/message/1857…, #thread/1857… — но не #/folder/67
  yandex: (url) => /^#\/?(?:message|thread)\/[^/]+/.test(url.hash),
  // /inbox/0:1234-5678/ — но не /inbox/
  mailru: (url) => /\/\d+:[\d-]+/.test(url.pathname)
};

export function isMessageLink(link, serviceId) {
  if (!link) return false;
  let url;
  try {
    url = new URL(link);
  } catch (error) {
    return false;
  }
  const test = MESSAGE_LINK[serviceId];
  // Незнакомый сервис — судить не о чем, считаем ссылку рабочей.
  return test ? test(url) : true;
}

function accountKey(task) {
  return `${task.serviceId}|${(task.accountEmail || task.accountId || '').toLowerCase()}`;
}

/**
 * Ключ дедупликации: одно письмо в одном аккаунте = одна задача.
 * Идентификатор письма надёжнее ссылки — один и тот же тред в Gmail открывается
 * как #inbox/<id>, #all/<id> и #search/…/<id>, поэтому из ссылки достаём id.
 */
export function dedupeKey(task) {
  if (!task) return '';
  const account = accountKey(task);
  if (task.messageId) return `${account}|msg|${task.messageId}`;
  if (task.threadId) return `${account}|thread|${task.threadId}`;
  const link = normalizeLink(taskLink(task));
  return link ? `${account}|url|${link}` : '';
}

/** Мягкий ключ: то же письмо, если совпали отправитель и тема без Re:/Fwd:. */
export function softKey(task) {
  if (!task || !task.senderEmail) return '';
  const subject = normalizeSubject(task.subject);
  if (!subject) return '';
  return `${accountKey(task)}|soft|${task.senderEmail.toLowerCase()}|${subject}`;
}

export function normalizeSubject(subject) {
  return (subject || '')
    .toLowerCase()
    .replace(/^((re|fwd|fw|ответ|пересылка)(\[\d+\])?:\s*)+/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeLink(link) {
  if (!link) return '';
  try {
    const url = new URL(link);
    // Из #inbox/FMfcgz…, #all/FMfcgz…, #message/1234 берём именно идентификатор.
    const fromHash = url.hash.match(/#[^/]*\/([A-Za-z0-9:_%.-]+)/);
    if (fromHash) return `${url.host.toLowerCase()}#${fromHash[1].toLowerCase()}`;
    return (url.host + url.pathname + url.hash).replace(/\/+$/, '').toLowerCase();
  } catch (error) {
    return String(link).trim().toLowerCase();
  }
}

/** Русское склонение: plural(3, ['письмо', 'письма', 'писем']) → «3 письма». */
export function plural(count, forms) {
  const abs = Math.abs(count) % 100;
  const tail = abs % 10;
  if (abs > 10 && abs < 20) return `${count} ${forms[2]}`;
  if (tail > 1 && tail < 5) return `${count} ${forms[1]}`;
  if (tail === 1) return `${count} ${forms[0]}`;
  return `${count} ${forms[2]}`;
}

export const LETTERS = ['письмо', 'письма', 'писем'];
export const TASKS = ['задача', 'задачи', 'задач'];

export function displaySubject(task) {
  return (task && task.subject && task.subject.trim()) || '(без темы)';
}

export function displaySender(task) {
  if (!task) return '';
  const name = (task.senderName || '').trim();
  const email = (task.senderEmail || '').trim();
  if (name && email && name.toLowerCase() !== email.toLowerCase()) return `${name} · ${email}`;
  return name || email || 'отправитель не определён';
}
