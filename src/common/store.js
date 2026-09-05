/*
 * Хранилище задач. Источник правды — chrome.storage.local: расширение полностью
 * работает офлайн, синхронизация (storage.sync) — необязательная надстройка.
 *
 * Все изменения выполняются через очередь, чтобы одновременные записи из popup,
 * окна задачи и уведомления не затирали друг друга.
 */

import { SCHEMA_VERSION, makeTask, dedupeKey, softKey } from './model.js';

export const TASKS_KEY = 'tasks';
export const TOMBSTONES_KEY = 'tombstones';
const META_KEY = 'meta';
const TOMBSTONE_TTL = 30 * 24 * 60 * 60 * 1000;

let queue = Promise.resolve();

/** Сериализует чтение-изменение-запись, возвращая результат обработчика. */
function transaction(handler) {
  const run = queue.then(handler, handler);
  queue = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

export async function getTasks() {
  const data = await chrome.storage.local.get(TASKS_KEY);
  const tasks = data[TASKS_KEY];
  return Array.isArray(tasks) ? tasks : [];
}

export async function getTask(id) {
  const tasks = await getTasks();
  return tasks.find((task) => task.id === id) || null;
}

async function writeTasks(tasks) {
  await chrome.storage.local.set({ [TASKS_KEY]: tasks });
}

export async function getTombstones() {
  const data = await chrome.storage.local.get(TOMBSTONES_KEY);
  return data[TOMBSTONES_KEY] || {};
}

/** Создаёт или обновляет задачу; всегда обновляет updatedAt. */
export function saveTask(input) {
  return transaction(async () => {
    const tasks = await getTasks();
    const index = input.id ? tasks.findIndex((task) => task.id === input.id) : -1;
    const base = index === -1 ? makeTask() : tasks[index];
    const task = { ...base, ...input, schemaVersion: SCHEMA_VERSION, updatedAt: Date.now() };

    if (index === -1) tasks.push(task);
    else tasks[index] = task;

    await writeTasks(tasks);
    return task;
  });
}

/** Точечное изменение по id: patch может быть объектом или функцией. */
export function patchTask(id, patch) {
  return transaction(async () => {
    const tasks = await getTasks();
    const index = tasks.findIndex((task) => task.id === id);
    if (index === -1) return null;
    const fields = typeof patch === 'function' ? patch(tasks[index]) : patch;
    if (!fields) return tasks[index];
    const task = { ...tasks[index], ...fields, updatedAt: Date.now() };
    tasks[index] = task;
    await writeTasks(tasks);
    return task;
  });
}

export function removeTask(id) {
  return transaction(async () => {
    const tasks = await getTasks();
    const next = tasks.filter((task) => task.id !== id);
    if (next.length === tasks.length) return false;

    const tombstones = await getTombstones();
    tombstones[id] = Date.now();
    await chrome.storage.local.set({
      [TASKS_KEY]: next,
      [TOMBSTONES_KEY]: prune(tombstones)
    });
    return true;
  });
}

export function removeTasks(ids) {
  return transaction(async () => {
    const set = new Set(ids);
    const tasks = await getTasks();
    const next = tasks.filter((task) => !set.has(task.id));
    const tombstones = await getTombstones();
    const now = Date.now();
    for (const id of set) tombstones[id] = now;
    await chrome.storage.local.set({
      [TASKS_KEY]: next,
      [TOMBSTONES_KEY]: prune(tombstones)
    });
    return tasks.length - next.length;
  });
}

/** Массовая замена (используется миграциями). */
export function replaceAll(tasks) {
  return transaction(async () => {
    await writeTasks(tasks);
    return tasks;
  });
}

/**
 * Слияние внутри очереди: обработчик получает АКТУАЛЬНЫЙ список и возвращает
 * новый. Нужно синхронизации — между её чтением и записью пользователь успевает
 * сохранить задачу, и запись «снимком» откатила бы её.
 */
export function mergeTasks(handler) {
  return transaction(async () => {
    const current = await getTasks();
    const next = await handler(current);
    if (!Array.isArray(next)) return current;
    await writeTasks(next);
    return next;
  });
}

function prune(tombstones) {
  const cutoff = Date.now() - TOMBSTONE_TTL;
  const result = {};
  for (const [id, at] of Object.entries(tombstones)) {
    if (at >= cutoff) result[id] = at;
  }
  return result;
}

const SOFT_MATCH_WINDOW = 30 * 24 * 60 * 60 * 1000;

/**
 * Задачи по тому же письму. Сначала точное совпадение по id письма/треда,
 * затем мягкое — тот же отправитель и та же тема без Re:/Fwd: за последний месяц
 * (нужно, когда почтовик не отдал идентификатор).
 */
export async function findDuplicates(candidate, excludeId = null) {
  const tasks = await getTasks();
  const key = dedupeKey(candidate);

  const exact = key
    ? tasks.filter((task) => task.id !== excludeId && dedupeKey(task) === key)
    : [];
  if (exact.length) return exact.map((task) => ({ ...task, matchStrength: 'exact' }));

  const soft = softKey(candidate);
  if (!soft) return [];
  const now = Date.now();
  return tasks
    .filter(
      (task) =>
        task.id !== excludeId &&
        !task.done &&
        now - task.createdAt < SOFT_MATCH_WINDOW &&
        softKey(task) === soft
    )
    .map((task) => ({ ...task, matchStrength: 'likely' }));
}

export async function getMeta() {
  const data = await chrome.storage.local.get(META_KEY);
  return data[META_KEY] || {};
}

export async function setMeta(patch) {
  const meta = await getMeta();
  const next = { ...meta, ...patch };
  await chrome.storage.local.set({ [META_KEY]: next });
  return next;
}
