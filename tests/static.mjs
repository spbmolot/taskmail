/*
 * Статические запреты платформы.
 *
 * Это не стиль, а вещи, на которых расширение падает в бою, но которые
 * спокойно проходят и синтаксическую проверку, и тесты на Node: там, где
 * Chrome запрещает конструкцию, Node её выполняет.
 */

import assert from 'node:assert';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRunner } from './mock-chrome.mjs';

const { check, done } = createRunner('static');
const root = fileURLToPath(new URL('../', import.meta.url));

function filesUnder(dir, extension = '.js') {
  const out = [];
  (function walk(current) {
    for (const name of readdirSync(current)) {
      const full = join(current, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (full.endsWith(extension)) out.push(full);
    }
  })(join(root, dir));
  return out;
}

// В Windows разделитель путей — обратный слэш; в отчётах хотим единый вид.
const SEPARATOR = String.fromCharCode(92);
const read = (file) => ({
  path: relative(root, file).split(SEPARATOR).join('/'),
  code: readFileSync(file, 'utf8')
});

/** Убирает комментарии: запреты касаются кода, а не пояснений к нему. */
function stripComments(code) {
  return code
    .split(String.fromCharCode(10))
    .filter((line) => !line.trimStart().startsWith('*'))
    .map((line) => {
      const at = line.indexOf('//');
      // «https://» — не комментарий, а часть ссылки в коде.
      if (at === -1 || (at > 0 && line[at - 1] === ':')) return line;
      return line.slice(0, at);
    })
    .join(String.fromCharCode(10));
}

await check('в service worker нет динамического import()', () => {
  // import() запрещён в ServiceWorkerGlobalScope спецификацией HTML:
  // https://github.com/w3c/ServiceWorker/issues/1356 — в бою это TypeError
  // внутри обработчика, а на Node такой код прекрасно работает.
  for (const { path, code } of filesUnder('src/background').map(read)) {
    const found = stripComments(code).match(/(?<![\w.$])import\s*\(/);
    assert.ok(!found, `${path}: динамический import() — в service worker он запрещён`);
  }
});

await check('контент-скрипт самодостаточен: без import и export', () => {
  // Статически объявленные контент-скрипты не поддерживают ES-модули:
  // любой import там — SyntaxError при внедрении.
  for (const { path, code } of filesUnder('src/content').map(read)) {
    assert.ok(!/^\s*import\s/m.test(code), `${path}: import в контент-скрипте не сработает`);
    assert.ok(!/^\s*export\s/m.test(code), `${path}: export в контент-скрипте не сработает`);
  }
});

await check('в service worker нет обращений к DOM и localStorage', () => {
  for (const { path, code } of filesUnder('src/background').map(read)) {
    const clean = stripComments(code);
    for (const forbidden of ['document.', 'window.', 'localStorage', 'XMLHttpRequest']) {
      assert.ok(!clean.includes(forbidden), `${path}: ${forbidden} в service worker недоступен`);
    }
  }
});

await check('нет удалённого кода и eval — иначе магазин отклонит пакет', () => {
  const sources = [...filesUnder('src'), ...filesUnder('src', '.html')].map(read);
  for (const { path, code } of sources) {
    const clean = stripComments(code);
    assert.ok(!/\beval\s*\(/.test(code), `${path}: eval запрещён политикой расширений`);
    assert.ok(!/new\s+Function\s*\(/.test(clean), `${path}: new Function запрещён`);
    assert.ok(
      !/https?:[/][/](?!mail[.]|360[.]|e[.]mail)[a-z]/.test(clean),
      `${path}: ссылка на внешний ресурс — расширение не должно ходить в сеть`
    );
  }
});

done();
