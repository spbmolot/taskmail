/*
 * Каждый обработчик сообщений, вызванный ровно так, как его вызывает интерфейс.
 *
 * Повод: SETTINGS_SET падал у пользователя, потому что срабатывает редко, а ни
 * один тест до него не доходил. Поэтому в конце набора стоит проверка полноты:
 * новый обработчик без теста уронит прогон.
 */

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { installChromeMock, createRunner } from './mock-chrome.mjs';
import { makeTask } from '../src/common/model.js';
import { toLocalStr } from '../src/common/datetime.js';

const { check, done } = createRunner('handlers');

const mock = installChromeMock();
const tested = new Set();

const mailTask = makeTask({
  id: 'task1',
  subject: 'Договор на поставку',
  senderEmail: 'a.kovaleva@partner.ru',
  serviceId: 'gmail',
  accountEmail: 'user@gmail.com',
  messageLink: 'https://mail.google.com/mail/u/0/#all/16be0868ae18c6a7',
  remindLocal: toLocalStr(new Date(Date.now() + 3600000)),
  remindAt: Date.now() + 3600000
});

mock.seed([mailTask]);
await import('../src/background/index.js');

/** Отправляет сообщение по той же шине, что popup и окно задачи. */
function call(type, payload = {}) {
  tested.add(type);
  return new Promise((resolve, reject) => {
    const [handled] = mock.fire('runtime.onMessage', { type, ...payload }, {}, resolve);
    if (handled !== true) reject(new Error(`обработчик ${type} не принял сообщение`));
  });
}

const lastWindow = () => mock.windows[mock.windows.length - 1];
const lastTab = () => mock.tabs[mock.tabs.length - 1];

await check('STATE_GET отдаёт задачи, настройки и часовой пояс', async () => {
  const response = await call('STATE_GET');
  assert.equal(response.ok, true);
  assert.equal(response.tasks.length, 1);
  assert.ok(response.settings.defaultReminderTime);
  assert.ok(response.timeZone);
});

await check('NEW_TASK_BLANK открывает окно с готовым черновиком', async () => {
  const response = await call('NEW_TASK_BLANK');
  assert.equal(response.ok, true);

  const url = lastWindow().url;
  assert.match(url, /editor\.html\?draft=/, url);

  const draftId = new URL(url).searchParams.get('draft');
  const draft = mock.session.get(draftId);
  assert.ok(draft.separate[0].remindLocal, 'срок по умолчанию не подставлен');
});

await check('EDITOR_OPEN открывает окно правки конкретной задачи', async () => {
  const response = await call('EDITOR_OPEN', { id: 'task1' });
  assert.equal(response.ok, true);
  assert.equal(new URL(lastWindow().url).searchParams.get('id'), 'task1');
  assert.equal(lastWindow().type, 'popup');
});

await check('DRAFT_GET и DRAFT_DROP работают с черновиком письма', async () => {
  await mock.chrome.storage.session.set({ draft_x: { mode: 'single', excerpt: 'текст письма' } });

  const got = await call('DRAFT_GET', { draftId: 'draft_x' });
  assert.equal(got.draft.excerpt, 'текст письма');

  await call('DRAFT_DROP', { draftId: 'draft_x' });
  assert.equal(mock.session.has('draft_x'), false, 'текст письма остался в памяти после отказа');

  const gone = await call('DRAFT_GET', { draftId: 'draft_x' });
  assert.equal(gone.draft, null);
});

await check('TASK_SAVE создаёт задачу и планирует напоминание', async () => {
  const remindLocal = toLocalStr(new Date(Date.now() + 7200000));
  const response = await call('TASK_SAVE', {
    task: makeTask({ id: 'task2', subject: 'Акт сверки', remindLocal })
  });

  assert.equal(response.task.subject, 'Акт сверки');
  assert.equal(response.task.remindAt, new Date(remindLocal).getTime());
  assert.equal(mock.tasks().length, 2);
  assert.ok(mock.alarms.get('taskmail:next'), 'будильник не выставлен');
});

await check('TASK_SAVE_MANY сохраняет несколько задач и чистит черновик', async () => {
  await mock.chrome.storage.session.set({ draft_many: { excerpt: 'текст' } });
  const response = await call('TASK_SAVE_MANY', {
    tasks: [makeTask({ id: 'm1', subject: 'Первое' }), makeTask({ id: 'm2', subject: 'Второе' })],
    draftId: 'draft_many'
  });

  assert.equal(response.tasks.length, 2);
  assert.equal(mock.session.has('draft_many'), false);
  assert.equal(mock.tasks().length, 4);
});

await check('TASK_TOGGLE отмечает выполненной и возвращает в работу', async () => {
  const finished = await call('TASK_TOGGLE', { id: 'task1', done: true });
  assert.equal(finished.task.done, true);
  assert.ok(finished.task.completedAt, 'дата выполнения не проставлена');

  const back = await call('TASK_TOGGLE', { id: 'task1', done: false });
  assert.equal(back.task.done, false);
  assert.equal(back.task.completedAt, null);
});

await check('TASK_SNOOZE переносит напоминание в будущее', async () => {
  const before = mock.tasks().find((task) => task.id === 'task1').remindAt;
  const response = await call('TASK_SNOOZE', { id: 'task1', minutes: 45 });

  assert.ok(response.task.remindAt > Date.now() + 44 * 60000);
  assert.notEqual(response.task.remindAt, before);
  assert.equal(response.task.lastNotifiedAt, null, 'отметка должна сброситься');
});

await check('TASK_OPEN открывает письмо новой вкладкой в нужном ящике', async () => {
  const response = await call('TASK_OPEN', { id: 'task1' });
  assert.equal(response.ok, true);
  assert.match(lastTab().url, /mail\.google\.com\/mail\/u\/user@gmail\.com\//, lastTab().url);
});

await check('TASK_OPEN с запасным путём ищет по отправителю, а не по теме', async () => {
  await call('TASK_OPEN', { id: 'task1', fallback: true });
  const url = decodeURIComponent(lastTab().url);
  assert.match(url, /from:a\.kovaleva@partner\.ru/, url);
  assert.ok(!url.includes('Договор'), 'тема не должна попадать в поиск');
});

await check('TASK_OPEN сообщает о ненайденной задаче, а не падает', async () => {
  const response = await call('TASK_OPEN', { id: 'нет такой' });
  assert.equal(response.ok, false);
  assert.match(response.error, /не найдена/);
});

await check('TASK_DELETE удаляет задачу и оставляет тумбстоун', async () => {
  const before = mock.tasks().length;
  const response = await call('TASK_DELETE', { id: 'm2' });

  assert.equal(response.ok, true);
  assert.equal(mock.tasks().length, before - 1);
  assert.ok(mock.local.get('tombstones').m2, 'без тумбстоуна задача вернётся с другого устройства');
});

await check('SETTINGS_SET сохраняет настройку и переключает синхронизацию', async () => {
  const changed = await call('SETTINGS_SET', { patch: { snoozeMinutes: 30 } });
  assert.equal(changed.settings.snoozeMinutes, 30);

  // Тот самый путь, что падал с TypeError: включение выгружает задачи.
  const enabled = await call('SETTINGS_SET', { patch: { syncEnabled: true } });
  assert.equal(enabled.settings.syncEnabled, true);
  assert.ok(mock.sync.size > 0, 'задачи не выгружены при включении синхронизации');

  const disabled = await call('SETTINGS_SET', { patch: { syncEnabled: false } });
  assert.equal(disabled.settings.syncEnabled, false);
  assert.equal(mock.sync.size, 0, 'удалённая копия не очищена при выключении');
});

await check('META_SET сохраняет служебные пометки интерфейса', async () => {
  const response = await call('META_SET', { patch: { timeZoneNotice: { seen: true } } });
  assert.equal(response.meta.timeZoneNotice.seen, true);
  assert.equal(mock.meta().timeZoneNotice.seen, true);
});

await check('NOTIFICATIONS_CHECK различает разрешение и запрет', async () => {
  const granted = await call('NOTIFICATIONS_CHECK');
  assert.equal(granted.blocked, false);

  mock.setPermissionLevel('denied');
  const denied = await call('NOTIFICATIONS_CHECK');
  assert.equal(denied.blocked, true);
  assert.equal(mock.meta().notificationsBlocked, true);
  mock.setPermissionLevel('granted');
});

await check('CREATE_FROM_ACTIVE_TAB требует вкладку почты', async () => {
  mock.tabs.length = 0;
  mock.tabs.push({ id: 9, url: 'https://example.com/', active: true, index: 0, windowId: 1 });

  const response = await call('CREATE_FROM_ACTIVE_TAB');
  assert.equal(response.ok, false);
  assert.match(response.error, /Gmail|Яндекс/);
});

await check('CREATE_FROM_ACTIVE_TAB собирает задачу из письма', async () => {
  mock.tabs.length = 0;
  mock.tabs.push({
    id: 10,
    url: 'https://mail.google.com/mail/u/0/#inbox',
    title: 'Входящие',
    active: true,
    index: 0,
    windowId: 1
  });
  mock.chrome.tabs.sendMessage = async () => ({
    serviceId: 'gmail',
    accountEmail: 'user@gmail.com',
    accountId: '0',
    mode: 'list',
    selection: [
      {
        subject: 'Счёт за хостинг',
        senderName: 'Timeweb',
        senderEmail: 'billing@timeweb.ru',
        messageId: 'zzz',
        messageLink: 'https://mail.google.com/mail/u/0/#all/zzz',
        threadLink: '',
        searchLink: '',
        partial: false
      }
    ]
  });

  const response = await call('CREATE_FROM_ACTIVE_TAB');
  assert.equal(response.ok, true);

  const draftId = new URL(lastWindow().url).searchParams.get('draft');
  assert.equal(mock.session.get(draftId).separate[0].subject, 'Счёт за хостинг');
});

await check('в наборе проверен каждый обработчик шины', () => {
  const source = readFileSync(new URL('../src/background/index.js', import.meta.url), 'utf8');
  const declared = [...source.matchAll(/^ {2}async ([A-Z_]+)\(/gm)].map((match) => match[1]);

  assert.ok(declared.length >= 15, `обработчиков найдено ${declared.length} — разбор списка сломался`);

  const missing = declared.filter((name) => !tested.has(name));
  assert.deepEqual(missing, [], `без теста остались: ${missing.join(', ')}`);
});

done();
