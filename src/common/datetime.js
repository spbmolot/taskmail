/*
 * Работа со временем. Ключевая идея: задача хранит «настенное» локальное время
 * (dueLocal / remindLocal) как строку, а абсолютный epoch пересчитывается из неё.
 * При смене часового пояса напоминание остаётся на тех же 9:00 по новым часам.
 */

const pad = (value) => String(value).padStart(2, '0');

export function toDateStr(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function toTimeStr(date) {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function toLocalStr(date) {
  return `${toDateStr(date)}T${toTimeStr(date)}`;
}

/** 'YYYY-MM-DD' → epoch начала дня в текущем поясе. */
export function parseDateStr(value) {
  if (!value) return null;
  const [year, month, day] = value.split('-').map(Number);
  if (!year || !month || !day) return null;
  return new Date(year, month - 1, day, 0, 0, 0, 0).getTime();
}

/** 'YYYY-MM-DDTHH:mm' → epoch в текущем поясе. */
export function parseLocalStr(value) {
  if (!value) return null;
  const [datePart, timePart = '00:00'] = value.split('T');
  const [year, month, day] = datePart.split('-').map(Number);
  const [hours, minutes] = timePart.split(':').map(Number);
  if (!year || !month || !day) return null;
  return new Date(year, month - 1, day, hours || 0, minutes || 0, 0, 0).getTime();
}

export function splitLocal(value) {
  if (!value) return { date: '', time: '' };
  const [date, time = ''] = value.split('T');
  return { date, time };
}

export function joinLocal(date, time) {
  if (!date) return null;
  return `${date}T${time || '09:00'}`;
}

export function startOfDay(timestamp = Date.now()) {
  const date = new Date(timestamp);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

export function endOfDay(timestamp = Date.now()) {
  const date = new Date(timestamp);
  date.setHours(23, 59, 59, 999);
  return date.getTime();
}

export function addDays(timestamp, days) {
  const date = new Date(timestamp);
  date.setDate(date.getDate() + days);
  return date.getTime();
}

export function isToday(timestamp) {
  return timestamp !== null && timestamp >= startOfDay() && timestamp <= endOfDay();
}

/** Быстрые сроки для чипов: Сегодня / Завтра / Через неделю. */
export function duePresets(defaultTime = '09:00') {
  const today = new Date();
  const tomorrow = new Date(addDays(Date.now(), 1));
  const week = new Date(addDays(Date.now(), 7));
  return [
    { id: 'today', label: 'Сегодня', date: toDateStr(today), time: defaultTime },
    { id: 'tomorrow', label: 'Завтра', date: toDateStr(tomorrow), time: defaultTime },
    { id: 'week', label: 'Через неделю', date: toDateStr(week), time: defaultTime }
  ];
}

/**
 * Разумное напоминание по умолчанию: сегодня в заданное время, а если оно уже
 * прошло — ближайшие полчаса. Так задача создаётся в три клика и не оказывается
 * просроченной в момент создания.
 */
export function defaultReminder(defaultTime = '09:00', now = Date.now()) {
  const [hours, minutes] = defaultTime.split(':').map(Number);
  const today = new Date(now);
  const target = new Date(now);
  target.setHours(hours || 9, minutes || 0, 0, 0);

  if (target.getTime() <= now + 60000) {
    target.setTime(now + 30 * 60 * 1000);
    target.setMinutes(target.getMinutes() >= 30 ? 30 : 0, 0, 0);
    if (target.getTime() <= now) target.setMinutes(target.getMinutes() + 30, 0, 0);
  }

  // Округление перевалило за полночь — оставляем уже наступивший следующий день,
  // но возвращаем штатное время. Менять здесь дату нельзя: setDate(31 + 1) в
  // февральской дате улетает в март.
  if (target.getDate() !== today.getDate()) {
    target.setHours(hours || 9, minutes || 0, 0, 0);
  }

  return { dueLocal: toDateStr(target), remindLocal: toLocalStr(target) };
}

const dateFmt = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short' });
const dateYearFmt = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short', year: 'numeric' });
const timeFmt = new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' });

/** «Сегодня, 18:00», «Завтра, 09:00», «12 окт, 09:00», «3 янв 2027». */
export function formatWhen(timestamp, { withTime = true } = {}) {
  if (!timestamp) return '';
  const date = new Date(timestamp);
  const days = Math.round((startOfDay(timestamp) - startOfDay()) / 86400000);
  const time = withTime ? `, ${timeFmt.format(date)}` : '';

  if (days === 0) return `Сегодня${time}`;
  if (days === 1) return `Завтра${time}`;
  if (days === -1) return `Вчера${time}`;

  const sameYear = date.getFullYear() === new Date().getFullYear();
  return `${(sameYear ? dateFmt : dateYearFmt).format(date)}${time}`;
}

/** «через 2 ч», «5 дней назад» — короткая подпись для просрочки. */
export function formatRelative(timestamp) {
  if (!timestamp) return '';
  const diff = timestamp - Date.now();
  const abs = Math.abs(diff);
  const minutes = Math.round(abs / 60000);
  const hours = Math.round(abs / 3600000);
  const days = Math.round(abs / 86400000);

  let value;
  if (minutes < 60) value = `${minutes} мин`;
  else if (hours < 24) value = `${hours} ч`;
  else value = `${days} дн`;

  return diff >= 0 ? `через ${value}` : `${value} назад`;
}

/** Раздел списка: overdue / today / upcoming / someday. */
export function sectionOf(task, now = Date.now()) {
  if (task.done) return 'done';
  const at = task.remindAt || task.dueAt;
  if (!at) return 'someday';
  if (at < now) return 'overdue';
  if (at <= endOfDay(now)) return 'today';
  return 'upcoming';
}
