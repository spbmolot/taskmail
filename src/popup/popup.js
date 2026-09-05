import {
  LETTERS,
  TASKS,
  displaySender,
  displaySubject,
  plural,
  priorityInfo,
  serviceLabel,
  taskLink
} from '../common/model.js';
import { formatRelative, formatWhen, sectionOf } from '../common/datetime.js';
import { isMailHost } from '../common/hosts.js';

const $ = (id) => document.getElementById(id);

// Список открывается и как всплывающее окно, и отдельной вкладкой (запасной
// путь, когда уведомления заблокированы). Вкладку после действия не закрываем.
const asTab = new URLSearchParams(location.search).get('full') === '1';
const closeIfPopup = () => {
  if (!asTab) window.close();
};

const SECTIONS = [
  { id: 'overdue', title: 'Просроченные', empty: null },
  { id: 'today', title: 'Сегодня', empty: 'На сегодня задач нет' },
  { id: 'upcoming', title: 'Предстоящие', empty: null },
  { id: 'someday', title: 'Без срока', empty: null },
  { id: 'done', title: 'Выполненные', empty: null, collapsed: true }
];

const state = {
  tasks: [],
  settings: {},
  meta: {},
  query: '',
  collapsed: new Set(['done']),
  loaded: false
};

function send(type, payload = {}) {
  return chrome.runtime.sendMessage({ type, ...payload });
}

function toast(text, kind = 'success') {
  const node = $('toast');
  node.textContent = text;
  node.className = `toast show${kind === 'error' ? ' error' : ''}`;
  node.hidden = false;
  setTimeout(() => {
    node.className = 'toast';
  }, 1700);
}

async function act(promise, successText) {
  try {
    const response = await promise;
    if (!response || response.ok === false) throw new Error((response && response.error) || 'ошибка');
    if (successText) toast(successText);
    await load();
    return response;
  } catch (error) {
    toast(String(error.message || error), 'error');
    return null;
  }
}

/* --------------------------------- Баннеры --------------------------------- */

function banner(kind, text, actions = []) {
  const node = document.createElement('div');
  node.className = `banner ${kind}`;
  const body = document.createElement('div');
  body.className = 'banner-body';
  body.append(document.createTextNode(text));

  if (actions.length) {
    const row = document.createElement('div');
    row.style.display = 'flex';
    row.style.gap = '4px';
    row.style.marginTop = '6px';
    for (const action of actions) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = action.label;
      button.addEventListener('click', action.onClick);
      row.append(button);
    }
    body.append(row);
  }
  node.append(body);
  return node;
}

function renderBanners() {
  const host = $('banners');
  host.replaceChildren();

  if (state.meta.notificationsBlocked) {
    host.append(
      banner(
        'warning',
        'Chrome не показывает уведомления TaskMail. Разрешите уведомления в настройках системы — задачи всё это время остаются в списке.',
        [
          {
            label: 'Проверить снова',
            onClick: () => act(send('NOTIFICATIONS_CHECK'), 'Проверено')
          }
        ]
      )
    );
  }

  const notice = state.meta.timeZoneNotice;
  if (notice && !notice.seen) {
    host.append(
      banner(
        'warning',
        `Часовой пояс изменился (${notice.from} → ${notice.to}). Напоминаний пересчитано: ${notice.updated}.`,
        [
          {
            label: 'Понятно',
            onClick: () =>
              act(send('META_SET', { patch: { timeZoneNotice: { ...notice, seen: true } } }))
          }
        ]
      )
    );
  }
}

/* --------------------------------- Карточки -------------------------------- */

function metaNode(task) {
  const meta = document.createElement('div');
  meta.className = 'meta';

  const at = task.remindAt || task.dueAt;
  if (at) {
    const when = document.createElement('span');
    when.className = 'when';
    when.textContent = task.done
      ? `Выполнено ${formatWhen(task.completedAt || task.updatedAt).toLowerCase()}`
      : `${formatWhen(at)}${at < Date.now() ? ` · ${formatRelative(at)}` : ''}`;
    meta.append(when);
  }

  const sender = displaySender(task);
  if (sender) {
    const node = document.createElement('span');
    node.className = 'truncate sender';
    node.textContent = sender;
    // Разделитель нужен только между элементами, а не в начале строки.
    if (meta.childNodes.length) meta.append(separator());
    meta.append(node);
  }

  if (task.serviceId && task.serviceId !== 'other') {
    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = serviceLabel(task.serviceId);
    meta.append(tag);
  }

  if (task.items && task.items.length) {
    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = plural(task.items.length, LETTERS);
    meta.append(tag);
  }

  if (task.priority !== 'normal') {
    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = priorityInfo(task.priority).label;
    meta.append(tag);
  }

  return meta;
}

function separator() {
  const node = document.createElement('span');
  node.className = 'sep';
  node.textContent = '·';
  return node;
}

function actionButton(label, handler, className = '') {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = label;
  if (className) button.className = className;
  button.addEventListener('click', handler);
  return button;
}

function renderCard(task) {
  const card = document.createElement('article');
  const overdue = !task.done && (task.remindAt || task.dueAt) && (task.remindAt || task.dueAt) < Date.now();
  card.className = `card${task.done ? ' done' : ''}${overdue ? ' is-overdue' : ''}`;
  card.dataset.priority = task.priority || 'normal';

  const check = document.createElement('input');
  check.type = 'checkbox';
  check.className = 'check';
  check.checked = task.done;
  check.title = task.done ? 'Вернуть в работу' : 'Отметить выполненной';
  check.addEventListener('change', () =>
    act(send('TASK_TOGGLE', { id: task.id, done: check.checked }), check.checked ? 'Готово' : 'Возвращено в работу')
  );

  const body = document.createElement('div');
  body.className = 'body';

  const subject = document.createElement('div');
  subject.className = 'subject';
  subject.textContent = displaySubject(task);
  subject.title = `${displaySubject(task)}\nСоздано: ${formatWhen(task.createdAt)}`;
  body.append(subject, metaNode(task));

  if (task.comment) {
    const comment = document.createElement('div');
    comment.className = 'comment';
    comment.textContent = task.comment;
    body.append(comment);
  }

  const actions = document.createElement('div');
  actions.className = 'actions';

  const hasDirectLink = Boolean(task.messageLink || task.threadLink);
  if (hasDirectLink) {
    actions.append(
      actionButton('Открыть', async () => {
        const response = await send('TASK_OPEN', { id: task.id });
        if (!response || response.ok === false) toast('Не удалось открыть письмо', 'error');
        else closeIfPopup();
      }, 'primary-action')
    );
  }
  if (task.senderEmail || task.searchLink) {
    // Запасной путь: письмо удалили, перенесли или ссылка устарела. Ищем по
    // адресу отправителя — тема задачи могла измениться и по ней не найдётся.
    const find = actionButton(
      hasDirectLink ? 'Найти' : 'Найти в почте',
      async () => {
        const response = await send('TASK_OPEN', { id: task.id, fallback: true });
        if (!response || response.ok === false) toast('Нечего искать: нет отправителя', 'error');
        else closeIfPopup();
      },
      hasDirectLink ? '' : 'primary-action'
    );
    find.title = task.senderEmail
      ? `Найти в почте письма от ${task.senderEmail}`
      : 'Найти письмо в почте';
    actions.append(find);
  }
  if (!task.done && task.remindAt) {
    const minutes = state.settings.snoozeMinutes || 15;
    const snooze = actionButton(`+${minutes} мин`, () =>
      act(send('TASK_SNOOZE', { id: task.id, minutes }), 'Напоминание перенесено')
    );
    snooze.title = `Отложить напоминание на ${minutes} мин`;
    actions.append(snooze);
  }
  actions.append(
    actionButton('Изменить', async () => {
      await send('EDITOR_OPEN', { id: task.id });
      closeIfPopup();
    }),
    actionButton(
      'Удалить',
      () => act(send('TASK_DELETE', { id: task.id }), 'Задача удалена'),
      'danger'
    )
  );

  body.append(actions);
  card.append(check, body);
  return card;
}

/* ---------------------------------- Список --------------------------------- */

function matches(task, query) {
  if (!query) return true;
  const haystack = [
    task.subject,
    task.senderName,
    task.senderEmail,
    task.comment,
    serviceLabel(task.serviceId),
    task.accountEmail,
    ...(task.items || []).map((item) => item.subject)
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return haystack.includes(query);
}

function sortTasks(tasks, sectionId) {
  const weight = (task) => priorityInfo(task.priority).order;
  return [...tasks].sort((a, b) => {
    if (sectionId === 'done') return (b.completedAt || b.updatedAt) - (a.completedAt || a.updatedAt);
    if (sectionId === 'someday') return weight(a) - weight(b) || b.createdAt - a.createdAt;
    const at = (task) => task.remindAt || task.dueAt || Infinity;
    return at(a) - at(b) || weight(a) - weight(b);
  });
}

function renderSection(definition, tasks) {
  const section = document.createElement('section');
  section.className = `section ${definition.id}`;
  section.dataset.collapsed = String(state.collapsed.has(definition.id));

  const head = document.createElement('div');
  head.className = 'section-head';
  head.setAttribute('role', 'button');
  head.tabIndex = 0;

  const chevron = document.createElement('span');
  chevron.className = 'chevron';
  chevron.textContent = '▾';

  const title = document.createElement('h2');
  title.textContent = definition.title;

  const count = document.createElement('span');
  count.className = 'count';
  count.textContent = String(tasks.length);

  head.append(chevron, title, count);
  const toggle = () => {
    if (state.collapsed.has(definition.id)) state.collapsed.delete(definition.id);
    else state.collapsed.add(definition.id);
    render();
  };
  head.addEventListener('click', toggle);
  head.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      toggle();
    }
  });

  const body = document.createElement('div');
  body.className = 'section-body';
  for (const task of sortTasks(tasks, definition.id)) body.append(renderCard(task));

  section.append(head, body);
  return section;
}

function renderEmpty() {
  const node = document.createElement('div');
  node.className = 'empty';
  if (state.query) {
    node.innerHTML = '<strong>Ничего не найдено</strong>Попробуйте другой запрос';
    return node;
  }
  node.innerHTML =
    '<strong>Задач пока нет</strong>Нажмите правой кнопкой на письмо в Gmail или Яндекс Почте и выберите «Создать задачу»';
  return node;
}

function render() {
  const list = $('list');
  // Прокрутка не должна прыгать в начало после «Выполнено» или «Отложить».
  const scrollTop = list.scrollTop;
  list.setAttribute('aria-busy', 'false');
  list.replaceChildren();

  const visible = state.tasks.filter((task) => matches(task, state.query));
  const grouped = new Map(SECTIONS.map((definition) => [definition.id, []]));
  for (const task of visible) {
    const id = sectionOf(task);
    (grouped.get(id) || grouped.get('someday')).push(task);
  }

  const anyVisible = visible.length > 0;
  if (!anyVisible) {
    list.append(renderEmpty());
  } else {
    for (const definition of SECTIONS) {
      const tasks = grouped.get(definition.id) || [];
      if (!tasks.length) {
        if (definition.empty && !state.query) {
          const section = document.createElement('section');
          section.className = `section ${definition.id}`;
          const head = document.createElement('div');
          head.className = 'section-head';
          const title = document.createElement('h2');
          title.textContent = definition.title;
          head.append(title);
          const note = document.createElement('div');
          note.className = 'section-empty';
          note.textContent = definition.empty;
          section.append(head, note);
          list.append(section);
        }
        continue;
      }
      list.append(renderSection(definition, tasks));
    }
  }

  const active = state.tasks.filter((task) => !task.done).length;
  const overdue = state.tasks.filter((task) => sectionOf(task) === 'overdue').length;
  $('counter').textContent = overdue
    ? `${plural(active, TASKS)} · ${overdue} просрочено`
    : plural(active, TASKS);

  renderBanners();
  list.scrollTop = Math.min(scrollTop, Math.max(0, list.scrollHeight - list.clientHeight));
}

/* --------------------------------- Настройки ------------------------------- */

function fillSettings() {
  $('setDefaultTime').value = state.settings.defaultReminderTime || '09:00';
  $('setSnooze').value = String(state.settings.snoozeMinutes || 15);
  $('setPriority').value = state.settings.defaultPriority || 'normal';
  $('setSaveExcerpt').checked = Boolean(state.settings.saveExcerpt);
  $('setKeepWallClock').checked = state.settings.keepWallClock !== false;
  $('setCatchUp').checked = state.settings.catchUpMissed !== false;
  $('setSync').checked = Boolean(state.settings.syncEnabled);
  $('settingsInfo').textContent = `Часовой пояс: ${state.timeZone || '—'} · Задач сохранено: ${state.tasks.length}`;
}

function bindSettings() {
  const patchers = {
    setDefaultTime: (node) => ({ defaultReminderTime: node.value || '09:00' }),
    setSnooze: (node) => ({ snoozeMinutes: Number(node.value) }),
    setPriority: (node) => ({ defaultPriority: node.value }),
    setSaveExcerpt: (node) => ({ saveExcerpt: node.checked }),
    setKeepWallClock: (node) => ({ keepWallClock: node.checked }),
    setCatchUp: (node) => ({ catchUpMissed: node.checked }),
    setSync: (node) => ({ syncEnabled: node.checked })
  };

  for (const [id, toPatch] of Object.entries(patchers)) {
    $(id).addEventListener('change', async () => {
      const response = await send('SETTINGS_SET', { patch: toPatch($(id)) });
      if (response && response.settings) {
        state.settings = response.settings;
        toast('Настройки сохранены');
      } else {
        toast('Не удалось сохранить настройку', 'error');
      }
    });
  }

  $('settingsButton').addEventListener('click', () => {
    fillSettings();
    $('settings').hidden = false;
  });
  $('settingsClose').addEventListener('click', () => {
    $('settings').hidden = true;
  });
}

/* ------------------------------- Инициализация ----------------------------- */

/** Ошибка загрузки: показываем её явно, а не пустой список. */
function renderLoadError(message) {
  const node = document.createElement('div');
  node.className = 'empty';

  const title = document.createElement('strong');
  title.textContent = 'Не удалось загрузить задачи';
  const text = document.createElement('div');
  text.textContent = message || 'Расширение не ответило. Данные не потеряны — попробуйте ещё раз.';

  const retry = document.createElement('button');
  retry.type = 'button';
  retry.textContent = 'Повторить';
  retry.style.marginTop = '12px';
  retry.addEventListener('click', load);

  node.append(title, text, retry);
  $('list').setAttribute('aria-busy', 'false');
  $('list').replaceChildren(node);
}

async function load() {
  try {
    // Service worker может не ответить (перезапуск, ошибка) — не оставляем
    // попап навсегда в состоянии загрузки.
    const response = await Promise.race([
      send('STATE_GET'),
      new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), 4000))
    ]);

    if (!response || response.timeout || !response.ok) {
      renderLoadError(response && response.error);
      return;
    }

    state.tasks = response.tasks || [];
    state.settings = response.settings || {};
    state.meta = response.meta || {};
    state.timeZone = response.timeZone;
    state.loaded = true;
    render();
  } catch (error) {
    renderLoadError(String(error && error.message ? error.message : error));
  }
}

$('search').addEventListener('input', (event) => {
  state.query = event.target.value.trim().toLowerCase();
  render();
});

$('newButton').addEventListener('click', async () => {
  await send('NEW_TASK_BLANK');
  closeIfPopup();
});

/*
 * Gmail и Яндекс Почта показывают на письмах собственное контекстное меню и
 * гасят системное — пункт расширения туда не попадает. Поэтому, когда открыта
 * вкладка почты, тот же сценарий доступен кнопкой отсюда и горячей клавишей.
 */

async function setupMailButton() {
  if (asTab || !chrome.tabs) return;
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab || !tab.url) return;

  let host = '';
  try {
    host = new URL(tab.url).host;
  } catch (error) {
    return;
  }
  if (!isMailHost(host)) return;

  const shortcuts = await chrome.commands.getAll().catch(() => []);
  const hotkey = (shortcuts.find((item) => item.name === 'create-task') || {}).shortcut;

  $('fromMailRow').hidden = false;
  $('fromMailHint').textContent = hotkey
    ? `Наведите курсор на письмо и нажмите ${hotkey} — окно откроется без списка`
    : 'Берётся выделенное или последнее письмо под курсором';

  $('fromMail').addEventListener('click', async () => {
    const response = await send('CREATE_FROM_ACTIVE_TAB');
    if (!response || response.ok === false) {
      toast((response && response.error) || 'Не удалось прочитать письмо', 'error');
      return;
    }
    window.close();
  });
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.tasks || changes.meta || changes.settings)) load();
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !$('settings').hidden) $('settings').hidden = true;
  if (event.key === '/' && document.activeElement !== $('search')) {
    event.preventDefault();
    $('search').focus();
  }
});

if (asTab) document.body.classList.add('full');

bindSettings();
load();
setupMailButton();
