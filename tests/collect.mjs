/*
 * Подготовка черновиков: что попадает в окно задачи из данных вкладки.
 * Здесь же проверяется приватность — выделенный текст письма не должен
 * прикрепляться сам по себе.
 */

import assert from 'node:assert';
import { installChromeMock, createRunner } from './mock-chrome.mjs';
import { makeTask } from '../src/common/model.js';

const { check, done } = createRunner('collect');

const letter = (fields = {}) => ({
  subject: 'Договор на поставку',
  senderName: 'Анна Ковалёва',
  senderEmail: 'a.kovaleva@partner.ru',
  messageId: 'm1',
  threadId: '',
  messageLink: 'https://mail.google.com/mail/u/0/#all/16be0868ae18c6a7',
  threadLink: '',
  searchLink: 'https://mail.google.com/mail/u/0/#search/x',
  partial: false,
  ...fields
});

const payload = (selection, fields = {}) => ({
  serviceId: 'gmail',
  accountId: '0',
  accountEmail: 'user@gmail.com',
  mode: 'list',
  selection,
  ...fields
});

const tab = { id: 1, url: 'https://mail.google.com/mail/u/0/#inbox', title: '(12) Входящие' };

async function setup() {
  const mock = installChromeMock();
  const module = await import(`../src/background/collect.js?v=${Math.random()}`);
  const settings = await import(`../src/common/settings.js?v=${Math.random()}`);
  return { mock, ...module, defaults: await settings.getSettings() };
}

await check('одно письмо — черновик на одну задачу со сроком по умолчанию', async () => {
  const { buildDrafts, defaults } = await setup();
  const draft = await buildDrafts(payload([letter()]), { info: {}, tab, settings: defaults });

  assert.equal(draft.mode, 'single');
  assert.equal(draft.separate.length, 1);
  assert.equal(draft.separate[0].subject, 'Договор на поставку');
  assert.equal(draft.separate[0].accountEmail, 'user@gmail.com');
  assert.ok(draft.separate[0].remindLocal, 'срок по умолчанию не подставлен');
  assert.equal(draft.serviceLabel, 'Gmail');
});

await check('несколько писем — выбор остаётся за пользователем', async () => {
  const { buildDrafts, defaults } = await setup();
  const draft = await buildDrafts(
    payload([letter({ messageId: 'm1' }), letter({ messageId: 'm2', subject: 'Акт сверки' })]),
    { info: {}, tab, settings: defaults }
  );

  assert.equal(draft.mode, 'choose');
  assert.equal(draft.separate.length, 2);
  assert.equal(draft.combined.subject, '2 письма: Договор на поставку и др.');
  assert.equal(draft.combined.items.length, 2);
});

await check('нераспознанное письмо помечается, тема берётся из вкладки', async () => {
  const { buildDrafts, defaults } = await setup();
  const draft = await buildDrafts(payload([]), { info: {}, tab, settings: defaults });

  assert.equal(draft.partial, true, 'окно задачи должно предупредить о неточности');
  assert.equal(draft.separate[0].subject, 'Входящие', 'счётчик непрочитанных убран из темы');
  assert.equal(draft.separate[0].serviceId, 'gmail');
});

await check('повторное письмо распознаётся как дубликат', async () => {
  const { mock, buildDrafts, defaults } = await setup();
  mock.seed([
    makeTask({
      id: 'existing',
      subject: 'Договор на поставку',
      serviceId: 'gmail',
      accountEmail: 'user@gmail.com',
      messageId: 'm1'
    })
  ]);

  const draft = await buildDrafts(payload([letter()]), { info: {}, tab, settings: defaults });

  assert.equal(draft.duplicates.length, 1);
  assert.equal(draft.duplicates[0].tasks[0].id, 'existing');
});

await check('выделенный текст письма не прикрепляется без согласия', async () => {
  const { buildDrafts, defaults } = await setup();
  const info = { selectionText: 'Коллеги, направляю финальную версию договора' };

  const draft = await buildDrafts(payload([letter()]), { info, tab, settings: defaults });

  assert.equal(draft.excerpt, info.selectionText, 'текст показать в окне можно');
  assert.equal(draft.excerptAllowed, false, 'но галочка должна быть снята');
  assert.equal(draft.separate[0].excerpt, '', 'в саму задачу текст попадать не должен');
});

await check('запрос к вкладке помечается адресным только при известном фрейме', async () => {
  const { mock, collectFromTab } = await setup();
  const sent = [];
  mock.chrome.tabs.sendMessage = async (tabId, message, options) => {
    sent.push({ message, options });
    return payload([letter()]);
  };

  await collectFromTab(tab, { frameId: 7 });
  await collectFromTab(tab, {});

  assert.deepEqual(sent[0].options, { frameId: 7 });
  assert.equal(sent[0].message.targeted, true, 'адресный запрос должен получить ответ даже пустой');
  assert.equal(sent[1].options, undefined);
  assert.equal(sent[1].message.targeted, false, 'при рассылке пустые ответы мешают');
});

await check('если контент-скрипт молчит, он внедряется и запрос повторяется', async () => {
  const { mock, collectFromTab } = await setup();
  let attempt = 0;
  let injected = false;

  mock.chrome.tabs.sendMessage = async () => {
    attempt += 1;
    if (attempt === 1) throw new Error('Could not establish connection');
    return payload([letter()]);
  };
  mock.chrome.scripting.executeScript = async () => {
    injected = true;
    return [];
  };

  const result = await collectFromTab(tab, {});

  assert.equal(injected, true, 'скрипт не внедрён повторно');
  assert.equal(result.selection.length, 1, 'повторный запрос не выполнен');
});

done();
