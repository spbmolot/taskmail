/* Service worker: контекстное меню, сообщения, напоминания, уведомления. */

import { makeTask, timeZone } from '../common/model.js';
import {
  getMeta,
  getTask,
  getTasks,
  patchTask,
  removeTask,
  saveTask,
  setMeta
} from '../common/store.js';
import { getSettings, setSettings } from '../common/settings.js';
import { MAIL_MATCH_PATTERNS, isMailUrl } from '../common/hosts.js';
import { defaultReminder } from '../common/datetime.js';
import { runMigrations } from './migrate.js';
import { buildDrafts, collectFromTab } from './collect.js';
import { openTask } from './links.js';
import {
  MISSED_NOTIFICATION,
  clearUndelivered,
  notifyProblem,
  permissionLevel,
  taskIdFromNotification
} from './notify.js';
import {
  NEXT_ALARM,
  SAFETY_ALARM,
  computeTimes,
  processDue,
  refreshSchedule,
  snoozeTimes,
  syncTimeZone
} from './reminders.js';
import { syncNow, watchRemoteChanges } from './sync.js';

const MENU_ROOT = 'taskmail-create';
const EDITOR_PATH = 'src/editor/editor.html';

/* ------------------------------ Контекстное меню --------------------------- */

/*
 * Один пункт без подменю: у пункта с дочерними элементами Chrome не отдаёт
 * клик по родителю — он превращается в контейнер. Выбор «отдельные задачи или
 * одна общая» сделан в окне задачи, где сразу видно список писем.
 */
function createMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_ROOT,
      title: 'Создать задачу',
      contexts: ['page', 'selection', 'link'],
      documentUrlPatterns: MAIL_MATCH_PATTERNS
    });
    // Ошибку «duplicate id» гасим здесь же — меню всегда пересоздаётся с нуля.
    void chrome.runtime.lastError;
  });
}

/**
 * Единая точка создания задачи из письма. Вызывается из контекстного меню,
 * с горячей клавиши и из списка задач: Gmail и Яндекс Почта показывают на
 * письмах собственное меню и гасят системное, поэтому одного пункта меню мало.
 */
async function createFromTab(tab, info = {}) {
  if (!tab || tab.id === undefined) return { ok: false, error: 'нет активной вкладки' };

  if (!isMailUrl(tab.url)) {
    return { ok: false, error: 'откройте вкладку Gmail или Яндекс Почты' };
  }

  const payload = await collectFromTab(tab, info);
  if (!payload) {
    // Контент-скрипт не ответил: вкладку открыли до установки расширения.
    return { ok: false, error: 'обновите вкладку почты (F5) и попробуйте снова' };
  }

  const settings = await getSettings();
  const draft = await buildDrafts(payload, { info, tab, settings });

  const draftId = `draft_${Date.now().toString(36)}`;
  await chrome.storage.session.set({ [draftId]: draft });
  await openEditor({ draft: draftId });
  return { ok: true, partial: draft.partial };
}

async function handleMenuClick(info, tab) {
  if (info.menuItemId !== MENU_ROOT) return;
  await createFromTab(tab, info);
}

/** Активная вкладка текущего окна — для горячей клавиши и кнопки в списке. */
async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab || null;
}

/* -------------------------------- Окно задачи ------------------------------ */

async function openEditor(params) {
  const url = chrome.runtime.getURL(EDITOR_PATH) + '?' + new URLSearchParams(params).toString();
  const windows = await chrome.windows.getCurrent().catch(() => null);
  const width = 440;
  const height = 660;
  const left = windows && windows.left !== undefined ? windows.left + Math.max(0, (windows.width || width) - width - 40) : undefined;
  const top = windows && windows.top !== undefined ? windows.top + 80 : undefined;

  await chrome.windows.create({ url, type: 'popup', width, height, left, top, focused: true });
}

/** Черновик нужен только до сохранения — не держим данные письма в памяти. */
async function dropDraft(draftId) {
  if (draftId) await chrome.storage.session.remove(draftId);
}

/* --------------------------------- Задачи ---------------------------------- */

/** Единая точка сохранения: пересчёт времени + перепланирование. */
async function persist(input) {
  const times = computeTimes(input);
  const previous = input.id ? await getTask(input.id) : null;
  // Сбрасываем отметку об уведомлении только если время напоминания сдвинули,
  // иначе правка комментария заставит просроченную задачу звонить повторно.
  const rescheduled = !previous || previous.remindLocal !== input.remindLocal;

  const task = await saveTask({
    ...input,
    ...times,
    remindTz: timeZone(),
    lastNotifiedAt: rescheduled ? null : previous.lastNotifiedAt,
    missed: rescheduled ? false : previous.missed
  });
  await clearUndelivered(task.id);
  await reschedule(task);
  syncNow();
  return task;
}

/**
 * Перестраивает расписание. Если срок уже наступил — показываем уведомление
 * сразу: окно задачи обещает пользователю именно это, а ближайший alarm может
 * быть только через полчаса.
 */
async function reschedule(task) {
  if (task && !task.done && task.remindAt && task.remindAt <= Date.now()) {
    await processDue();
  } else {
    await refreshSchedule();
  }
}

async function completeTask(id, done) {
  const task = await patchTask(id, (current) => ({
    done: done === undefined ? !current.done : done,
    completedAt: (done === undefined ? !current.done : done) ? Date.now() : null
  }));
  await clearUndelivered(id);
  await reschedule(task);
  syncNow();
  return task;
}

async function snooze(id, minutes) {
  const settings = await getSettings();
  const delay = minutes || settings.snoozeMinutes;
  const task = await patchTask(id, snoozeTimes(delay));
  await clearUndelivered(id);
  await refreshSchedule();
  syncNow();
  return task;
}

/* ------------------------------ Жизненный цикл ----------------------------- */

async function bootstrap({ startup = false } = {}) {
  await runMigrations();
  await syncTimeZone();
  const level = await permissionLevel();
  await setMeta({ notificationsBlocked: level !== 'granted' });
  await processDue({ startup });
  await refreshSchedule();
  syncNow();
}

// Пункты меню персистятся браузером: создаём их только при установке и
// обновлении, иначе повторный create() упадёт с «duplicate id».
chrome.runtime.onInstalled.addListener(() => {
  createMenus();
  // Обновление расширения очищает chrome.alarms — расписание строим заново.
  bootstrap({ startup: true });
});

chrome.runtime.onStartup.addListener(() => {
  bootstrap({ startup: true });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  handleMenuClick(info, tab).catch((error) => console.error('TaskMail: меню', error));
});

// Горячая клавиша работает там, где почта перехватила правый клик.
chrome.commands.onCommand.addListener((command) => {
  if (command !== 'create-task') return;
  activeTab()
    .then(async (tab) => {
      const result = await createFromTab(tab);
      // По горячей клавише окна может не быть — молчаливый отказ выглядел бы
      // как «расширение не работает», поэтому причину показываем явно.
      if (!result.ok) await notifyProblem(result.error);
    })
    .catch((error) => console.error('TaskMail: горячая клавиша', error));
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === NEXT_ALARM) {
    processDue().catch((error) => console.error('TaskMail: напоминания', error));
  } else if (alarm.name === SAFETY_ALARM) {
    (async () => {
      await syncTimeZone();
      await processDue();
    })().catch((error) => console.error('TaskMail: страховочная проверка', error));
  }
});

/* -------------------------------- Уведомления ------------------------------ */

chrome.notifications.onClicked.addListener((notificationId) => {
  (async () => {
    if (notificationId === MISSED_NOTIFICATION) {
      chrome.notifications.clear(notificationId);
      try {
        // openPopup доступен не во всех версиях Chrome и требует активного окна.
        await chrome.action.openPopup();
      } catch (error) {
        await openTaskList();
      }
      return;
    }
    const id = taskIdFromNotification(notificationId);
    if (!id) return;
    const task = await getTask(id);
    if (task) await openTask(task);
    chrome.notifications.clear(notificationId);
  })().catch((error) => console.error('TaskMail: клик по уведомлению', error));
});

chrome.notifications.onButtonClicked.addListener((notificationId, buttonIndex) => {
  (async () => {
    const id = taskIdFromNotification(notificationId);
    if (!id) return;
    if (buttonIndex === 0) await completeTask(id, true);
    else await snooze(id);
    chrome.notifications.clear(notificationId);
  })().catch((error) => console.error('TaskMail: кнопка уведомления', error));
});

chrome.notifications.onClosed.addListener((notificationId) => {
  const id = taskIdFromNotification(notificationId);
  if (id) refreshSchedule();
});

/**
 * Запасной путь: список задач отдельной вкладкой. Ранее открытую вкладку
 * запоминаем по id, а не ищем поиском по URL: фильтр tabs.query({url}) требует
 * разрешения "tabs", а оно показывает при установке пугающее «читать историю
 * просмотров» — ради одной кнопки это несоразмерная плата.
 */
const LIST_TAB_KEY = 'listTabId';

async function openTaskList() {
  const url = chrome.runtime.getURL('src/popup/popup.html?full=1');
  const stored = (await chrome.storage.session.get(LIST_TAB_KEY))[LIST_TAB_KEY];

  if (stored) {
    try {
      const tab = await chrome.tabs.update(stored, { active: true });
      if (tab && tab.windowId !== undefined) await chrome.windows.update(tab.windowId, { focused: true });
      return;
    } catch (error) {
      // Вкладку закрыли — откроем новую.
    }
  }

  const tab = await chrome.tabs.create({ url });
  await chrome.storage.session.set({ [LIST_TAB_KEY]: tab.id });
}

/* --------------------------------- Сообщения ------------------------------- */

const handlers = {
  async STATE_GET() {
    const [tasks, settings, meta] = await Promise.all([getTasks(), getSettings(), getMeta()]);
    return { tasks, settings, meta, timeZone: timeZone() };
  },

  async DRAFT_GET({ draftId }) {
    const data = await chrome.storage.session.get(draftId);
    return { draft: data[draftId] || null };
  },

  async DRAFT_DROP({ draftId }) {
    await dropDraft(draftId);
    return { ok: true };
  },

  async TASK_SAVE({ task, draftId }) {
    const saved = await persist(task);
    await dropDraft(draftId);
    return { task: saved };
  },

  async TASK_SAVE_MANY({ tasks, draftId }) {
    const saved = [];
    for (const task of tasks) saved.push(await persist(task));
    await dropDraft(draftId);
    return { tasks: saved };
  },

  async TASK_TOGGLE({ id, done }) {
    return { task: await completeTask(id, done) };
  },

  async TASK_SNOOZE({ id, minutes }) {
    return { task: await snooze(id, minutes) };
  },

  async TASK_DELETE({ id }) {
    await removeTask(id);
    await refreshSchedule();
    syncNow();
    return { ok: true };
  },

  async TASK_OPEN({ id, fallback }) {
    const task = await getTask(id);
    if (!task) return { ok: false, error: 'задача не найдена' };
    return openTask(task, { fallback });
  },

  async EDITOR_OPEN({ id }) {
    await openEditor(id ? { id } : {});
    return { ok: true };
  },

  async SETTINGS_SET({ patch }) {
    const settings = await setSettings(patch);
    if (patch && patch.syncEnabled !== undefined) {
      const { pushAll, clearRemote } = await import('./sync.js');
      if (patch.syncEnabled) await pushAll();
      else await clearRemote();
    }
    await refreshSchedule();
    return { settings };
  },

  async META_SET({ patch }) {
    return { meta: await setMeta(patch) };
  },

  async NOTIFICATIONS_CHECK() {
    const level = await permissionLevel();
    const blocked = level !== 'granted';
    await setMeta({ notificationsBlocked: blocked });
    await refreshSchedule();
    return { level, blocked };
  },

  async CREATE_FROM_ACTIVE_TAB() {
    return createFromTab(await activeTab());
  },

  async NEW_TASK_BLANK() {
    const settings = await getSettings();
    const task = makeTask({
      priority: settings.defaultPriority,
      ...defaultReminder(settings.defaultReminderTime)
    });
    const draftId = `draft_${Date.now().toString(36)}`;
    await chrome.storage.session.set({
      [draftId]: { mode: 'single', separate: [task], combined: task, duplicates: [] }
    });
    await openEditor({ draft: draftId });
    return { ok: true };
  }
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handler = message && handlers[message.type];
  if (!handler) return false;

  handler(message)
    .then((result) => sendResponse({ ok: true, ...(result || {}) }))
    .catch((error) => {
      console.error('TaskMail:', message.type, error);
      sendResponse({ ok: false, error: String(error && error.message ? error.message : error) });
    });

  return true; // ответ придёт асинхронно
});

watchRemoteChanges();

// Каждое пробуждение service worker — повод сверить очередь напоминаний:
// alarms могут быть потеряны при обновлении расширения или пропущены, пока
// Chrome был закрыт.
processDue().catch((error) => console.error('TaskMail: проверка расписания', error));
