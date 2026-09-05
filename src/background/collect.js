/*
 * Сбор данных письма из вкладки и подготовка черновиков задач.
 * Здесь же решается, что делать с несколькими выделенными письмами и как
 * не сохранить текст письма без разрешения пользователя.
 */

import { LETTERS, makeTask, plural, serviceLabel } from '../common/model.js';
import { findDuplicates } from '../common/store.js';
import { defaultReminder } from '../common/datetime.js';

const EXTRACT_TIMEOUT_MS = 1500;

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve(null), ms))
  ]);
}

/** Спрашивает контент-скрипт; если он не внедрён — внедряет и повторяет. */
export async function collectFromTab(tab, info) {
  // Адресуемся к конкретному фрейму: в Gmail область чтения живёт в iframe,
  // и широковещательный запрос получил бы ответ от случайного фрейма.
  const options = info && info.frameId !== undefined ? { frameId: info.frameId } : undefined;
  // Флаг targeted говорит фрейму, что спрашивают именно его: тогда он отвечает
  // даже пустым. При широковещательном запросе пустые ответы вредны — они
  // опережают фрейм, в котором действительно открыто письмо.
  const ask = () =>
    chrome.tabs
      .sendMessage(tab.id, { type: 'TASKMAIL_EXTRACT', targeted: Boolean(options) }, options)
      .catch(() => null);

  let payload = await withTimeout(ask(), EXTRACT_TIMEOUT_MS);

  if (!payload) {
    try {
      await chrome.scripting.executeScript({
        target:
          info && info.frameId
            ? { tabId: tab.id, frameIds: [info.frameId] }
            : { tabId: tab.id, allFrames: true },
        files: ['src/content/extractor.js']
      });
      payload = await withTimeout(ask(), EXTRACT_TIMEOUT_MS);
    } catch (error) {
      console.warn('TaskMail: не удалось внедрить контент-скрипт', error);
    }
  }

  return payload;
}

function fromTabFallback(tab, info) {
  const url = (info && info.pageUrl) || tab.url || '';
  const serviceId = url.includes('mail.google.com')
    ? 'gmail'
    : url.includes('yandex.')
      ? 'yandex'
      : url.includes('mail.ru')
        ? 'mailru'
        : 'other';
  return {
    serviceId,
    accountId: '',
    accountEmail: '',
    mode: 'unknown',
    selection: [
      {
        subject: (tab.title || '').replace(/^\(\d+\)\s*/, '').trim(),
        senderName: '',
        senderEmail: '',
        messageId: '',
        threadId: '',
        messageLink: url,
        threadLink: '',
        searchLink: '',
        partial: true
      }
    ]
  };
}

function toTask(entry, payload, settings) {
  return makeTask({
    subject: entry.subject || '',
    senderName: entry.senderName || '',
    senderEmail: entry.senderEmail || '',
    serviceId: entry.serviceId || payload.serviceId || 'other',
    accountId: entry.accountId || payload.accountId || '',
    accountEmail: entry.accountEmail || payload.accountEmail || '',
    messageId: entry.messageId || '',
    threadId: entry.threadId || '',
    messageLink: entry.messageLink || '',
    threadLink: entry.threadLink || '',
    searchLink: entry.searchLink || '',
    useThreadLink: Boolean(entry.threadLink && !entry.messageLink),
    priority: settings.defaultPriority || 'normal'
  });
}

function combine(entries, payload, settings) {
  const subjects = entries.map((entry) => entry.subject || '(без темы)');
  const task = toTask(entries[0], payload, settings);
  task.subject = `${plural(entries.length, LETTERS)}: ${subjects[0]}${entries.length > 1 ? ' и др.' : ''}`;
  task.items = entries.map((entry) => ({
    subject: entry.subject || '',
    senderName: entry.senderName || '',
    senderEmail: entry.senderEmail || '',
    messageLink: entry.messageLink || entry.threadLink || '',
    threadLink: entry.threadLink || '',
    messageId: entry.messageId || '',
    threadId: entry.threadId || '',
    done: false
  }));
  return task;
}

/**
 * Черновик для окна задачи.
 * mode: 'single' — одно письмо; 'choose' — выделено несколько и нужно решение
 * пользователя; 'separate' / 'combined' — решение уже принято через подменю.
 */
export async function buildDrafts(rawPayload, { mode, info, tab, settings }) {
  const payload = rawPayload && rawPayload.selection && rawPayload.selection.length
    ? rawPayload
    : fromTabFallback(tab, info);

  const entries = payload.selection;
  const many = entries.length > 1;
  const resolvedMode = many ? (mode === 'auto' ? 'choose' : mode) : 'single';

  const separate = entries.map((entry) => toTask(entry, payload, settings));
  const combined = many ? combine(entries, payload, settings) : separate[0];

  // Срок по умолчанию — чтобы задача создавалась в три клика.
  const preset = defaultReminder(settings.defaultReminderTime);
  for (const task of [...separate, combined]) {
    if (!task.dueLocal) Object.assign(task, preset);
  }

  const duplicates = [];
  for (const task of separate) {
    const found = await findDuplicates(task);
    if (found.length) {
      duplicates.push({
        messageId: task.messageId || task.threadId || task.messageLink,
        subject: task.subject,
        tasks: found.map((item) => ({
          id: item.id,
          subject: item.subject,
          done: item.done,
          remindAt: item.remindAt,
          createdAt: item.createdAt
        }))
      });
    }
  }

  return {
    mode: resolvedMode,
    serviceLabel: serviceLabel(payload.serviceId),
    partial: entries.some((entry) => entry.partial),
    context: payload.mode || 'unknown',
    // Выделенный текст письма НЕ сохраняется автоматически: пользователь должен
    // явно согласиться прикрепить его к задаче (или включить это в настройках).
    excerpt: info && info.selectionText ? info.selectionText.slice(0, 1000) : '',
    excerptAllowed: Boolean(settings.saveExcerpt),
    separate,
    combined,
    duplicates
  };
}
