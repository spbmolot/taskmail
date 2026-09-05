/*
 * Миграции: задачи, созданные первой версией, должны пережить обновление
 * расширения и открыться в новом интерфейсе без потерь.
 */

import assert from 'node:assert';
import { installChromeMock, createRunner } from './mock-chrome.mjs';
import { makeTask } from '../src/common/model.js';
import { parseLocalStr } from '../src/common/datetime.js';

const { check, done } = createRunner('migrate');

async function setup() {
  const mock = installChromeMock();
  const module = await import(`../src/background/migrate.js?v=${Math.random()}`);
  return { mock, ...module };
}

/** Задача в формате первой версии: подпись сервиса, одна ссылка, только remindAt. */
const legacy = (fields = {}) => ({
  id: 'old1',
  subject: 'Счёт за хостинг',
  senderName: 'Timeweb',
  senderEmail: 'billing@timeweb.ru',
  link: 'https://mail.yandex.ru/#message/17612345',
  service: 'Яндекс Почта',
  comment: 'оплатить',
  remindAt: new Date(2026, 8, 20, 9, 0).getTime(),
  done: false,
  createdAt: 1700000000000,
  completedAt: null,
  ...fields
});

await check('старая задача приводится к новой схеме без потери данных', async () => {
  const { mock, runMigrations } = await setup();
  const before = legacy();
  mock.seed([before]);

  const count = await runMigrations();
  const [task] = mock.tasks();

  assert.equal(count, 1);
  assert.equal(task.schemaVersion, 2);
  assert.equal(task.subject, before.subject);
  assert.equal(task.comment, before.comment);
  assert.equal(task.createdAt, before.createdAt, 'дата создания должна сохраниться');
  assert.equal(task.serviceId, 'yandex', 'подпись сервиса переведена в идентификатор');
  assert.equal(task.messageLink, before.link, 'ссылка перенесена в новое поле');
  assert.equal(task.priority, 'normal', 'приоритета в первой версии не было');
  assert.equal(task.link, undefined, 'старое поле должно исчезнуть');
  assert.equal(task.service, undefined);
});

await check('время напоминания превращается в «настенное» и остаётся тем же', async () => {
  const { mock, runMigrations } = await setup();
  mock.seed([legacy()]);

  await runMigrations();
  const [task] = mock.tasks();

  assert.ok(task.remindLocal, 'локальное время не заполнено');
  assert.equal(parseLocalStr(task.remindLocal), task.remindAt, 'момент напоминания сдвинулся');
  assert.equal(task.dueLocal, task.remindLocal.slice(0, 10), 'срок выводится из напоминания');
  assert.ok(task.remindTz, 'часовой пояс не записан');
});

await check('сервис определяется по ссылке, если подписи не было', async () => {
  const { mock, runMigrations } = await setup();
  mock.seed([
    legacy({ id: 'a', service: undefined, link: 'https://mail.google.com/mail/u/0/#inbox/16be08' }),
    legacy({ id: 'b', service: undefined, link: 'https://e.mail.ru/inbox/0:1234/' }),
    legacy({ id: 'c', service: undefined, link: 'https://example.com/письмо' })
  ]);

  await runMigrations();
  const ids = Object.fromEntries(mock.tasks().map((task) => [task.id, task.serviceId]));

  assert.deepEqual(ids, { a: 'gmail', b: 'mailru', c: 'other' });
});

await check('повторный запуск ничего не трогает', async () => {
  const { mock, runMigrations } = await setup();
  mock.seed([legacy()]);

  await runMigrations();
  const first = JSON.stringify(mock.tasks());
  const count = await runMigrations();

  assert.equal(count, 0, 'вторая миграция не должна выполняться');
  assert.equal(JSON.stringify(mock.tasks()), first, 'данные изменились при повторном проходе');
});

await check('актуальные задачи проходят мимо миграции', async () => {
  const { mock, runMigrations } = await setup();
  mock.seed([makeTask({ subject: 'Новая' })]);

  assert.equal(await runMigrations(), 0);
  assert.equal(mock.tasks()[0].subject, 'Новая');
});

await check('пустое хранилище не ломает запуск', async () => {
  const { runMigrations } = await setup();
  assert.equal(await runMigrations(), 0);
});

done();
