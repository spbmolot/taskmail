/*
 * Данные-образцы для снимков в магазин: chrome.* подменяется, интерфейс
 * настоящий — те же HTML, CSS и скрипты, что уезжают в пакет.
 */

(() => {
  const now = Date.now();
  const pad = (value) => String(value).padStart(2, '0');
  const iso = (at) => {
    const d = new Date(at);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };

  const task = (fields) => ({
    id: Math.random().toString(36).slice(2),
    schemaVersion: 2,
    subject: '',
    senderName: '',
    senderEmail: '',
    serviceId: 'gmail',
    accountId: '',
    accountEmail: 'ivan@example.com',
    messageId: 'm1',
    threadId: '',
    messageLink: 'https://mail.google.com/mail/u/0/#all/16be0868ae18c6a7',
    threadLink: '',
    searchLink: 'https://mail.google.com/mail/u/0/#search/x',
    useThreadLink: false,
    comment: '',
    excerpt: '',
    priority: 'normal',
    dueLocal: null,
    dueAt: null,
    remindLocal: null,
    remindAt: null,
    items: null,
    done: false,
    createdAt: now - 86400000,
    updatedAt: now,
    completedAt: null,
    lastNotifiedAt: null,
    ...fields
  });

  const at = (task_, offset) => ({
    ...task_,
    remindAt: now + offset,
    remindLocal: iso(now + offset),
    dueAt: now + offset,
    dueLocal: iso(now + offset).slice(0, 10)
  });

  const tasks = [
    at(
      task({
        subject: 'Договор на поставку №451-Б — нужна подпись',
        senderName: 'Анна Ковалёва',
        senderEmail: 'a.kovaleva@partner.ru',
        priority: 'high',
        comment: 'Проверить пункт 4.2 про сроки и передать в бухгалтерию'
      }),
      -3 * 3600000
    ),
    at(
      task({
        subject: 'Счёт за хостинг, сентябрь',
        senderName: 'Timeweb',
        senderEmail: 'billing@timeweb.ru',
        serviceId: 'yandex',
        accountEmail: 'ivan@yandex.ru'
      }),
      2 * 3600000
    ),
    at(
      task({
        subject: 'Материалы к планёрке по релизу 3.0',
        senderName: 'Дмитрий Орлов',
        senderEmail: 'd.orlov@company.com',
        comment: 'Собрать статусы по трём письмам',
        items: [{ subject: 'a' }, { subject: 'b' }, { subject: 'c' }]
      }),
      4 * 3600000
    ),
    at(
      task({
        subject: 'Оферта на продление лицензии',
        senderName: 'Контур',
        senderEmail: 'sales@kontur.ru',
        priority: 'low'
      }),
      3 * 86400000
    ),
    at(
      task({
        subject: 'Отправить документы в банк',
        senderName: 'Ольга Панина',
        senderEmail: 'o.panina@bank.ru',
        done: true,
        completedAt: now - 5 * 3600000
      }),
      -8 * 3600000
    )
  ];

  const settings = {
    defaultReminderTime: '09:00',
    defaultPriority: 'normal',
    snoozeMinutes: 15,
    saveExcerpt: false,
    keepWallClock: true,
    catchUpMissed: true,
    syncEnabled: false
  };

  const draft = {
    mode: 'single',
    serviceLabel: 'Gmail',
    partial: false,
    excerpt: '',
    excerptAllowed: false,
    duplicates: [],
    separate: [
      at(
        task({
          subject: 'Договор на поставку №451-Б — нужна подпись',
          senderName: 'Анна Ковалёва',
          senderEmail: 'a.kovaleva@partner.ru'
        }),
        3 * 3600000
      )
    ]
  };
  draft.combined = draft.separate[0];

  window.chrome = {
    runtime: {
      sendMessage: async (message) => {
        if (message.type === 'STATE_GET') {
          return { ok: true, tasks, settings, meta: {}, timeZone: 'Europe/Moscow' };
        }
        if (message.type === 'DRAFT_GET') return { ok: true, draft };
        return { ok: true };
      },
      getURL: (path) => path
    },
    storage: { onChanged: { addListener() {} } },
    tabs: { query: async () => [] },
    commands: { getAll: async () => [{ name: 'create-task', shortcut: 'Ctrl+Shift+S' }] }
  };
})();
