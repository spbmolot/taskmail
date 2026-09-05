/*
 * Самотест чистых модулей (без chrome.*): время, модель задачи, дедупликация.
 * Запуск: node tests/selftest.mjs
 */

import assert from 'node:assert';
import {
  addDays,
  defaultReminder,
  duePresets,
  formatRelative,
  formatWhen,
  joinLocal,
  parseLocalStr,
  sectionOf,
  splitLocal,
  toDateStr,
  toLocalStr
} from '../src/common/datetime.js';
import {
  dedupeKey,
  displaySender,
  makeTask,
  normalizeSubject,
  plural,
  softKey,
  taskLink
} from '../src/common/model.js';
import { resolveUrl, searchUrl } from '../src/background/links.js';

let passed = 0;
const check = (name, fn) => {
  try {
    fn();
    passed += 1;
  } catch (error) {
    console.error(`FAIL: ${name}\n  ${error.message}`);
    process.exitCode = 1;
  }
};

check('локальное время конвертируется туда и обратно', () => {
  const at = parseLocalStr('2026-08-15T09:30');
  assert.equal(toLocalStr(new Date(at)), '2026-08-15T09:30');
});

check('напоминание по умолчанию всегда в будущем и не дальше завтра', () => {
  const moments = [
    Date.now(),
    new Date(2026, 0, 31, 23, 45).getTime(), // последний день месяца
    new Date(2026, 1, 28, 23, 55).getTime(), // конец февраля
    new Date(2026, 11, 31, 23, 59).getTime(), // конец года
    new Date(2026, 7, 15, 3, 0).getTime()
  ];

  for (const now of moments) {
    for (const time of ['00:01', '09:00', '12:00', '23:59']) {
      const { remindLocal, dueLocal } = defaultReminder(time, now);
      const at = parseLocalStr(remindLocal);
      assert.ok(at > now, `${new Date(now).toISOString()} / ${time} → ${remindLocal} в прошлом`);
      // Ловушка: setDate(31 + 1) в февральской дате улетает в март.
      assert.ok(
        at < now + 2 * 86400000,
        `${new Date(now).toISOString()} / ${time} → ${remindLocal} слишком далеко`
      );
      assert.equal(remindLocal.slice(0, 10), dueLocal);
    }
  }
});

check('задачи раскладываются по разделам', () => {
  const base = makeTask();
  assert.equal(sectionOf({ ...base, done: true }), 'done');
  assert.equal(sectionOf({ ...base, remindAt: Date.now() - 1000 }), 'overdue');
  assert.equal(sectionOf({ ...base, remindAt: Date.now() + 3600000 }), 'today');
  assert.equal(sectionOf({ ...base, remindAt: Date.now() + 5 * 86400000 }), 'upcoming');
  assert.equal(sectionOf(base), 'someday');
});

check('одно письмо из разных папок Gmail — один ключ дедупликации', () => {
  const inbox = makeTask({
    serviceId: 'gmail',
    accountEmail: 'A@Gmail.com',
    messageLink: 'https://mail.google.com/mail/u/0/#inbox/16be0868ae18c6a7'
  });
  const all = makeTask({
    serviceId: 'gmail',
    accountEmail: 'a@gmail.com',
    messageLink: 'https://mail.google.com/mail/u/2/#all/16be0868ae18c6a7'
  });
  assert.equal(dedupeKey(inbox), dedupeKey(all));
});

check('разные аккаунты — разные ключи', () => {
  const a = makeTask({ serviceId: 'gmail', accountEmail: 'one@x.ru', messageId: 'm1' });
  const b = makeTask({ serviceId: 'gmail', accountEmail: 'two@x.ru', messageId: 'm1' });
  assert.notEqual(dedupeKey(a), dedupeKey(b));
});

check('мягкое совпадение не зависит от Re:/Fwd:', () => {
  assert.equal(normalizeSubject('Re:  Fwd: Договор  №5'), 'договор №5');
  const a = makeTask({ serviceId: 'gmail', accountEmail: 'x@y.z', senderEmail: 'B@C.d', subject: 'Договор №5' });
  const b = makeTask({ serviceId: 'gmail', accountEmail: 'x@y.z', senderEmail: 'b@c.d', subject: 'Re: Договор №5' });
  assert.equal(softKey(a), softKey(b));
});

check('ссылка учитывает выбор «вся переписка»', () => {
  const task = makeTask({ messageLink: 'https://m/msg', threadLink: 'https://m/thread' });
  assert.equal(taskLink(task), 'https://m/msg');
  assert.equal(taskLink({ ...task, useThreadLink: true }), 'https://m/thread');
  assert.equal(taskLink(makeTask({ searchLink: 'https://m/search' })), 'https://m/search');
});

check('отправитель деградирует без данных', () => {
  assert.equal(displaySender(makeTask()), 'отправитель не определён');
  assert.equal(displaySender(makeTask({ senderEmail: 'a@b.c' })), 'a@b.c');
  assert.equal(displaySender(makeTask({ senderName: 'Иван', senderEmail: 'a@b.c' })), 'Иван · a@b.c');
});

check('быстрые сроки дают корректные даты', () => {
  for (const preset of duePresets('09:00')) {
    assert.ok(parseLocalStr(joinLocal(preset.date, preset.time)) > 0);
  }
  assert.equal(splitLocal('2026-01-02T03:04').time, '03:04');
  assert.equal(toDateStr(new Date(addDays(Date.now(), 1))).length, 10);
});

check('форматирование дат', () => {
  assert.ok(formatWhen(Date.now()).startsWith('Сегодня'));
  assert.ok(formatWhen(addDays(Date.now(), 1)).startsWith('Завтра'));
  assert.ok(formatRelative(Date.now() - 7200000).endsWith('назад'));
  assert.ok(formatRelative(Date.now() + 7200000).startsWith('через'));
});

check('склонение числительных', () => {
  const forms = ['письмо', 'письма', 'писем'];
  assert.equal(plural(1, forms), '1 письмо');
  assert.equal(plural(3, forms), '3 письма');
  assert.equal(plural(5, forms), '5 писем');
  assert.equal(plural(11, forms), '11 писем');
  assert.equal(plural(21, forms), '21 письмо');
  assert.equal(plural(0, forms), '0 писем');
});

// Конвертация thread-f:<decimal> → legacy hex, как в контент-скрипте Gmail.
check('id треда Gmail переводится в hex', () => {
  const hex = (value) => {
    const match = String(value).match(/(?:thread|msg)-[af]:(\d+)/);
    return match ? BigInt(match[1]).toString(16) : '';
  };
  assert.equal(hex('#thread-f:1638756560099919527|msg-f:1638756560099919527'), '16be0868ae18c6a7');
  assert.equal(hex('thread-f:1639328810092166278'), '16c010de039b7c86');
  assert.equal(hex('без id'), '');
});

/* ------------------------------- Ссылки ---------------------------------- */

const gmailTask = makeTask({
  serviceId: 'gmail',
  accountEmail: 'user@gmail.com',
  senderEmail: 'chelsea.c@ifttt.com',
  subject: 'ТЕМА, ИЗМЕНЁННАЯ ПОЛЬЗОВАТЕЛЕМ',
  messageLink: 'https://mail.google.com/mail/u/0/#all/16be0868ae18c6a7',
  searchLink: 'https://mail.google.com/mail/u/0/#search/subject%3A%22Старая+тема%22'
});

const yandex360Task = makeTask({
  serviceId: 'yandex',
  accountId: '1130000058908991',
  senderEmail: 'opt@dimax.spb.ru',
  subject: 'ТЕМА, ИЗМЕНЁННАЯ ПОЛЬЗОВАТЕЛЕМ',
  messageLink: 'https://mail.360.yandex.ru/?uid=1130000058908991#/message/183521684815354082'
});

check('поиск идёт по отправителю, а не по теме', () => {
  for (const task of [gmailTask, yandex360Task]) {
    const url = searchUrl(task);
    assert.ok(url, 'ссылка не построена');
    assert.ok(!/subject|%D0%A2%D0%95%D0%9C%D0%90/i.test(url), `тема попала в поиск: ${url}`);
    assert.ok(
      url.includes(task.senderEmail) || url.includes(encodeURIComponent(task.senderEmail)),
      url
    );
  }
});

check('Gmail: поиск во всех папках нужного ящика', () => {
  assert.equal(
    searchUrl(gmailTask),
    'https://mail.google.com/mail/u/user@gmail.com/#search/from%3Achelsea.c%40ifttt.com+in%3Aanywhere'
  );
});

check('Яндекс 360: и ссылка, и поиск сохраняют uid ящика', () => {
  for (const url of [resolveUrl(yandex360Task), searchUrl(yandex360Task)]) {
    const parsed = new URL(url);
    assert.equal(parsed.host, 'mail.360.yandex.ru');
    assert.equal(parsed.searchParams.get('uid'), '1130000058908991');
  }
});

check('Яндекс: uid добавляется к задаче, сохранённой без него', () => {
  const legacy = makeTask({
    serviceId: 'yandex',
    accountId: '1130000058908991',
    messageLink: 'https://mail.360.yandex.ru/#/message/183521684815354082'
  });
  const parsed = new URL(resolveUrl(legacy));
  assert.equal(parsed.searchParams.get('uid'), '1130000058908991');
  assert.equal(parsed.hash, '#/message/183521684815354082');
});

check('без отправителя остаётся ссылка, собранная при захвате письма', () => {
  const task = makeTask({ serviceId: 'gmail', searchLink: 'https://mail.google.com/#search/x' });
  assert.equal(searchUrl(task), 'https://mail.google.com/#search/x');
});

console.log(`ok: ${passed} проверок`);
