/*
 * Необязательная синхронизация между устройствами через chrome.storage.sync.
 *
 * Источник правды — локальное хранилище: расширение полностью работает офлайн.
 * chrome.storage.sync сам ставит записи в очередь и отправляет их, когда связь
 * появится; наша задача — корректно слить две версии задачи (побеждает более
 * свежая по updatedAt) и учесть удаления через тумбстоуны.
 */

import { getSettings } from '../common/settings.js';
import { getTasks, getTombstones, mergeTasks, setMeta, TASKS_KEY } from '../common/store.js';

const ITEM_PREFIX = 'task_';
const TOMB_KEY = 'tomb';
const MAX_ITEM_BYTES = 7800; // запас к QUOTA_BYTES_PER_ITEM (8 КБ)
const MAX_TOTAL_BYTES = 95000; // запас к QUOTA_BYTES (102 400 байт на всё)
const MAX_ITEMS = 480; // запас к MAX_ITEMS = 512

let syncing = false;

function size(value) {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

/**
 * Готовит задачу к отправке. Текст письма не синхронизируется никогда: в окне
 * задачи написано, что он остаётся на этом компьютере, — отправлять его на
 * серверы синхронизации значило бы обмануть пользователя.
 */
function fit(task) {
  const candidate = { ...task, excerpt: '' };
  if (size(candidate) <= MAX_ITEM_BYTES) return candidate;

  candidate.comment = (candidate.comment || '').slice(0, 500);
  if (size(candidate) <= MAX_ITEM_BYTES) return candidate;

  candidate.items = null;
  return size(candidate) <= MAX_ITEM_BYTES ? candidate : null;
}

/**
 * chrome.storage.sync жёстко ограничен (100 КБ на всё, 512 ключей), поэтому
 * синхронизируем не всё подряд: сначала активные задачи, затем свежие
 * выполненные — пока хватает квоты. Остальное остаётся локальным.
 */
function selectForSync(tasks) {
  const ordered = [...tasks].sort((a, b) => {
    if (a.done !== b.done) return a.done ? 1 : -1;
    return (b.updatedAt || 0) - (a.updatedAt || 0);
  });

  const selected = [];
  let total = 0;
  let skipped = 0;

  for (const task of ordered) {
    const packed = selected.length < MAX_ITEMS ? fit(task) : null;
    const bytes = packed ? size(packed) + ITEM_PREFIX.length + task.id.length : 0;
    if (!packed || total + bytes > MAX_TOTAL_BYTES) {
      skipped += 1;
      continue;
    }
    selected.push(packed);
    total += bytes;
  }

  return { selected, skipped };
}

async function isEnabled() {
  const settings = await getSettings();
  return Boolean(settings.syncEnabled);
}

/** Двустороннее слияние: подтягиваем удалённое, отправляем локальное. */
export async function syncNow() {
  // Флаг поднимаем синхронно: между двумя await сюда успевают войти сразу
  // несколько вызовов (изменение задачи, приход данных с другого устройства).
  if (syncing) return { skipped: true };
  syncing = true;

  try {
    if (!(await isEnabled())) return { skipped: true };

    const [tombstones, remoteAll] = await Promise.all([
      getTombstones(),
      chrome.storage.sync.get(null)
    ]);

    const remoteTombstones = remoteAll[TOMB_KEY] || {};
    const allTombstones = { ...remoteTombstones, ...tombstones };

    // Слияние выполняется внутри очереди хранилища: список читается и пишется
    // без окна, в котором пользовательская правка могла бы потеряться.
    let changed = false;
    const merged = await mergeTasks((local) => {
      const byId = new Map(local.map((task) => [task.id, task]));

      for (const [key, value] of Object.entries(remoteAll)) {
        if (!key.startsWith(ITEM_PREFIX) || !value || !value.id) continue;
        const deletedAt = allTombstones[value.id];
        if (deletedAt && deletedAt >= (value.updatedAt || 0)) continue;

        const current = byId.get(value.id);
        if (!current || (value.updatedAt || 0) > (current.updatedAt || 0)) {
          // Текст письма живёт только локально — не теряем его при обновлении.
          byId.set(value.id, { ...value, excerpt: (current && current.excerpt) || '' });
          changed = true;
        }
      }

      return [...byId.values()].filter((task) => {
        const deletedAt = allTombstones[task.id];
        return !(deletedAt && deletedAt >= (task.updatedAt || 0));
      });
    });

    const toPush = {};
    const { selected, skipped } = selectForSync(merged);
    for (const task of selected) {
      const remote = remoteAll[ITEM_PREFIX + task.id];
      if (!remote || (remote.updatedAt || 0) < (task.updatedAt || 0)) {
        toPush[ITEM_PREFIX + task.id] = task;
      }
    }
    await setMeta({ syncSkipped: skipped, syncedAt: Date.now() });

    const removals = Object.keys(allTombstones)
      .filter((id) => remoteAll[ITEM_PREFIX + id])
      .map((id) => ITEM_PREFIX + id);

    if (removals.length) await chrome.storage.sync.remove(removals);
    if (Object.keys(allTombstones).length) toPush[TOMB_KEY] = allTombstones;
    if (Object.keys(toPush).length) await chrome.storage.sync.set(toPush);

    return { ok: true, merged: changed };
  } catch (error) {
    // Нет сети или превышена квота — не мешаем работе, повторим при следующем изменении.
    console.warn('TaskMail: синхронизация отложена', error);
    return { ok: false, error: String(error) };
  } finally {
    syncing = false;
  }
}

/** Полная выгрузка при включении синхронизации. */
export async function pushAll() {
  const tasks = await getTasks();
  const { selected, skipped } = selectForSync(tasks);
  const payload = {};
  for (const task of selected) payload[ITEM_PREFIX + task.id] = task;

  const tombstones = await getTombstones();
  if (Object.keys(tombstones).length) payload[TOMB_KEY] = tombstones;

  try {
    if (Object.keys(payload).length) await chrome.storage.sync.set(payload);
  } catch (error) {
    // Превышение квоты sync не должно ломать локальную работу.
    console.warn('TaskMail: часть задач не поместилась в синхронизацию', error);
    await setMeta({ syncError: String(error && error.message ? error.message : error) });
    return { pushed: 0, skipped: tasks.length };
  }

  await setMeta({ syncSkipped: skipped, syncedAt: Date.now(), syncError: '' });
  return { pushed: selected.length, skipped };
}

export async function clearRemote() {
  await chrome.storage.sync.clear();
}

/** Реакция на изменения, пришедшие с другого устройства. */
export function watchRemoteChanges() {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    const touched = Object.keys(changes).some((key) => key.startsWith(ITEM_PREFIX) || key === TOMB_KEY);
    if (touched) syncNow();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes[TASKS_KEY]) return;
    isEnabled().then((enabled) => {
      if (enabled) syncNow();
    });
  });
}
