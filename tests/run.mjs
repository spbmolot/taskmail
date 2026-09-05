/*
 * Единая точка запуска проверок: node tests/run.mjs
 *
 * Каждый набор идёт отдельным процессом — у планировщика и синхронизации есть
 * внутреннее состояние (флаг прохода, очередь записи), и общий процесс сделал
 * бы результат зависимым от порядка запуска.
 */

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const suites = [
  'selftest.mjs',
  'static.mjs',
  'boot.mjs',
  'collect.mjs',
  'migrate.mjs',
  'notify.mjs',
  'reminders.mjs',
  'sync.mjs'
];

let failed = 0;
for (const suite of suites) {
  const result = spawnSync(process.execPath, [join(here, suite)], { stdio: 'inherit' });
  if (result.status !== 0) failed += 1;
}

if (failed) {
  console.error(`\nПровалено наборов: ${failed} из ${suites.length}`);
  process.exit(1);
}
console.log(`\nВсе наборы пройдены (${suites.length}).`);
