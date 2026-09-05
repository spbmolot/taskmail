/*
 * Извлечение данных письма из DOM почтового сервиса.
 *
 * Контент-скрипты не поддерживают ES-модули, поэтому файл самодостаточный.
 * Скрипт запоминает элемент под правой кнопкой мыши и по запросу фонового
 * скрипта отдаёт: тему, отправителя, идентификаторы письма и треда, ссылку на
 * письмо, ссылку на всю переписку и поисковую ссылку на случай, если письмо
 * переместили или удалили.
 *
 * Опора — на ARIA и data-атрибуты; обфусцированные двухбуквенные классы Gmail
 * (zA, hP, gD, bog, adn) используются только как запасной вариант, потому что
 * Google меняет их без предупреждения.
 */

(() => {
  if (window.__taskmailExtractorReady) return;
  window.__taskmailExtractorReady = true;

  const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
  const CLICK_TTL_MS = 15000;
  const HOVER_TTL_MS = 60000;
  const HOVER_THROTTLE_MS = 200;
  // Фора фрейму с письмом: верхний фрейм отвечает пустым только после неё.
  const REPLY_DELAY_MS = 200;

  let lastClick = null;
  let lastHover = null;

  // Слушаем в фазе перехвата: Gmail и Яндекс Почта гасят contextmenu своим
  // меню (preventDefault), но до capture-обработчика событие всё равно доходит.
  document.addEventListener(
    'contextmenu',
    (event) => {
      lastClick = { node: event.target, at: Date.now() };
    },
    true
  );

  // Запасной якорь для вызова с клавиатуры и из окна расширения: письмо,
  // над которым мышь была последний раз.
  document.addEventListener(
    'mouseover',
    (event) => {
      const now = Date.now();
      if (lastHover && now - lastHover.at < HOVER_THROTTLE_MS) return;
      lastHover = { node: event.target, at: now };
    },
    true
  );

  /* ------------------------------- Утилиты -------------------------------- */

  const text = (node) => (node ? (node.textContent || '').replace(/\s+/g, ' ').trim() : '');

  const visible = (node) => Boolean(node && node.offsetParent !== null);

  function firstText(root, selectors) {
    for (const selector of selectors) {
      const found = root.querySelector(selector);
      const value = text(found);
      if (value) return value;
    }
    return '';
  }

  /**
   * Тема письма — заголовок, а не контейнер. Отсекаем узлы, чей текст склеен из
   * нескольких блоков: в Яндекс 360 под селектор темы иначе попадает панель
   * «Письма на тему», и в задачу уезжает «Письма на темуИмя17.08.23Без текста».
   */
  function pickSubject(root, selectors) {
    for (const selector of selectors) {
      for (const node of root.querySelectorAll(selector)) {
        if (!visible(node)) continue;

        const blocks = [...node.children].filter((child) => text(child).length > 0);
        if (blocks.length > 2) continue;

        const value = text(node);
        if (value.length > 1 && value.length <= 300) return value;
      }
    }
    return '';
  }

  function closestAny(node, selectors) {
    if (!node || !node.closest) return null;
    for (const selector of selectors) {
      try {
        const found = node.closest(selector);
        if (found) return found;
      } catch (error) {
        /* некорректный селектор в конкретной версии вёрстки — идём дальше */
      }
    }
    return null;
  }

  /** Ищет адрес в атрибутах и тексте: email, data-hovercard-id, title, mailto. */
  function findEmail(root) {
    if (!root) return '';
    const nodes = [root];
    if (root.querySelectorAll) {
      nodes.push(
        ...root.querySelectorAll('[email], [data-hovercard-id], [title], [aria-label], a[href^="mailto:"]')
      );
    }
    for (const node of nodes) {
      if (!node.getAttribute) continue;
      for (const attr of ['email', 'data-hovercard-id', 'title', 'aria-label', 'href']) {
        const value = node.getAttribute(attr);
        const match = value && value.match(EMAIL_RE);
        if (match) return match[0];
      }
    }
    const match = text(root).match(EMAIL_RE);
    return match ? match[0] : '';
  }

  function cleanName(name, email) {
    const value = (name || '').replace(EMAIL_RE, '').replace(/[<>"]/g, '').replace(/\s+/g, ' ').trim();
    if (value && value !== ',') return value;
    return email ? email.split('@')[0] : '';
  }

  /** Кодирование для хэша Gmail: пробел как «+», всё остальное percent-encoding. */
  const q = (value) => encodeURIComponent(value).replace(/%20/g, '+');

  /** Базовый путь текущего сервиса — сохраняет префикс аккаунта, если он есть. */
  function originBase() {
    const path = location.pathname.replace(/\/+$/, '');
    return location.origin + path;
  }

  /* --------------------- Универсальный разбор строки ---------------------- */

  const DATE_LIKE = /^(\d{1,2}[:.]\d{2}|\d{1,2}\s+[а-яa-z]{3,}\.?|вчера|сегодня|\d{1,2}\.\d{1,2}(\.\d{2,4})?)$/i;

  /**
   * Запасной разбор, когда классы вёрстки не совпали: тема — самый длинный
   * видимый текст строки, отправитель — текст рядом с адресом. Грубо, но
   * позволяет создать задачу и поправить поля вручную вместо пустого окна.
   */
  function guessFromRow(row) {
    if (!row) return { subject: '', senderName: '', senderEmail: '' };

    const leaves = [...row.querySelectorAll('*')]
      .filter((node) => !node.children.length && visible(node))
      .map((node) => ({ node, value: text(node) }))
      .filter((item) => item.value.length > 1 && !DATE_LIKE.test(item.value));

    const senderEmail = findEmail(row);

    // Отправитель: узел с адресом в title/атрибутах, иначе первый текст строки.
    const senderItem =
      leaves.find((item) => {
        const holder = item.node.closest('[title], [aria-label]');
        const attr = holder
          ? holder.getAttribute('title') || holder.getAttribute('aria-label') || ''
          : '';
        return EMAIL_RE.test(attr) || (senderEmail && attr.includes(senderEmail));
      }) || leaves[0];

    // Тема идёт в строке письма сразу за отправителем, а следом — превью текста,
    // которое обычно длиннее. Поэтому берём ПЕРВЫЙ подходящий узел, а не самый
    // длинный: иначе в тему попадёт начало письма.
    const rest = leaves.filter((item) => item !== senderItem && item.value.length > 2);
    const subjectItem = rest[0] || null;

    return {
      subject: subjectItem ? subjectItem.value.slice(0, 300) : '',
      senderName: cleanName(senderItem ? senderItem.value : '', senderEmail),
      senderEmail
    };
  }

  /* -------------------------------- Gmail --------------------------------- */

  const gmail = {
    id: 'gmail',
    matches: () => location.host === 'mail.google.com',

    account() {
      const fromPath = location.pathname.match(/^\/mail\/u\/([^/]+)/);
      const index = fromPath ? decodeURIComponent(fromPath[1]) : '';

      // «Тема - user@example.com - Gmail»: самый доступный источник адреса.
      const fromTitle = document.title.match(/\s-\s([^\s@]+@[^\s]+)\s-\s/);
      let email = fromTitle ? fromTitle[1] : '';

      if (!email) {
        // Кнопка аккаунта в шапке: ищем по наличию «@», а не по тексту —
        // подписи локализуются.
        const node = [...document.querySelectorAll('a[aria-label*="@"], [aria-label*="@"]')].find(
          (item) => EMAIL_RE.test(item.getAttribute('aria-label') || '')
        );
        if (node) email = (node.getAttribute('aria-label').match(EMAIL_RE) || [''])[0];
      }
      if (!email && index.includes('@')) email = index;

      return { accountId: index, accountEmail: email };
    },

    base(account) {
      const segment = account.accountEmail || account.accountId || '0';
      // Gmail ждёт адрес как есть: %40 вместо @ ломает переход к аккаунту.
      return `https://mail.google.com/mail/u/${encodeURIComponent(segment).replace(/%40/g, '@')}/`;
    },

    /** «#thread-f:1638756560099919527|msg-f:…» → legacy hex для ссылки #all/. */
    legacyHex(value) {
      const match = String(value || '').match(/(?:thread|msg)-[af]:(\d+)/);
      if (!match) return '';
      try {
        return BigInt(match[1]).toString(16);
      } catch (error) {
        return '';
      }
    },

    searchLink(base, senderEmail, subject) {
      const parts = [];
      if (senderEmail) parts.push(`from:${senderEmail}`);
      if (subject) parts.push(`subject:"${subject.slice(0, 80)}"`);
      // in:anywhere включает Корзину и Спам — именно там письмо и окажется,
      // если задачу открывают спустя неделю.
      parts.push('in:anywhere');
      return `${base}#search/${q(parts.join(' '))}`;
    },

    rows() {
      const scope = document.querySelector('div[role="main"]') || document;
      return [...scope.querySelectorAll('tr.zA, [gh="tl"] tr[role="row"]')];
    },

    selectedRows() {
      return this.rows().filter((row) =>
        row.querySelector('div[role="checkbox"][aria-checked="true"], input[type="checkbox"]:checked')
      );
    },

    fromRow(row, account) {
      const base = this.base(account);
      const idNode = row.querySelector('span[data-thread-id], [data-legacy-message-id]');
      const rawThread = idNode ? idNode.getAttribute('data-thread-id') || '' : '';
      // Значение бывает составным: «#thread-f:123|msg-f:456».
      const threadPerm = rawThread.replace(/^#/, '').split('|')[0];
      const threadHex = this.legacyHex(threadPerm);
      const legacyMessageId = idNode ? idNode.getAttribute('data-legacy-message-id') || '' : '';

      const senderNode = row.querySelector('[email][name], [email], [data-hovercard-id]');
      const senderEmail = (senderNode && senderNode.getAttribute('email')) || findEmail(senderNode) || '';
      const senderName = cleanName(
        (senderNode && (senderNode.getAttribute('name') || text(senderNode))) || '',
        senderEmail
      );

      const subject =
        firstText(row, ['span.bog > span', 'span.bog']) ||
        (text(row.querySelector('[role="link"]')) || '').split(' - ')[0];

      const threadLink = threadHex ? `${base}#all/${threadHex}` : '';

      return {
        subject,
        senderName,
        senderEmail,
        threadId: threadPerm || threadHex || '',
        messageId: legacyMessageId,
        // Из списка мы опознаём тред целиком — отдельной ссылки на письмо нет.
        messageLink: threadLink,
        threadLink,
        searchLink: this.searchLink(base, senderEmail, subject),
        partial: !threadLink
      };
    },

    fromOpenMessage(target, account) {
      const base = this.base(account);
      const subjectNode = [...document.querySelectorAll('h2.hP, [data-legacy-thread-id]')].find(visible);
      const subject = text(subjectNode) || (document.title.match(/^(.*?)\s-\s[^\s]+@/) || [])[1] || '';

      const permNode = document.querySelector('[data-thread-perm-id]');
      const threadHex =
        (subjectNode && subjectNode.getAttribute('data-legacy-thread-id')) ||
        this.legacyHex(permNode && permNode.getAttribute('data-thread-perm-id')) ||
        '';

      // Письмо под курсором, иначе последнее раскрытое в треде.
      const messageNode =
        closestAny(target, ['div.adn', '[data-legacy-message-id]']) ||
        [...document.querySelectorAll('div.adn, [data-legacy-message-id]')].filter(visible).pop() ||
        null;

      const legacyMessageId = messageNode
        ? messageNode.getAttribute('data-legacy-message-id') || ''
        : '';

      const senderNode =
        (messageNode && messageNode.querySelector('span[email].gD, [email][name], [data-hovercard-id]')) ||
        document.querySelector('span[email].gD, [email][name]');
      const senderEmail = (senderNode && senderNode.getAttribute('email')) || findEmail(senderNode) || '';
      const senderName = cleanName(
        (senderNode && (senderNode.getAttribute('name') || text(senderNode))) || '',
        senderEmail
      );

      const threadLink = threadHex ? `${base}#all/${threadHex}` : '';
      const messageLink = legacyMessageId ? `${base}#all/${legacyMessageId}` : threadLink;

      return {
        subject,
        senderName,
        senderEmail,
        threadId: threadHex,
        messageId: legacyMessageId,
        messageLink,
        threadLink,
        searchLink: this.searchLink(base, senderEmail, subject),
        partial: !threadLink && !messageLink
      };
    },

    collect(target) {
      const account = this.account();
      const row = closestAny(target, ['tr.zA', '[gh="tl"] tr[role="row"]']);
      const insideMessage = Boolean(
        closestAny(target, ['div.adn', '.ii.gt', '[data-message-id]']) ||
          (!row && [...document.querySelectorAll('h2.hP')].some(visible))
      );

      if (insideMessage) {
        return { mode: 'message', selection: [this.fromOpenMessage(target, account)], ...account };
      }

      const selected = this.selectedRows();
      // Правый клик по строке вне выделения — работаем именно с ней,
      // как это делает нативное контекстное меню.
      if (selected.length > 1 && (!row || selected.includes(row))) {
        return {
          mode: 'list',
          selection: selected.map((item) => this.fromRow(item, account)),
          ...account
        };
      }

      const single = row || selected[0];
      if (single) {
        return { mode: 'list', selection: [this.fromRow(single, account)], ...account };
      }

      return { mode: 'unknown', selection: [], ...account };
    }
  };

  /* ----------------------------- Яндекс Почта ------------------------------ */

  const yandex = {
    id: 'yandex',
    matches: () =>
      /(^|\.)yandex\.[a-z.]+$/.test(location.host) &&
      (location.host.startsWith('mail.') || location.host.startsWith('360.')),

    /** Новый интерфейс Яндекс 360: mail.360.yandex.ru, маршруты вида #/folder/67. */
    isNew() {
      return (
        location.host.includes('360.') ||
        location.hash.startsWith('#/') ||
        Boolean(document.querySelector('[data-testid="messages-list_container"]'))
      );
    },

    account() {
      // В Яндекс 360 аккаунт задан параметром uid — он же различает ящики.
      const uid = new URLSearchParams(location.search).get('uid') || '';
      const prefix = (location.pathname.match(/^\/(u\d+)\//) || [])[1] || '';

      // Ищем адрес ТОЛЬКО в блоках аккаунта: любой `[title*="@"]` по документу
      // подхватил бы адрес отправителя из списка писем и приписал задачу
      // не тому ящику.
      const node = [
        ...document.querySelectorAll(
          '[data-testid*="account"], [data-testid*="user-menu"], [class*="qa-Account"], ' +
            '[class*="ccount"], [class*="UserMenu"], #js-user-account'
        )
      ].find((item) =>
        EMAIL_RE.test(
          item.getAttribute('aria-label') || item.getAttribute('title') || text(item) || ''
        )
      );
      const source = node
        ? node.getAttribute('aria-label') || node.getAttribute('title') || text(node)
        : '';
      const email = (source.match(EMAIL_RE) || [''])[0] || (document.title.match(EMAIL_RE) || [''])[0];

      return { accountId: uid || prefix, accountEmail: email };
    },

    /** База ссылки с сохранением аккаунта: uid в query, старый префикс в пути. */
    base() {
      const uid = new URLSearchParams(location.search).get('uid');
      const prefix = (location.pathname.match(/^\/(u\d+)\//) || [])[1];
      return `${location.origin}/${prefix ? prefix + '/' : ''}${uid ? `?uid=${uid}` : ''}`;
    },

    /*
     * От специфичных селекторов к общим. В Яндекс 360 имена классов хешируются
     * при каждой сборке (MessagesList__root--0Sxmu), поэтому опора — на
     * data-testid и служебные классы qa-*, которые ставятся для автотестов и
     * потому стабильны.
     */
    rowSelectors: [
      '[data-testid="messages-list_item"]',
      '[data-testid*="message-snippet"]',
      '[data-testid*="messages-list_item"]',
      '[class*="qa-MessageSnippet"]',
      '.mail-MessageSnippet',
      '[data-key*="messages-item"]',
      '.ns-view-messages-item',
      '[class*="MessageSnippet"]',
      'a[href*="/message/"]',
      '[role="listitem"][data-id]',
      'li[data-id]',
      '[data-id][class*="essage"]'
    ],

    rows() {
      for (const selector of this.rowSelectors) {
        const found = [...document.querySelectorAll(selector)].filter(visible);
        if (found.length) return found;
      }

      // Ничего не совпало — берём прямых потомков контейнера списка писем.
      const list = document.querySelector(
        '[data-testid="messages-list_container"], [data-testid*="messages-list"]'
      );
      if (!list) return [];
      return [...list.children].filter(
        (node) => visible(node) && text(node).length > 5 && !/footer|loader/i.test(node.dataset.testid || '')
      );
    },

    selectedRows() {
      return this.rows().filter(
        (row) =>
          row.matches('.mail-MessageSnippet_checked, [aria-checked="true"], [class*="_checked"]') ||
          row.querySelector('input[type="checkbox"]:checked, [aria-checked="true"]')
      );
    },

    idOf(row) {
      if (!row) return '';
      const holder = row.matches('[data-id], [data-mid], [data-message-id]')
        ? row
        : row.querySelector('[data-id], [data-mid], [data-message-id]');

      const raw =
        (holder &&
          (holder.getAttribute('data-id') ||
            holder.getAttribute('data-mid') ||
            holder.getAttribute('data-message-id'))) ||
        (row.getAttribute('data-key') || '').match(/id=([^&:]+)/)?.[1] ||
        // В новом интерфейсе строка — ссылка вида /message/188... или #/message/188...
        (row.querySelector('a[href*="/message/"]') || row).getAttribute?.('href')?.match(/\/message\/([^/?#]+)/)?.[1] ||
        (row.id && /\d{6,}/.test(row.id) ? row.id.match(/\d{6,}/)[0] : '') ||
        '';

      return String(raw).replace(/^.*:/, '');
    },

    searchLink(subject, senderEmail) {
      const request = [subject, senderEmail].filter(Boolean).join(' ').slice(0, 120);
      if (!request) return '';
      const query = encodeURIComponent(request);
      return this.isNew()
        ? `${this.base()}#/search?request=${query}`
        : `${this.base()}#search?request=${query}`;
    },

    /** Ссылка на письмо: в 360 маршруты начинаются со слэша (#/message/…). */
    messageUrl(id, kind = 'message') {
      if (!id) return '';
      return this.isNew() ? `${this.base()}#/${kind}/${id}` : `${this.base()}#${kind}/${id}`;
    },

    entry(row, account) {
      const fromHash = (location.hash.match(/#\/?(?:message|thread)\/([^/?]+)/) || [])[1] || '';
      const id = row ? this.idOf(row) || fromHash : fromHash;

      // В открытом письме ищем внутри самого письма, а не по всей странице:
      // иначе в тему попадают боковые панели вроде «Письма на тему».
      const scope =
        row ||
        document.querySelector(
          '[data-testid*="message-viewer"], [data-testid*="message_container"], [class*="qa-MessageViewer"]'
        ) ||
        document;

      let subject =
        pickSubject(scope, [
          '[data-testid*="subject"]',
          '[class*="qa-Subject"]',
          '.mail-MessageSnippet-Item_subject',
          '.mail-Message-Subject',
          '.js-message-subject',
          'h1',
          'h2',
          '[class*="Subject"]'
        ]) ||
        // Последний источник — заголовок вкладки: «прайс — Яндекс Почта».
        (!row ? (document.title.split(/\s+—\s+/)[0] || '').trim() : '');

      const senderNode =
        scope.querySelector(
          '[data-testid*="correspondent"], [data-testid*="sender"], [data-testid*="from"], ' +
            '.mail-MessageSnippet-FromText, [class*="FromText"], [class*="Sender"], [title*="@"], a[href^="mailto:"]'
        ) || null;
      let senderEmail = findEmail(senderNode) || findEmail(scope);
      let senderName = cleanName(
        (senderNode && (senderNode.getAttribute('title') || text(senderNode))) || '',
        senderEmail
      );

      // Классы не совпали (вёрстку переделали) — достраиваем недостающее
      // структурным разбором. Именно недостающее: если тему нашли по селектору,
      // догадка её не перебивает.
      let guessed = false;
      if (row && (!subject || !senderName)) {
        const guess = guessFromRow(row);
        if (!subject && guess.subject) {
          subject = guess.subject;
          guessed = true;
        }
        if (!senderName && guess.senderName) {
          senderName = guess.senderName;
          guessed = true;
        }
        senderEmail = senderEmail || guess.senderEmail;
      }

      const isThread =
        Boolean(row && /thread/i.test(row.className || '')) || /#\/?thread\//.test(location.hash);
      const messageLink = this.messageUrl(id) || location.href;
      const threadLink = id && isThread ? this.messageUrl(id, 'thread') : '';

      return {
        subject,
        senderName,
        senderEmail,
        messageId: isThread ? '' : id,
        threadId: isThread ? id : '',
        messageLink,
        threadLink,
        searchLink: this.searchLink(subject, senderEmail),
        // Помечаем разбор ненадёжным: окно задачи покажет предупреждение, и
        // пользователь проверит поля до сохранения.
        partial: !id || guessed
      };
    },

    /** Строка списка = предок, который лежит непосредственно в контейнере списка. */
    rowInList(target) {
      const list = closestAny(target, [
        '[data-testid="messages-list_container"]',
        '[data-testid*="messages-list"]'
      ]);
      if (!list) return null;
      let node = target;
      while (node && node.parentElement && node.parentElement !== list) node = node.parentElement;
      return node && node.parentElement === list ? node : null;
    },

    collect(target) {
      const account = this.account();
      const row =
        closestAny(target, this.rowSelectors) ||
        // Последний рубеж: контейнер с идентификатором или прямой потомок списка.
        closestAny(target, ['[data-id]', '[role="listitem"]', '[role="row"]', 'li', 'tr']) ||
        this.rowInList(target);
      const openMessage = closestAny(target, [
        '[data-testid*="message-viewer"]',
        '[data-testid*="message_body"]',
        '.mail-Message',
        '[class*="MessageViewer"]',
        '[class*="MessageBody"]',
        '[class*="Message_"]'
      ]);
      const openByUrl = /#\/?(message|thread)\//.test(location.hash);

      if (!row && (openMessage || openByUrl)) {
        return { mode: 'message', selection: [this.entry(null, account)], ...account };
      }

      const selected = this.selectedRows();
      if (selected.length > 1 && (!row || selected.includes(row))) {
        return { mode: 'list', selection: selected.map((item) => this.entry(item, account)), ...account };
      }

      const single = row || selected[0];
      if (single) return { mode: 'list', selection: [this.entry(single, account)], ...account };

      // Ничего не нашли, но письмо открыто по адресу — берём хотя бы его.
      if (openByUrl) {
        return { mode: 'message', selection: [this.entry(null, account)], ...account };
      }

      return { mode: 'unknown', selection: [], ...account };
    }
  };

  /* -------------------------------- Mail.ru -------------------------------- */

  const mailru = {
    id: 'mailru',
    matches: () => /(^|\.)mail\.ru$/.test(location.host),

    account() {
      const node = document.querySelector('[data-testid*="account"], [class*="account"] [title*="@"]');
      const email = findEmail(node) || '';
      return { accountId: '', accountEmail: email };
    },

    rowSelectors: ['a.llc', '.llc', '[data-id][class*="llc"]', '.js-letter-list-item'],

    rows() {
      for (const selector of this.rowSelectors) {
        const found = [...document.querySelectorAll(selector)];
        if (found.length) return found;
      }
      return [];
    },

    selectedRows() {
      return this.rows().filter(
        (row) =>
          row.matches('[class*="_checked"], [aria-checked="true"]') ||
          row.querySelector('input[type="checkbox"]:checked, [aria-checked="true"]')
      );
    },

    entry(row) {
      const scope = row || document;
      const href = (row && row.getAttribute('href')) || '';
      const id = (row && row.getAttribute('data-id')) || (href.match(/\/(\d+:[\d-]+)\//) || [])[1] || '';
      const link = href ? new URL(href, location.origin).href : location.href;

      const subject = firstText(scope, [
        '.llc__subject-text',
        '[class*="subject"]',
        '.thread__subject',
        '.letter__title',
        'h1'
      ]);

      const senderNode =
        scope.querySelector('.llc__item_correspondent span[title], [class*="correspondent"], [title*="@"]') ||
        null;
      const senderEmail = findEmail(senderNode) || findEmail(scope);
      const senderName = cleanName(
        (senderNode && (senderNode.getAttribute('title') || text(senderNode))) || '',
        senderEmail
      );

      return {
        subject,
        senderName,
        senderEmail,
        messageId: id,
        threadId: '',
        messageLink: link,
        threadLink: '',
        searchLink: subject
          ? `${location.origin}/search/?q_query=${encodeURIComponent(subject.slice(0, 100))}`
          : '',
        partial: !id
      };
    },

    collect(target) {
      const account = this.account();
      const row = closestAny(target, this.rowSelectors);
      const selected = this.selectedRows();

      if (selected.length > 1 && (!row || selected.includes(row))) {
        return { mode: 'list', selection: selected.map((item) => this.entry(item)), ...account };
      }
      const single = row || selected[0];
      if (single) return { mode: 'list', selection: [this.entry(single)], ...account };
      if (location.pathname.match(/\/\d+:/)) {
        return { mode: 'message', selection: [this.entry(null)], ...account };
      }
      return { mode: 'unknown', selection: [], ...account };
    }
  };

  const ADAPTERS = [gmail, yandex, mailru];

  /* -------------------------------- Сборка --------------------------------- */

  /** Свежий и всё ещё живой в DOM элемент: почта постоянно перерисовывает список. */
  function pick(entry, ttl) {
    if (!entry || Date.now() - entry.at > ttl) return null;
    return entry.node && entry.node.isConnected ? entry.node : null;
  }

  function collect() {
    const adapter = ADAPTERS.find((item) => item.matches());
    const target = pick(lastClick, CLICK_TTL_MS) || pick(lastHover, HOVER_TTL_MS);

    const empty = {
      serviceId: adapter ? adapter.id : 'other',
      accountId: '',
      accountEmail: '',
      mode: 'unknown',
      selection: []
    };

    if (!adapter) return empty;

    try {
      const result = adapter.collect(target);
      return { ...empty, ...result, serviceId: adapter.id };
    } catch (error) {
      console.warn('TaskMail: не удалось разобрать письмо', error);
      return empty;
    }
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || message.type !== 'TASKMAIL_EXTRACT') return false;

    const result = collect();

    // Запрос адресован именно этому фрейму (правый клик) — отвечаем всегда,
    // даже пустым: фоновый скрипт сам подставит запасные данные из вкладки.
    if (message.targeted || result.selection.length) {
      sendResponse(result);
      return false;
    }

    // Широковещательный запрос (горячая клавиша, кнопка в списке): письмо
    // живёт только в одном фрейме, а отвечают все — побеждает первый ответ.
    // Поэтому фрейм без письма молчит, а верхний отвечает с задержкой, отдавая
    // приоритет фрейму с письмом. Если такого нет, его ответ станет запасным.
    if (window.top !== window) return false;

    setTimeout(() => sendResponse(result), REPLY_DELAY_MS);
    return true;
  });
})();
