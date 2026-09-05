/*
 * Дымовой тест точки входа service worker.
 *
 * Самая дорогая поломка расширения — та, при которой оно вообще не грузится:
 * ссылка на удалённый экспорт, обращение к chrome.* до регистрации слушателя,
 * опечатка в имени обработчика. `node --check` такое не ловит — он проверяет
 * только синтаксис. Здесь фоновый скрипт действительно исполняется на моке.
 */

import assert from 'node:assert';
import { installChromeMock, createRunner } from './mock-chrome.mjs';
import { makeTask } from '../src/common/model.js';

const { check, done } = createRunner('boot');

const mock = installChromeMock();
mock.seed([makeTask({ subject: 'Уже была', remindAt: Date.now() + 3600000 })]);

// Именно исполнение модуля: любая ошибка на верхнем уровне свалит импорт.
const background = await import('../src/background/index.js');

await check('фоновый скрипт исполняется без ошибок', () => {
  assert.ok(background, 'модуль не загрузился');
});

await check('слушатели зарегистрированы синхронно при загрузке', () => {
  // MV3 требует регистрации на верхнем уровне: иначе событие, разбудившее
  // service worker, будет потеряно.
  for (const name of [
    'runtime.onInstalled',
    'runtime.onStartup',
    'runtime.onMessage',
    'contextMenus.onClicked',
    'commands.onCommand',
    'alarms.onAlarm',
    'notifications.onClicked',
    'notifications.onButtonClicked'
  ]) {
    assert.ok((mock.listeners.get(name) || []).length > 0, `нет слушателя ${name}`);
  }
});

await check('установка создаёт пункт контекстного меню', async () => {
  mock.fire('runtime.onInstalled', { reason: 'install' });
  await new Promise((resolve) => setTimeout(resolve, 20));

  const menu = [...mock.menus.values()][0];
  assert.ok(menu, 'пункт меню не создан');
  assert.equal(menu.title, 'Создать задачу');
  assert.ok(menu.documentUrlPatterns.includes('https://mail.360.yandex.ru/*'));
});

await check('шина сообщений отвечает на запрос состояния', async () => {
  const response = await new Promise((resolve) => {
    const [handled] = mock.fire('runtime.onMessage', { type: 'STATE_GET' }, {}, resolve);
    assert.equal(handled, true, 'обработчик должен вернуть true для асинхронного ответа');
  });

  assert.equal(response.ok, true);
  assert.equal(response.tasks.length, 1);
  assert.ok(response.settings.defaultReminderTime, 'настройки не отданы');
});

await check('неизвестное сообщение не занимает канал ответа', () => {
  const [handled] = mock.fire('runtime.onMessage', { type: 'ЧЕГО-ТО-НЕТ' }, {}, () => {});
  assert.equal(handled, false, 'канал должен закрываться сразу');
});

await check('горячая клавиша на непочтовой вкладке объясняет причину', async () => {
  mock.tabs.push({ id: 1, url: 'https://example.com/', active: true, index: 0, windowId: 1 });
  mock.fire('commands.onCommand', 'create-task');
  await new Promise((resolve) => setTimeout(resolve, 30));

  const problem = mock.notifications.find((item) => item.id.startsWith('taskmail:problem'));
  assert.ok(problem, 'молчаливый отказ выглядит как «расширение не работает»');
  assert.match(problem.options.message, /Gmail|Яндекс/);
});

done();
