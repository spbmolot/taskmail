/*
 * Уведомления. Chrome разрешает не более двух кнопок в уведомлении, поэтому
 * третье действие «Открыть письмо» повешено на клик по телу уведомления
 * (об этом написано в contextMessage). Если уведомления запрещены — деградируем
 * до значка на иконке и баннера в popup.
 */

import { displaySender, displaySubject, priorityInfo, serviceLabel } from '../common/model.js';
import { formatWhen } from '../common/datetime.js';
import { getMeta, setMeta } from '../common/store.js';

export const TASK_NOTIFICATION = 'taskmail:task:';
export const MISSED_NOTIFICATION = 'taskmail:missed';

const ICON = chrome.runtime.getURL('icons/icon128.png');

export function taskIdFromNotification(notificationId) {
  return notificationId.startsWith(TASK_NOTIFICATION)
    ? notificationId.slice(TASK_NOTIFICATION.length)
    : null;
}

/**
 * Уровень разрешения внутри Chrome. Системный запрет (Windows: «Уведомления»
 * или «Фокусировка внимания») отсюда не виден — create() всё равно вернёт id,
 * поэтому список задач и значок на иконке остаются обязательным запасным путём.
 */
export async function permissionLevel() {
  return new Promise((resolve) => {
    try {
      chrome.notifications.getPermissionLevel((level) => resolve(level));
    } catch (error) {
      resolve('denied');
    }
  });
}

function create(id, options) {
  return new Promise((resolve) => {
    chrome.notifications.create(id, options, (createdId) => {
      // Ошибку глотаем осознанно: уведомления могут быть запрещены системой.
      const error = chrome.runtime.lastError;
      resolve(error ? null : createdId);
    });
  });
}

function trim(value, limit) {
  const text = (value || '').replace(/\s+/g, ' ').trim();
  return text.length > limit ? text.slice(0, limit - 1) + '…' : text;
}

export async function notifyTask(task, snoozeMinutes) {
  const lines = [];
  const sender = displaySender(task);
  if (sender) lines.push(`От: ${sender}`);
  if (task.items && task.items.length) lines.push(`Писем в задаче: ${task.items.length}`);
  if (task.comment) lines.push(task.comment);
  if (task.priority !== 'normal') lines.push(`Приоритет: ${priorityInfo(task.priority).label}`);

  // На Windows нативный toast показывает примерно строку заголовка и две
  // строки текста — остальное обрезает система, поэтому режем сами.
  const created = await create(TASK_NOTIFICATION + task.id, {
    type: 'basic',
    iconUrl: ICON,
    title: trim(displaySubject(task), 70),
    message: trim(lines.join('\n'), 180) || serviceLabel(task.serviceId),
    contextMessage: 'Нажмите на уведомление, чтобы открыть письмо',
    priority: task.priority === 'high' ? 2 : 1,
    requireInteraction: true,
    silent: false,
    buttons: [{ title: 'Выполнено' }, { title: `Отложить на ${snoozeMinutes} мин` }]
  });

  return Boolean(created);
}

/** Сводка вместо десятка уведомлений — например, после долгого простоя Chrome. */
export async function notifyMissed(tasks) {
  const items = tasks.slice(0, 5).map((task) => ({
    title: trim(displaySubject(task), 60),
    message: formatWhen(task.remindAt) || ''
  }));

  const options = {
    type: 'list',
    iconUrl: ICON,
    title: `Пропущенные напоминания: ${tasks.length}`,
    message: `Пока Chrome был закрыт, наступил срок ${tasks.length} задач`,
    contextMessage: 'Нажмите, чтобы открыть список задач',
    priority: 2,
    requireInteraction: true,
    items
  };

  const created = await create(MISSED_NOTIFICATION, options);
  if (created) return true;

  // На части платформ type: 'list' не поддерживается — падаем в basic.
  const { items: _list, ...basic } = options;
  return Boolean(
    await create(MISSED_NOTIFICATION, {
      ...basic,
      type: 'basic',
      message: trim(items.map((item) => item.title).join(' · '), 180) || options.message
    })
  );
}

/** Короткое уведомление о том, почему задача не создалась. */
export async function notifyProblem(reason) {
  await create(`taskmail:problem:${Date.now()}`, {
    type: 'basic',
    iconUrl: ICON,
    title: 'TaskMail: не удалось создать задачу',
    message: trim(reason || 'письмо не распознано', 180),
    priority: 1
  });
}

/** Значок на иконке: число просроченных/сработавших задач. */
export async function updateBadge(count, blocked) {
  const text = count > 0 ? (count > 99 ? '99+' : String(count)) : '';
  try {
    await chrome.action.setBadgeText({ text });
    await chrome.action.setBadgeBackgroundColor({ color: blocked ? '#b45309' : '#e11d48' });
    await chrome.action.setTitle({
      title: blocked
        ? 'TaskMail: уведомления запрещены, задачи ждут в списке'
        : count > 0
          ? `TaskMail: ${count} задач требуют внимания`
          : 'TaskMail'
    });
  } catch (error) {
    console.warn('TaskMail: не удалось обновить значок', error);
  }
}

/** Запоминаем факт «уведомление не доставлено», чтобы popup показал баннер. */
export async function recordUndelivered(taskId) {
  const meta = await getMeta();
  const undelivered = new Set(meta.undelivered || []);
  undelivered.add(taskId);
  await setMeta({ undelivered: [...undelivered], notificationsBlocked: true });
}

export async function clearUndelivered(taskId) {
  const meta = await getMeta();
  if (!meta.undelivered || !meta.undelivered.length) return;
  await setMeta({ undelivered: meta.undelivered.filter((id) => id !== taskId) });
}
