/*
 * Уведомления: форма, ограничения платформы и деградация.
 * Chrome показывает не больше двух кнопок, а Windows режет длинный текст —
 * оба ограничения зафиксированы здесь, чтобы не всплыли при следующей правке.
 */

import assert from 'node:assert';
import { installChromeMock, createRunner } from './mock-chrome.mjs';
import { makeTask } from '../src/common/model.js';

const { check, done } = createRunner('notify');

async function setup(options = {}) {
  const mock = installChromeMock(options);
  const module = await import(`../src/background/notify.js?v=${Math.random()}`);
  return { mock, ...module };
}

const task = (fields = {}) =>
  makeTask({
    subject: 'Договор на поставку №451-Б',
    senderName: 'Анна Ковалёва',
    senderEmail: 'a.kovaleva@partner.ru',
    serviceId: 'gmail',
    remindAt: Date.now(),
    ...fields
  });

await check('уведомление о задаче: две кнопки и подсказка про третье действие', async () => {
  const { mock, notifyTask } = await setup();
  await notifyTask(task({ comment: 'Проверить пункт 4.2' }), 15);

  const { id, options } = mock.notifications[0];
  assert.ok(id.startsWith('taskmail:task:'), id);
  assert.equal(options.buttons.length, 2, 'Chrome отображает максимум две кнопки');
  assert.equal(options.buttons[0].title, 'Выполнено');
  assert.equal(options.buttons[1].title, 'Отложить на 15 мин');
  assert.match(options.contextMessage, /Нажмите/, 'третье действие должно быть объяснено');
  assert.match(options.message, /Анна Ковалёва/);
  assert.match(options.message, /Проверить пункт 4.2/);
});

await check('длинные тема и текст обрезаются под нативный toast', async () => {
  const { mock, notifyTask } = await setup();
  await notifyTask(task({ subject: 'Т'.repeat(300), comment: 'К'.repeat(500) }), 15);

  const { options } = mock.notifications[0];
  assert.ok(options.title.length <= 70, `заголовок ${options.title.length} символов`);
  assert.ok(options.message.length <= 180, `текст ${options.message.length} символов`);
  assert.ok(options.title.endsWith('…'), 'обрезка должна быть заметна');
});

await check('высокий приоритет поднимает важность, но остаётся в пределах Windows', async () => {
  const { mock, notifyTask } = await setup();
  await notifyTask(task({ priority: 'high' }), 15);
  await notifyTask(task({ id: 'x', priority: 'low' }), 15);

  for (const item of mock.notifications) {
    assert.ok(item.options.priority >= 0 && item.options.priority <= 2, 'на Windows допустимо 0..2');
  }
  assert.equal(mock.notifications[0].options.priority, 2);
});

await check('сводка по пропущенным перечисляет письма списком', async () => {
  const { mock, notifyMissed } = await setup();
  const tasks = [task(), task({ id: 'b', subject: 'Акт сверки' }), task({ id: 'c', subject: 'Счёт' })];

  await notifyMissed(tasks);

  const { options } = mock.notifications[0];
  assert.equal(options.type, 'list');
  assert.equal(options.title, 'Пропущенные напоминания: 3');
  assert.equal(options.items.length, 3);
});

await check('если список не поддерживается, показывается обычное уведомление', async () => {
  const { mock, notifyMissed } = await setup();
  // Часть платформ не умеет type: 'list' — Chrome сообщает об этом lastError.
  const original = mock.chrome.notifications.create;
  mock.chrome.notifications.create = (id, options, callback) => {
    if (options.type === 'list') {
      mock.chrome.runtime.lastError = { message: 'unsupported' };
      callback(undefined);
      mock.chrome.runtime.lastError = undefined;
      return;
    }
    original(id, options, callback);
  };

  const shown = await notifyMissed([task(), task({ id: 'b', subject: 'Акт сверки' })]);

  assert.equal(shown, true, 'запасной путь не сработал');
  assert.equal(mock.notifications[0].options.type, 'basic');
  assert.match(mock.notifications[0].options.message, /Договор/);
});

await check('значок: счётчик, ограничение 99+ и особый вид при запрете', async () => {
  const { mock, updateBadge } = await setup();

  await updateBadge(0, false);
  assert.equal(mock.badge.text, '', 'при нуле значок пустой');

  await updateBadge(7, false);
  assert.equal(mock.badge.text, '7');

  await updateBadge(250, false);
  assert.equal(mock.badge.text, '99+');

  await updateBadge(3, true);
  assert.match(mock.badge.title, /запрещены/, 'подсказка должна объяснять запрет');
});

await check('недоставленные накапливаются и снимаются по одной', async () => {
  const { mock, recordUndelivered, clearUndelivered } = await setup();

  await recordUndelivered('a');
  await recordUndelivered('b');
  await recordUndelivered('a');
  assert.deepEqual(mock.meta().undelivered, ['a', 'b'], 'дубликатов быть не должно');
  assert.equal(mock.meta().notificationsBlocked, true);

  await clearUndelivered('a');
  assert.deepEqual(mock.meta().undelivered, ['b']);
});

await check('id задачи вынимается только из своих уведомлений', async () => {
  const { taskIdFromNotification } = await setup();
  assert.equal(taskIdFromNotification('taskmail:task:t_42'), 't_42');
  assert.equal(taskIdFromNotification('taskmail:missed'), null);
  assert.equal(taskIdFromNotification('чужое уведомление'), null);
});

await check('запрет уведомлений виден расширению', async () => {
  const { permissionLevel } = await setup({ permissionLevel: 'denied' });
  assert.equal(await permissionLevel(), 'denied');
});

done();
