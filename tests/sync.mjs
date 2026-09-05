/*
 * Тесты синхронизации между устройствами.
 *
 * Закреплены две ошибки, найденные ревью: слияние работало со снимком списка,
 * снятым до сетевых вызовов (сохранённая в это время задача пропадала), и
 * текст письма уезжал в chrome.storage.sync вопреки обещанию в окне задачи.
 */

import assert from 'node:assert';
import { installChromeMock, createRunner } from './mock-chrome.mjs';
import { makeTask } from '../src/common/model.js';

const { check, done } = createRunner('sync');

async function setup({ enabled = true } = {}) {
  const mock = installChromeMock();
  mock.settings({ syncEnabled: enabled });
  const sync = await import(`../src/background/sync.js?v=${Math.random()}`);
  const store = await import(`../src/common/store.js?v=${Math.random()}`);
  return { mock, ...sync, store };
}

const remote = (mock) =>
  [...mock.sync]
    .filter(([key]) => key.startsWith('task_'))
    .map(([, value]) => value);

await check('выключенная синхронизация ничего не пишет', async () => {
  const { mock, syncNow } = await setup({ enabled: false });
  mock.seed([makeTask({ subject: 'Локальная' })]);

  const result = await syncNow();

  assert.equal(result.skipped, true);
  assert.equal(mock.sync.size, 0);
});

await check('текст письма не уходит в синхронизацию', async () => {
  const { mock, pushAll } = await setup();
  mock.seed([
    makeTask({ subject: 'С фрагментом', comment: 'комментарий едет', excerpt: 'ТЕКСТ ПИСЬМА' })
  ]);

  await pushAll();

  const sent = remote(mock);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].excerpt, '', 'текст письма попал в chrome.storage.sync');
  assert.equal(sent[0].comment, 'комментарий едет', 'комментарий синхронизировать нужно');
});

await check('более свежая версия с другого устройства побеждает', async () => {
  const { mock, syncNow } = await setup();
  const task = makeTask({ id: 't1', subject: 'Старое название', updatedAt: 1000 });
  mock.seed([task]);
  mock.sync.set('task_t1', { ...task, subject: 'Новое название', updatedAt: 2000 });

  await syncNow();

  assert.equal(mock.tasks()[0].subject, 'Новое название');
});

await check('более свежая локальная версия уезжает на устройства', async () => {
  const { mock, syncNow } = await setup();
  const task = makeTask({ id: 't1', subject: 'Локальная правка', updatedAt: 5000 });
  mock.seed([task]);
  mock.sync.set('task_t1', { ...task, subject: 'Устаревшая', updatedAt: 1000 });

  await syncNow();

  assert.equal(mock.tasks()[0].subject, 'Локальная правка');
  assert.equal(mock.sync.get('task_t1').subject, 'Локальная правка');
});

await check('локальный текст письма переживает обновление с другого устройства', async () => {
  const { mock, syncNow } = await setup();
  const task = makeTask({ id: 't1', subject: 'Было', excerpt: 'ТЕКСТ ПИСЬМА', updatedAt: 1000 });
  mock.seed([task]);
  mock.sync.set('task_t1', { ...task, subject: 'Стало', excerpt: '', updatedAt: 2000 });

  await syncNow();

  assert.equal(mock.tasks()[0].subject, 'Стало');
  assert.equal(mock.tasks()[0].excerpt, 'ТЕКСТ ПИСЬМА', 'фрагмент затёрт пустым значением');
});

await check('удалённая задача не возвращается с другого устройства', async () => {
  const { mock, syncNow, store } = await setup();
  const task = makeTask({ id: 't1', subject: 'Удаляемая', updatedAt: 1000 });
  mock.seed([task]);
  mock.sync.set('task_t1', task);

  await store.removeTask('t1');
  await syncNow();

  assert.equal(mock.tasks().length, 0, 'задача воскресла');
  assert.equal(mock.sync.has('task_t1'), false, 'запись не удалена из синхронизации');
});

await check('задача, сохранённая во время синхронизации, не теряется', async () => {
  const { mock, syncNow, store } = await setup();
  const existing = makeTask({ id: 't1', subject: 'Была до синхронизации', updatedAt: 1000 });
  mock.seed([existing]);
  // С другого устройства пришло обновление — только в этом случае старый код
  // доходил до перезаписи списка и терял всё, что сохранили в это время.
  mock.sync.set('task_t1', { ...existing, subject: 'Обновлена на другом устройстве', updatedAt: 2000 });

  // Держим сетевой вызов открытым — ровно то окно, в котором раньше
  // сохранённая задача затиралась устаревшим снимком списка.
  let openGate;
  const gate = new Promise((resolve) => {
    openGate = resolve;
  });
  const original = mock.chrome.storage.sync.get.bind(mock.chrome.storage.sync);
  mock.chrome.storage.sync.get = async (keys) => {
    await gate;
    return original(keys);
  };

  const syncing = syncNow();
  await store.saveTask(makeTask({ id: 't2', subject: 'Создана во время синхронизации' }));
  openGate();
  await syncing;

  const subjects = mock.tasks().map((task) => task.subject).sort();
  assert.deepEqual(subjects, ['Обновлена на другом устройстве', 'Создана во время синхронизации']);
});

await check('повторный вход в синхронизацию не запускает второй проход', async () => {
  const { mock, syncNow } = await setup();
  mock.seed([makeTask({ id: 't1' })]);

  let gets = 0;
  const original = mock.chrome.storage.sync.get.bind(mock.chrome.storage.sync);
  mock.chrome.storage.sync.get = async (keys) => {
    gets += 1;
    await new Promise((resolve) => setTimeout(resolve, 10));
    return original(keys);
  };

  const [first, second] = await Promise.all([syncNow(), syncNow()]);

  assert.equal(gets, 1, 'два параллельных прохода читают удалённые данные дважды');
  assert.ok(first.ok || second.skipped, 'один проход должен отработать, второй — отклониться');
});

await check('квоты storage.sync соблюдаются, остаток остаётся локальным', async () => {
  const { mock, pushAll } = await setup();
  const many = Array.from({ length: 600 }, (_, index) =>
    makeTask({
      id: `t${index}`,
      subject: `Задача ${index} с довольно длинной темой, чтобы объём был реалистичным`,
      comment: 'Комментарий примерно такой длины, как пишут в жизни.'
    })
  );
  mock.seed(many);

  const result = await pushAll();
  const sent = remote(mock);

  assert.ok(sent.length <= 480, `в sync ушло ${sent.length} записей при лимите 512`);
  assert.ok(result.skipped > 0, 'пропущенные задачи не посчитаны');
  assert.equal(mock.meta().syncSkipped, result.skipped);

  const bytes = [...mock.sync].reduce(
    (total, [key, value]) => total + new TextEncoder().encode(key + JSON.stringify(value)).length,
    0
  );
  assert.ok(bytes <= 102400, `объём ${bytes} байт превышает квоту 100 КБ`);
  assert.equal(mock.tasks().length, 600, 'локальные задачи должны остаться все');
});

done();
