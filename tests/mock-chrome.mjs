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

/** Событие chrome.*: запоминает подписчиков, чтобы тест мог их вызвать. */
function event(registry, name) {
  return {
    addListener(fn) {
      registry.set(name, [...(registry.get(name) || []), fn]);
    },
    hasListener(fn) {
      return (registry.get(name) || []).includes(fn);
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
  const listeners = new Map();
  const menus = new Map();
  const windows = [];
  const tabs = [];

  // Вызывается перед каждым показом уведомления — тестам это нужно, чтобы
  // заглянуть в хранилище ровно в момент показа.
  const hooks = { beforeNotify: null };

  const chrome = {
    storage: {
      local: area(local),
      sync: area(sync),
      session: area(session),
      onChanged: event(listeners, 'storage.onChanged')
    },
    alarms: {
      onAlarm: event(listeners, 'alarms.onAlarm'),
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
      onClicked: event(listeners, 'notifications.onClicked'),
      onButtonClicked: event(listeners, 'notifications.onButtonClicked'),
      onClosed: event(listeners, 'notifications.onClosed'),
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
      getURL: (path) => `chrome-extension://test/${path}`,
      onInstalled: event(listeners, 'runtime.onInstalled'),
      onStartup: event(listeners, 'runtime.onStartup'),
      onMessage: event(listeners, 'runtime.onMessage')
    },
    contextMenus: {
      onClicked: event(listeners, 'contextMenus.onClicked'),
      create(item) {
        menus.set(item.id, item);
      },
      removeAll(callback) {
        menus.clear();
        if (callback) callback();
      }
    },
    commands: {
      onCommand: event(listeners, 'commands.onCommand'),
      async getAll() {
        return [{ name: 'create-task', shortcut: 'Ctrl+Shift+S' }];
      }
    },
    windows: {
      async create(options) {
        windows.push(options);
        return { id: windows.length, ...options };
      },
      async getCurrent() {
        return { id: 1, left: 0, top: 0, width: 1280 };
      },
      async update(id, options) {
        return { id, ...options };
      }
    },
    tabs: {
      async query() {
        return tabs;
      },
      async create(options) {
        tabs.push(options);
        return { id: tabs.length, ...options };
      },
      async update(id, options) {
        return { id, ...options };
      },
      async sendMessage() {
        return null;
      }
    },
    scripting: {
      async executeScript() {
        return [];
      }
    }
  };

  globalThis.chrome = chrome;

  return {
    chrome,
    listeners,
    menus,
    windows,
    tabs,
    /** Вызывает подписчиков события так же, как это сделал бы Chrome. */
    fire(name, ...args) {
      return (listeners.get(name) || []).map((fn) => fn(...args));
    },
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
