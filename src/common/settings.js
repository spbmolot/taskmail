/* Настройки расширения. Приватные по умолчанию: текст письма не сохраняется. */

const KEY = 'settings';

export const DEFAULT_SETTINGS = {
  defaultReminderTime: '09:00',
  defaultPriority: 'normal',
  snoozeMinutes: 15,
  saveExcerpt: false, // сохранять выделенный текст письма только по явному согласию
  keepWallClock: true, // при смене часового пояса сохранять время суток
  catchUpMissed: true, // показывать пропущенные напоминания при запуске Chrome
  syncEnabled: false, // синхронизация между устройствами через chrome.storage.sync
  lastTimeZone: ''
};

export async function getSettings() {
  const data = await chrome.storage.local.get(KEY);
  return { ...DEFAULT_SETTINGS, ...(data[KEY] || {}) };
}

export async function setSettings(patch) {
  const current = await getSettings();
  const next = { ...current, ...patch };
  await chrome.storage.local.set({ [KEY]: next });
  return next;
}
