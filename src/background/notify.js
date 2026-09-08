/*
 * Уведомления. Chrome разрешает не более двух кнопок в уведомлении, поэтому
 * третье действие «Открыть письмо» повешено на клик по телу уведомления
 * (об этом написано в contextMessage). Если уведомления запрещены — деградируем
 * до значка на иконке и баннера в popup.
 */

import { displaySender, displaySubject, priorityInfo, serviceLabel } from '../common/model.js';
import { formatWhen } from '../common/datetime.js';
import { getMeta, setMeta } from '../common/store.js';

const TASK_NOTIFICATION = 'taskmail:task:';
export const MISSED_NOTIFICATION = 'taskmail:missed';

/*
 * Метка показа в конце id. Chrome считает create() с уже существующим id
 * ОБНОВЛЕНИЕМ уведомления, а обновление на Windows не всплывает заново — оно
 * молча подменяет запись в центре уведомлений. Из-за этого повторное
 * напоминание после «Отложить» пользователь просто не видел. Теперь каждый
 * показ получает свой id, а прошлый показ снимается вручную.
 * В id задачи (t_<base36>_<случайное>) решётки не бывает — разбор однозначен.
 */
const SHOW_MARK = '#';

const ICON = chrome.runtime.getURL('icons/icon128.png');

export function taskIdFromNotification(notificationId) {
  if (typeof notificationId !== 'string' || !notificationId.startsWith(TASK_NOTIFICATION)) return null;
  return notificationId.slice(TASK_NOTIFICATION.length).split(SHOW_MARK)[0] || null;
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

function clearOne(id) {
  return new Promise((resolve) => {
    try {
      chrome.notifications.clear(id, () => {
        void chrome.runtime.lastError;
        resolve();
      });
    } catch (error) {
      resolve();
    }
  });
}

/** Снимает предыдущие показы этой задачи, чтобы они не копились в центре уведомлений. */
export async function clearTaskNotifications(taskId) {
  const own = TASK_NOTIFICATION + taskId;
  try {
    const all = await chrome.notifications.getAll();
    const stale = Object.keys(all || {}).filter(
      (id) => id === own || id.startsWith(own + SHOW_MARK)
    );
    await Promise.all(stale.map(clearOne));
  } catch (error) {
    // getAll есть не во всех сборках — снимаем хотя бы уведомление со старым id.
    await clearOne(own);
  }
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

  // Предыдущий показ этой же задачи убираем сами: иначе новый id добавит в
  // центр уведомлений второй экземпляр той же задачи.
  await clearTaskNotifications(task.id);

  // На Windows нативный toast показывает примерно строку заголовка и две
  // строки текста — остальное обрезает система, поэтому режем сами.
  const created = await create(`${TASK_NOTIFICATION}${task.id}${SHOW_MARK}${Date.now().toString(36)}`, {
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

/** Короткое уведомление о том, что пошло не так: молчаливый отказ выглядит поломкой. */
export async function notifyProblem(reason, title = 'TaskMail: не удалось создать задачу') {
  await create(`taskmail:problem:${Date.now()}`, {
    type: 'basic',
    iconUrl: ICON,
    title,
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
