import { LETTERS, makeTask, plural, serviceLabel, taskLink } from '../common/model.js';
import {
  addDays,
  formatWhen,
  joinLocal,
  parseLocalStr,
  splitLocal,
  toDateStr
} from '../common/datetime.js';

const params = new URLSearchParams(location.search);
const $ = (id) => document.getElementById(id);

const state = {
  mode: 'single', // single | multi | edit
  choice: 'separate', // при нескольких письмах
  tasks: [], // отдельные задачи
  combined: null,
  base: null, // задача, поля которой правит форма
  editingId: null,
  duplicates: [],
  allowDuplicate: false,
  settings: {},
  excerpt: '',
  saving: false,
  saved: false
};

function send(type, payload = {}) {
  return chrome.runtime.sendMessage({ type, ...payload });
}

/* --------------------------------- Баннеры --------------------------------- */

function banner({ kind = 'warning', text, actions = [] }) {
  const node = document.createElement('div');
  node.className = `banner ${kind}`;

  const body = document.createElement('div');
  body.className = 'banner-body';
  body.append(document.createTextNode(text));

  if (actions.length) {
    const row = document.createElement('div');
    row.className = 'actions';
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

  if (state.duplicates.length && !state.allowDuplicate) {
    const existing = state.duplicates[0].tasks[0];
    host.append(
      banner({
        kind: 'warning',
        text:
          state.duplicates.length === 1
            ? 'Задача по этому письму уже есть.'
            : `Задачи уже есть по ${state.duplicates.length} из выделенных писем.`,
        actions: [
          {
            label: 'Открыть существующую',
            onClick: () => send('EDITOR_OPEN', { id: existing.id }).then(() => window.close())
          },
          {
            label: 'Всё равно создать',
            onClick: () => {
              state.allowDuplicate = true;
              renderBanners();
            }
          }
        ]
      })
    );
  }

  if (state.partial) {
    host.append(
      banner({
        kind: 'warning',
        text: 'Не удалось распознать письмо целиком — проверьте тему, отправителя и ссылку.'
      })
    );
  }
}

/* ------------------------------- Форма задачи ------------------------------ */

function fillForm(task) {
  $('subject').value = task.subject || '';
  $('senderName').value = task.senderName || '';
  $('senderEmail').value = task.senderEmail || '';
  $('link').value = taskLink(task) || '';
  $('comment').value = task.comment || '';
  $('useThreadLink').checked = Boolean(task.useThreadLink);
  $('threadToggleWrap').hidden = !(task.threadLink && task.messageLink);

  setPriority(task.priority || 'normal');

  const { date, time } = splitLocal(task.remindLocal || (task.dueLocal ? `${task.dueLocal}T09:00` : ''));
  $('date').value = date || task.dueLocal || '';
  $('time').value = time || '';
  syncChips();
  updateWhenHint();
}

function setPriority(priority) {
  for (const button of $('priority').querySelectorAll('button')) {
    button.setAttribute('aria-pressed', String(button.dataset.priority === priority));
  }
}

function currentPriority() {
  const active = $('priority').querySelector('button[aria-pressed="true"]');
  return active ? active.dataset.priority : 'normal';
}

function currentWhen() {
  const date = $('date').value;
  if (!date) return { dueLocal: null, remindLocal: null };
  const time = $('time').value || state.settings.defaultReminderTime || '09:00';
  return { dueLocal: date, remindLocal: joinLocal(date, time) };
}

function applyPreset(preset) {
  const time = $('time').value || state.settings.defaultReminderTime || '09:00';
  if (preset === 'none') {
    $('date').value = '';
    $('time').value = '';
  } else if (preset === 'today') {
    $('date').value = toDateStr(new Date());
    $('time').value = time;
  } else if (preset === 'tomorrow') {
    $('date').value = toDateStr(new Date(addDays(Date.now(), 1)));
    $('time').value = time;
  } else if (preset === 'week') {
    $('date').value = toDateStr(new Date(addDays(Date.now(), 7)));
    $('time').value = time;
  } else if (preset === 'custom') {
    if (!$('date').value) {
      $('date').value = toDateStr(new Date());
      $('time').value = time;
    }
    $('dateRow').hidden = false;
    $('date').focus();
    if ($('date').showPicker) {
      try {
        $('date').showPicker();
      } catch (error) {
        /* браузер может запретить программный вызов — не страшно */
      }
    }
  }
  syncChips();
  updateWhenHint();
}

/** Подсвечивает чип, соответствующий выбранной дате. */
function syncChips() {
  const date = $('date').value;
  const today = toDateStr(new Date());
  const tomorrow = toDateStr(new Date(addDays(Date.now(), 1)));
  const week = toDateStr(new Date(addDays(Date.now(), 7)));

  let active = 'custom';
  if (!date) active = 'none';
  else if (date === today) active = 'today';
  else if (date === tomorrow) active = 'tomorrow';
  else if (date === week) active = 'week';

  for (const chip of $('dueChips').querySelectorAll('.chip')) {
    chip.setAttribute('aria-pressed', String(chip.dataset.preset === active));
  }
  $('dateRow').hidden = !date && active === 'none';
}

function updateWhenHint() {
  const hint = $('whenHint');
  const { remindLocal } = currentWhen();
  const at = parseLocalStr(remindLocal);

  hint.style.color = '';
  if (!at) {
    hint.textContent = 'Без напоминания — задача будет в разделе «Без срока».';
    return;
  }
  if (at < Date.now()) {
    hint.style.color = 'var(--warning)';
    hint.textContent = `Время уже прошло (${formatWhen(at)}) — напоминание придёт сразу после сохранения.`;
    return;
  }
  hint.textContent = `Напомним ${formatWhen(at).toLowerCase()}.`;
}

/* --------------------------- Несколько выделенных -------------------------- */

function renderLetters(source) {
  const list = $('letters');
  list.replaceChildren();

  for (const item of source) {
    const li = document.createElement('li');
    const subject = document.createElement('span');
    subject.textContent = item.subject || '(без темы)';
    const from = document.createElement('span');
    from.className = 'from';
    const sender = item.senderName || item.senderEmail;
    from.textContent = sender ? ` — ${sender}` : '';
    li.append(subject, from);
    list.append(li);
  }
}

/**
 * Задача собрана из нескольких писем — показываем её состав. Переключатель
 * режима здесь скрыт: выбор сделан при создании, а менять его задним числом
 * значило бы разбирать задачу на несколько — это отдельная операция.
 */
function showTaskLetters(task) {
  if (!task.items || !task.items.length) return;

  $('modeField').hidden = false;
  $('modeSwitch').hidden = true;
  $('lettersLabel').textContent = `В задаче ${plural(task.items.length, LETTERS)}`;
  renderLetters(task.items);
}

function applyChoice(choice) {
  state.choice = choice;
  for (const button of $('modeSwitch').querySelectorAll('button')) {
    button.setAttribute('aria-selected', String(button.dataset.mode === choice));
  }

  const combined = choice === 'combined';
  state.base = combined ? state.combined : state.tasks[0];

  // В режиме отдельных задач тема и отправитель у каждого письма свои.
  $('subject').closest('.field').hidden = !combined;
  $('senderName').closest('.row').hidden = true;
  $('linkField').hidden = !combined;

  if (combined) {
    $('subject').value = state.combined.subject || '';
    $('link').value = taskLink(state.combined) || '';
  }
  renderLetters(combined && state.combined.items ? state.combined.items : state.tasks);
}

/* -------------------------------- Инициализация ---------------------------- */

async function init() {
  const stateResponse = await send('STATE_GET');
  state.settings = (stateResponse && stateResponse.settings) || {};

  const id = params.get('id');
  if (id) {
    const task = ((stateResponse && stateResponse.tasks) || []).find((item) => item.id === id);
    if (task) {
      state.mode = 'edit';
      state.editingId = id;
      state.base = task;
      $('title').textContent = 'Редактирование задачи';
      $('save').textContent = 'Сохранить';
      showContext(task);
      fillForm(task);
      showTaskLetters(task);
      if (task.excerpt) {
        $('excerptField').hidden = false;
        $('excerptToggle').checked = true;
        $('excerptPreview').textContent = task.excerpt;
        state.excerpt = task.excerpt;
      }
      $('subject').focus({ preventScroll: true });
      return;
    }
  }

  const draftId = params.get('draft');
  const draftResponse = draftId ? await send('DRAFT_GET', { draftId }) : null;
  const draft = (draftResponse && draftResponse.draft) || null;

  if (!draft) {
    state.base = makeTask({ priority: state.settings.defaultPriority || 'normal' });
    fillForm(state.base);
    $('subject').focus({ preventScroll: true });
    return;
  }

  state.tasks = draft.separate || [];
  state.combined = draft.combined || state.tasks[0];
  state.duplicates = draft.duplicates || [];
  state.partial = Boolean(draft.partial);
  state.excerpt = draft.excerpt || '';
  state.base = state.tasks[0] || makeTask();

  showContext(state.base, draft);
  fillForm(state.base);

  if (state.tasks.length > 1) {
    state.mode = 'multi';
    $('modeField').hidden = false;
    $('selectedCount').textContent = String(state.tasks.length);
    applyChoice(draft.mode === 'combined' ? 'combined' : 'separate');
    $('title').textContent = 'Задачи из писем';
  }

  if (state.excerpt) {
    $('excerptField').hidden = false;
    $('excerptToggle').checked = Boolean(draft.excerptAllowed);
    $('excerptPreview').textContent = state.excerpt;
  }

  renderBanners();
  $('subject').focus({ preventScroll: true });
}

function showContext(task, draft) {
  const label = (draft && draft.serviceLabel) || serviceLabel(task.serviceId);
  $('serviceBadge').textContent = label;
  $('serviceBadge').hidden = !label;

  const parts = [];
  const account = task.accountEmail || task.accountId;
  if (account) parts.push(`Аккаунт: ${account}`);
  // Дата и время создания задачи фиксируются автоматически.
  parts.push(`Создано: ${formatWhen(task.createdAt || Date.now())}`);
  $('context').textContent = parts.join(' · ');
}

/* --------------------------------- Сохранение ------------------------------ */

function collectShared() {
  const when = currentWhen();
  const shared = {
    ...when,
    priority: currentPriority(),
    comment: $('comment').value.trim()
  };
  if ($('excerptToggle').checked && state.excerpt) shared.excerpt = state.excerpt.slice(0, 2000);
  else shared.excerpt = '';
  return shared;
}

function collectSingle(base) {
  return {
    ...base,
    ...collectShared(),
    subject: $('subject').value.trim(),
    senderName: $('senderName').value.trim(),
    senderEmail: $('senderEmail').value.trim(),
    useThreadLink: $('useThreadLink').checked,
    ...linkFields(base)
  };
}

/** Правка ссылки вручную перезаписывает соответствующее поле. */
function linkFields(base) {
  const value = $('link').value.trim();
  const original = taskLink(base);
  if (value === original) return {};
  return base.useThreadLink && base.threadLink
    ? { threadLink: value }
    : { messageLink: value };
}

function toast(text, kind = 'success') {
  const node = $('toast');
  node.textContent = text;
  node.className = `toast show${kind === 'error' ? ' error' : ''}`;
  node.hidden = false;
  setTimeout(() => {
    node.className = 'toast';
  }, 1600);
}

function setBusy(busy) {
  state.saving = busy;
  $('save').disabled = busy;
  $('save').classList.toggle('busy', busy);
  $('cancel').disabled = busy;
}

async function save(event) {
  event.preventDefault();
  if (state.saving) return;

  if (state.duplicates.length && !state.allowDuplicate && state.mode !== 'edit') {
    renderBanners();
    toast('Проверьте предупреждение о дубликате', 'error');
    return;
  }

  setBusy(true);
  try {
    const draftId = params.get('draft') || undefined;
    let response;
    if (state.mode === 'multi' && state.choice === 'separate') {
      const shared = collectShared();
      const tasks = state.tasks.map((task) => ({ ...task, ...shared }));
      response = await send('TASK_SAVE_MANY', { tasks, draftId });
    } else {
      const base = state.mode === 'multi' ? state.combined : state.base;
      response = await send('TASK_SAVE', { task: collectSingle(base), draftId });
    }

    if (!response || !response.ok) throw new Error((response && response.error) || 'неизвестная ошибка');

    state.saved = true;
    toast(state.mode === 'edit' ? 'Задача обновлена' : 'Задача создана');
    setTimeout(() => window.close(), 700);
  } catch (error) {
    setBusy(false);
    toast(`Не удалось сохранить: ${error.message}`, 'error');
  }
}

/* --------------------------------- Слушатели ------------------------------- */

$('dueChips').addEventListener('click', (event) => {
  const chip = event.target.closest('.chip');
  if (chip) applyPreset(chip.dataset.preset);
});

$('priority').addEventListener('click', (event) => {
  const button = event.target.closest('button[data-priority]');
  if (button) setPriority(button.dataset.priority);
});

$('modeSwitch').addEventListener('click', (event) => {
  const button = event.target.closest('button[data-mode]');
  if (button) applyChoice(button.dataset.mode);
});

$('useThreadLink').addEventListener('change', () => {
  const base = state.mode === 'multi' ? state.combined : state.base;
  if (!base) return;
  base.useThreadLink = $('useThreadLink').checked;
  $('link').value = taskLink(base);
});

$('date').addEventListener('change', () => {
  if ($('date').value && !$('time').value) {
    $('time').value = state.settings.defaultReminderTime || '09:00';
  }
  syncChips();
  updateWhenHint();
});

$('time').addEventListener('change', updateWhenHint);
/** Отказ от задачи не должен оставлять текст письма в памяти расширения. */
function dropDraft() {
  const draftId = params.get('draft');
  if (draftId && !state.saved) send('DRAFT_DROP', { draftId });
}

$('cancel').addEventListener('click', () => {
  dropDraft();
  window.close();
});
$('form').addEventListener('submit', save);
window.addEventListener('pagehide', dropDraft);

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    dropDraft();
    window.close();
  }
  if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') $('form').requestSubmit();
});

init().catch((error) => {
  console.error('TaskMail: окно задачи', error);
  toast('Не удалось открыть задачу', 'error');
});
