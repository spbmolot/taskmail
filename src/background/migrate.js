/* Миграции схемы: задачи должны переживать обновление расширения. */

import { SCHEMA_VERSION, makeTask, timeZone } from '../common/model.js';
import { getTasks, replaceAll } from '../common/store.js';
import { toLocalStr, toDateStr } from '../common/datetime.js';
import { serviceOf } from '../common/hosts.js';

const SERVICE_BY_LABEL = {
  Gmail: 'gmail',
  'Яндекс Почта': 'yandex',
  'Mail.ru': 'mailru'
};

function serviceIdFrom(task) {
  if (task.serviceId) return task.serviceId;
  // В первой версии сервис хранился подписью на русском.
  if (SERVICE_BY_LABEL[task.service]) return SERVICE_BY_LABEL[task.service];
  return serviceOf(task.link || task.messageLink || '');
}

/** Приводит любую сохранённую задачу к актуальной схеме. */
function upgrade(task) {
  if (task.schemaVersion === SCHEMA_VERSION) return task;

  const upgraded = makeTask({
    ...task,
    schemaVersion: SCHEMA_VERSION,
    serviceId: serviceIdFrom(task),
    messageLink: task.messageLink || task.link || '',
    threadLink: task.threadLink || '',
    searchLink: task.searchLink || '',
    priority: task.priority || 'normal',
    remindTz: task.remindTz || timeZone()
  });

  if (task.remindAt && !upgraded.remindLocal) {
    upgraded.remindLocal = toLocalStr(new Date(task.remindAt));
  }
  if (upgraded.remindAt && !upgraded.dueLocal) {
    upgraded.dueLocal = toDateStr(new Date(upgraded.remindAt));
    upgraded.dueAt = upgraded.remindAt;
  }

  delete upgraded.link;
  delete upgraded.service;
  return upgraded;
}

export async function runMigrations() {
  const tasks = await getTasks();
  if (!tasks.length) return 0;

  const needed = tasks.some((task) => task.schemaVersion !== SCHEMA_VERSION);
  if (!needed) return 0;

  await replaceAll(tasks.map(upgrade));
  return tasks.length;
}
