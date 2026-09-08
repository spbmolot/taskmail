/*
 * Тесты планировщика напоминаний. Модуль трогает chrome.alarms,
 * chrome.notifications и хранилище, поэтому импортируется динамически — уже
 * после установки мока.
 *
 * Отдельно закреплены ошибки, найденные ревью: отметка «уведомлено» ставилась
 * ПОСЛЕ показа (выгрузка service worker в середине давала дубли), а сводка по
 * пропущенным и запрет уведомлений не проверялись вовсе.
 */

import assert from 'node:assert';
import { installChromeMock, createRunner } from './mock-chrome.mjs';
import { makeTask } from '../src/common/model.js';
import { toLocalStr } from '../src/common/datetime.js';

const { check, done } = createRunner('reminders');

const MINUTE = 60000;

/** Задача с напоминанием через N минут от текущего момента (N<0 — в прошлом). */
function taskAt(minutes, fields = {}) {
  const at = new Date(Date.now() + minutes * MINUTE);
  return makeTask({
    subject: `Письмо ${minutes}`,
    senderEmail: 'a@b.c',
    remindAt: at.getTime(),
    remindLocal: toLocalStr(at),
    dueAt: at.getTime(),
    ...fields
  });
}

/** Свежий мок + свежий модуль: у reminders есть внутренний флаг running. */
async function setup(options = {}) {
  const mock = installChromeMock(options);
  const module = await import(`../src/background/reminders.js?v=${Math.random()}`);
  return { mock, ...module };
}

await check('ближайшее напоминание становится будильником, страховочный создаётся один раз', async () => {
  const { mock, refreshSchedule, NEXT_ALARM, SAFETY_ALARM } = await setup();
  const soon = taskAt(30);
  mock.seed([taskAt(120), soon, taskAt(600)]);

  await refreshSchedule();

  assert.equal(mock.alarms.get(NEXT_ALARM).when, soon.remindAt, 'выбран не ближайший срок');
  assert.equal(mock.alarms.get(SAFETY_ALARM).periodInMinutes, 30);

  const safety = mock.alarms.get(SAFETY_ALARM);
  await refreshSchedule();
  assert.equal(mock.alarms.get(SAFETY_ALARM), safety, 'страховочный будильник пересоздан');
});

await check('без будущих напоминаний будильник снимается', async () => {
  const { mock, refreshSchedule, NEXT_ALARM } = await setup();
  mock.seed([taskAt(60, { done: true }), taskAt(-10, { lastNotifiedAt: Date.now() })]);

  await refreshSchedule();
  assert.equal(mock.alarms.get(NEXT_ALARM), undefined);
});

await check('значок показывает число задач, требующих внимания', async () => {
  const { mock, refreshSchedule } = await setup();
  mock.seed([taskAt(-30), taskAt(-5), taskAt(60), taskAt(-90, { done: true })]);

  await refreshSchedule();
  assert.equal(mock.badge.text, '2');
});

await check('отметка «уведомлено» ставится ДО показа уведомления', async () => {
  const { mock, processDue } = await setup();
  mock.seed([taskAt(-1)]);

  let markedBeforeShow = null;
  mock.hooks.beforeNotify = () => {
    markedBeforeShow = Boolean(mock.tasks()[0].lastNotifiedAt);
  };

  await processDue();

  assert.equal(mock.notifications.length, 1, 'уведомление не показано');
  assert.equal(
    markedBeforeShow,
    true,
    'отметка поставлена после показа: выгрузка service worker даст повторное уведомление'
  );
});

await check('повторный проход не уведомляет второй раз', async () => {
  const { mock, processDue } = await setup();
  mock.seed([taskAt(-1)]);

  await processDue();
  await processDue();

  assert.equal(mock.notifications.length, 1);
});

await check('три и более пропущенных сворачиваются в одно сводное уведомление', async () => {
  const { mock, processDue } = await setup();
  mock.seed([taskAt(-60), taskAt(-90), taskAt(-120), taskAt(-1)]);

  await processDue();

  const list = mock.notifications.filter((item) => item.options.type === 'list');
  const basic = mock.notifications.filter((item) => item.options.type === 'basic');
  assert.equal(list.length, 1, 'нет сводки по пропущенным');
  assert.equal(list[0].options.title, 'Пропущенные напоминания: 3');
  assert.equal(basic.length, 1, 'свежее напоминание должно прийти отдельным уведомлением');
});

await check('при выключенных догоняющих пропущенные не показываются, но помечаются', async () => {
  const { mock, processDue } = await setup();
  mock.settings({ catchUpMissed: false });
  mock.seed([taskAt(-60), taskAt(-90), taskAt(-120)]);

  await processDue();

  assert.equal(mock.notifications.length, 0);
  assert.ok(
    mock.tasks().every((task) => task.lastNotifiedAt && task.missed),
    'задачи должны быть помечены пропущенными'
  );
});

await check('при запрете уведомлений задача попадает в список недоставленных', async () => {
  const { mock, processDue } = await setup({ permissionLevel: 'denied' });
  const task = taskAt(-1);
  mock.seed([task]);

  await processDue();

  assert.equal(mock.notifications.length, 0, 'уведомление не должно создаваться');
  assert.equal(mock.meta().notificationsBlocked, true);
  assert.deepEqual(mock.meta().undelivered, [task.id]);
  assert.equal(mock.badge.text, '1', 'значок остаётся единственным сигналом');
});

await check('смена часового пояса пересчитывает напоминание по «настенному» времени', async () => {
  const { mock, syncTimeZone } = await setup();
  mock.settings({ lastTimeZone: 'America/New_York', keepWallClock: true });

  const local = toLocalStr(new Date(Date.now() + 3 * 3600000));
  mock.seed([makeTask({ subject: 'Из другого пояса', remindLocal: local, remindAt: 1 })]);

  const result = await syncTimeZone();

  assert.equal(result.changed, true);
  assert.equal(result.updated, 1);
  assert.notEqual(mock.tasks()[0].remindAt, 1, 'время не пересчитано');
  assert.equal(mock.meta().timeZoneNotice.from, 'America/New_York');
});

await check('без «сохранять время суток» напоминание не двигается', async () => {
  const { mock, syncTimeZone } = await setup();
  mock.settings({ lastTimeZone: 'America/New_York', keepWallClock: false });
  mock.seed([makeTask({ remindLocal: toLocalStr(new Date()), remindAt: 1 })]);

  await syncTimeZone();
  assert.equal(mock.tasks()[0].remindAt, 1);
});

await check('перенос напоминания уводит его в будущее и снимает отметку', async () => {
  const { snoozeTimes } = await setup();
  const patch = snoozeTimes(15);

  assert.ok(patch.remindAt > Date.now() + 14 * MINUTE);
  assert.equal(patch.lastNotifiedAt, null);
  assert.equal(patch.remindLocal.slice(0, 4), String(new Date().getFullYear()));
});

await check('нечисловая задержка не превращает напоминание в NaN', async () => {
  const { snoozeTimes } = await setup();

  // Значение приходит из настроек и из кнопки уведомления. remindAt = NaN
  // сохранился бы как null, и задача навсегда выпала бы из расписания.
  for (const bad of [undefined, null, '', 'пятнадцать', 0, -5]) {
    const patch = snoozeTimes(bad);
    assert.ok(Number.isFinite(patch.remindAt), `remindAt при ${JSON.stringify(bad)}`);
    assert.ok(patch.remindAt > Date.now(), 'перенос обязан быть в будущее');
    assert.ok(!patch.remindLocal.includes('NaN'), patch.remindLocal);
  }
});

done();
