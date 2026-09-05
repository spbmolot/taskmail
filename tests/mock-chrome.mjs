/*
 * Мок chrome.* для тестов планировщика и синхронизации.
 *
 * Модули расширения обращаются к chrome.* только внутри функций, поэтому
 * достаточно положить объект в globalThis ДО динамического импорта модуля.
 * Значения проходят через structuredClone — как настоящее хранилище, которое
 * сериализует данные и не делится ссылками на объекты.
 */

function area(map) {
  const clone = (value) => (value === undefined ? undefined : structuredClone(value));

  return {
    async get(keys) {
      if (keys === null || keys === undefined) {
        return Object.fromEntries([...map].map(([key, value]) => [key, clone(value)]));
      }
      if (typeof keys === 'string') {
        return map.has(keys) ? { [keys]: clone(map.get(keys)) } : {};
      }
      if (Array.isArray(keys)) {
        const out = {};
        for (const key of keys) if (map.has(key)) out[key] = clone(map.get(key));
        return out;
      }
      const out = { ...keys };
      for (const key of Object.keys(keys)) if (map.has(key)) out[key] = clone(map.get(key));
      return out;
    },
    async set(items) {
      for (const [key, value] of Object.entries(items)) map.set(key, clone(value));
    },
    async remove(keys) {
      for (const key of [].concat(keys)) map.delete(key);
    },
    async clear() {
      map.clear();
    }
  };
}

/** Ставит свежий мок и возвращает доступ к его внутренностям. */
export function installChromeMock({ permissionLevel = 'granted' } = {}) {
  const local = new Map();
  const sync = new Map();
  const session = new Map();
  const alarms = new Map();
  const notifications = [];
  const badge = { text: '', title: '', color: '' };
  const state = { permissionLevel };

  // Вызывается перед каждым показом уведомления — тестам это нужно, чтобы
  // заглянуть в хранилище ровно в момент показа.
  const hooks = { beforeNotify: null };

  const chrome = {
    storage: {
      local: area(local),
      sync: area(sync),
      session: area(session),
      onChanged: { addListener() {} }
    },
    alarms: {
      create(name, info) {
        alarms.set(name, { name, ...info });
      },
      async clear(name) {
        return alarms.delete(name);
      },
      async get(name) {
        return alarms.get(name);
      },
      async getAll() {
        return [...alarms.values()];
      }
    },
    notifications: {
      create(id, options, callback) {
        if (hooks.beforeNotify) hooks.beforeNotify(id, options);
        notifications.push({ id, options });
        if (callback) callback(id);
      },
      clear(id, callback) {
        if (callback) callback(true);
      },
      getPermissionLevel(callback) {
        callback(state.permissionLevel);
      }
    },
    action: {
      async setBadgeText({ text }) {
        badge.text = text;
      },
      async setBadgeBackgroundColor({ color }) {
        badge.color = color;
      },
      async setTitle({ title }) {
        badge.title = title;
      }
    },
    runtime: {
      lastError: undefined,
      getURL: (path) => `chrome-extension://test/${path}`
    }
  };

  globalThis.chrome = chrome;

  return {
    chrome,
    local,
    sync,
    session,
    alarms,
    notifications,
    badge,
    hooks,
    setPermissionLevel(level) {
      state.permissionLevel = level;
    },
    tasks() {
      return local.get('tasks') || [];
    },
    meta() {
      return local.get('meta') || {};
    },
    settings(patch) {
      local.set('settings', { ...(local.get('settings') || {}), ...patch });
    },
    seed(tasks) {
      local.set('tasks', tasks);
    }
  };
}

/** Мелкий раннер: те же правила вывода, что у selftest.mjs. */
export function createRunner(title) {
  let passed = 0;
  let failed = 0;

  return {
    async check(name, fn) {
      try {
        await fn();
        passed += 1;
      } catch (error) {
        failed += 1;
        console.error(`FAIL: ${name}\n  ${error.message}`);
      }
    },
    done() {
      if (failed) process.exitCode = 1;
      console.log(`${title}: ${passed} проверок${failed ? `, провалено ${failed}` : ''}`);
    }
  };
}
