/*
 * Планировщик напоминаний.
 *
 * Вместо отдельного будильника на каждую задачу держим один alarm на ближайшее
 * напоминание плюс страховочный периодический alarm: так расширение не упирается
 * в лимиты chrome.alarms и корректно переживает перезапуск service worker.
 */

import { timeZone } from '../common/model.js';
import { getTasks, patchTask, setMeta, getMeta } from '../common/store.js';
import { getSettings, setSettings } from '../common/settings.js';
import { parseDateStr, parseLocalStr } from '../common/datetime.js';
import {
  notifyMissed,
  notifyTask,
  permissionLevel,
  recordUndelivered,
  updateBadge
} from './notify.js';

export const NEXT_ALARM = 'taskmail:next';
export const SAFETY_ALARM = 'taskmail:safety';

const SAFETY_PERIOD_MINUTES = 30;
const DUE_TOLERANCE_MS = 2000;
// Если напоминание опоздало больше чем на 5 минут — Chrome был закрыт или спал.
const MISSED_THRESHOLD_MS = 5 * 60 * 1000;
const GROUP_MISSED_FROM = 3;

/** Пересчитывает абсолютное время из «настенного» локального. */
export function computeTimes(task) {
  return {
    dueAt: parseDateStr(task.dueLocal),
    remindAt: parseLocalStr(task.remindLocal),
    remindTz: timeZone()
  };
}

export function isPending(task) {
  return !task.done && Boolean(task.remindAt);
}

function alreadyNotified(task) {
  return Boolean(task.lastNotifiedAt && task.remindAt && task.lastNotifiedAt >= task.remindAt);
}

/** Сколько задач требуют внимания: просроченные и сработавшие. */
function attentionCount(tasks, now) {
  return tasks.filter((task) => {
    if (task.done) return false;
    const at = task.remindAt || task.dueAt;
    return Boolean(at) && at <= now;
  }).length;
}

/** Ставит будильник на ближайшее напоминание и обновляет значок. */
export async function refreshSchedule() {
  const now = Date.now();
  const tasks = await getTasks();

  const upcoming = tasks
    .filter((task) => isPending(task) && !alreadyNotified(task))
    .map((task) => task.remindAt)
    .filter((at) => at > now);

  await chrome.alarms.clear(NEXT_ALARM);
  if (upcoming.length) {
    const when = Math.min(...upcoming);
    chrome.alarms.create(NEXT_ALARM, { when: Math.max(when, now + 1000) });
  }

  // Страховка: сон системы, скачки часов, пропущенный alarm.
  const safety = await chrome.alarms.get(SAFETY_ALARM);
  if (!safety) {
    chrome.alarms.create(SAFETY_ALARM, {
      periodInMinutes: SAFETY_PERIOD_MINUTES,
      delayInMinutes: SAFETY_PERIOD_MINUTES
    });
  }

  const meta = await getMeta();
  await updateBadge(attentionCount(tasks, now), Boolean(meta.notificationsBlocked));
}

let running = null;

/**
 * Показывает все наступившие напоминания. Долго накопившиеся (Chrome был закрыт)
 * сворачиваются в одно сводное уведомление, чтобы не заваливать пользователя.
 * Повторные вызовы (onStartup + пробуждение SW + alarm) разделяют один проход.
 */
export function processDue(options = {}) {
  if (running) return running;
  running = handleDue(options).finally(() => {
    running = null;
  });
  return running;
}

async function handleDue({ startup = false } = {}) {
  const now = Date.now();
  const settings = await getSettings();
  const tasks = await getTasks();

  const due = tasks
    .filter((task) => isPending(task) && task.remindAt <= now + DUE_TOLERANCE_MS && !alreadyNotified(task))
    .sort((a, b) => a.remindAt - b.remindAt);

  if (!due.length) {
    await refreshSchedule();
    return 0;
  }

  const level = await permissionLevel();
  const blocked = level !== 'granted';
  await setMeta({ notificationsBlocked: blocked });

  const missed = due.filter((task) => now - task.remindAt > MISSED_THRESHOLD_MS);
  const fresh = due.filter((task) => now - task.remindAt <= MISSED_THRESHOLD_MS);

  // Отметку «уведомлено» ставим ДО показа: service worker могут выгрузить в
  // середине, и при следующем пробуждении пользователь получил бы всё дважды.
  for (const task of due) {
    await patchTask(task.id, {
      lastNotifiedAt: now,
      missed: now - task.remindAt > MISSED_THRESHOLD_MS
    });
  }

  if (blocked) {
    for (const task of due) await recordUndelivered(task.id);
    await refreshSchedule();
    return due.length;
  }

  if (missed.length) {
    if (!settings.catchUpMissed) {
      // Пропущенные не показываем, но они остаются в разделе «Просроченные».
    } else if (missed.length >= GROUP_MISSED_FROM) {
      await notifyMissed(missed);
    } else {
      for (const task of missed) await notifyTask(task, settings.snoozeMinutes);
    }
  }

  for (const task of fresh) {
    const delivered = await notifyTask(task, settings.snoozeMinutes);
    if (!delivered) await recordUndelivered(task.id);
  }

  await refreshSchedule();
  return due.length;
}

/**
 * Смена часового пояса. По умолчанию сохраняем время суток: «завтра в 9:00»
 * остаётся девятью утра по новым часам, absolute epoch пересчитывается.
 */
export async function syncTimeZone() {
  const current = timeZone();
  const settings = await getSettings();
  const previous = settings.lastTimeZone;

  if (!previous) {
    await setSettings({ lastTimeZone: current });
    return { changed: false };
  }
  if (previous === current) return { changed: false };

  let updated = 0;
  if (settings.keepWallClock) {
    const tasks = await getTasks();
    for (const task of tasks) {
      if (task.done) continue;
      const times = computeTimes(task);
      if (times.remindAt !== task.remindAt || times.dueAt !== task.dueAt) {
        await patchTask(task.id, times);
        updated += 1;
      }
    }
  }

  await setSettings({ lastTimeZone: current });
  await setMeta({ timeZoneNotice: { from: previous, to: current, updated, at: Date.now() } });
  await refreshSchedule();
  return { changed: true, previous, current, updated };
}

/** Перенос напоминания на N минут вперёд от текущего момента. */
export function snoozeTimes(minutes) {
  const target = new Date(Date.now() + minutes * 60 * 1000);
  const pad = (value) => String(value).padStart(2, '0');
  const local = `${target.getFullYear()}-${pad(target.getMonth() + 1)}-${pad(target.getDate())}T${pad(
    target.getHours()
  )}:${pad(target.getMinutes())}`;
  return { remindLocal: local, remindAt: target.getTime(), lastNotifiedAt: null };
}
