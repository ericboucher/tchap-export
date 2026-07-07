// Tchap Conversation Exporter - content script
//
// Tchap is a soft-fork of Element/matrix-react-sdk, so the DOM keeps the
// same `mx_*` class names. Per-message timestamps are not reliably present
// in the DOM (Element only renders `.mx_MessageTimestamp` on hover, and even
// then it carries no date - just "HH:MM"), so dates are read from the
// `.mx_DateSeparator` headings ("today", "yesterday", or a full date) that
// Element inserts between days. Where possible we also walk the React fiber
// tree from a tile to read the underlying MatrixEvent for an exact
// millisecond timestamp; the date-separator value is the fallback used for
// day-level filtering when that isn't available.

(() => {
  const SELECTORS = {
    eventTile: '.mx_EventTile',
    scrollPanel: '.mx_ScrollPanel',
    messageList: 'ol.mx_RoomView_MessageList',
    spinner: '.mx_Spinner',
    topMarker: '.mx_RoomWelcomeView, .mx_NewRoomIntro, .mx_RoomView_topUnreadBar',
    roomName: '.mx_RoomHeader_heading, .mx_RoomHeader_name',
    dateSeparator: '.mx_TimelineSeparator',
    dateHeading: '.mx_DateSeparator_dateHeading',
  };

  const MONTHS = {
    jan: 0, janv: 0, january: 0, janvier: 0,
    feb: 1, febr: 1, february: 1, fevr: 1, févr: 1, fevrier: 1, février: 1,
    mar: 2, march: 2, mars: 2,
    apr: 3, avr: 3, april: 3, avril: 3,
    may: 4, mai: 4,
    jun: 5, juin: 5, june: 5,
    jul: 6, juil: 6, july: 6, juillet: 6,
    aug: 7, aout: 7, août: 7, august: 7,
    sep: 8, sept: 8, september: 8, septembre: 8,
    oct: 9, october: 9, octobre: 9,
    nov: 10, november: 10, novembre: 10,
    dec: 11, déc: 11, december: 11, decembre: 11, décembre: 11,
  };

  let running = false;
  let cancelled = false;
  let widgetEl = null;

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function startOfDay(d) {
    const r = new Date(d.getTime());
    r.setHours(0, 0, 0, 0);
    return r;
  }

  // ---- Date-separator parsing ("today" / "yesterday" / full date) --------------

  function parseDaySeparatorText(text) {
    const norm = (text || '').trim().toLowerCase();
    if (!norm) return null;
    if (/^(today|aujourd'?hui)$/.test(norm)) return startOfDay(new Date());
    if (/^(yesterday|hier)$/.test(norm)) {
      const d = startOfDay(new Date());
      d.setDate(d.getDate() - 1);
      return d;
    }
    const numbers = [...norm.matchAll(/\d{1,4}/g)].map((m) => parseInt(m[0], 10));
    const year = numbers.find((n) => n >= 1000);
    const day = numbers.find((n) => n >= 1 && n <= 31);
    let monthIndex = null;
    for (const key of Object.keys(MONTHS)) {
      if (new RegExp(`\\b${key}`).test(norm)) {
        monthIndex = MONTHS[key];
        break;
      }
    }
    if (monthIndex === null || day === undefined) return null;
    const now = new Date();
    const y = year !== undefined ? year : now.getFullYear();
    const guess = new Date(y, monthIndex, day);
    if (year === undefined && guess.getTime() > now.getTime() + 24 * 3600 * 1000) {
      guess.setFullYear(guess.getFullYear() - 1);
    }
    return guess;
  }

  // ---- React internals access (optional precision boost) -----------------------

  function getReactFiber(dom) {
    const key = Object.keys(dom).find(
      (k) => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$')
    );
    return key ? dom[key] : null;
  }

  function findMatrixEvent(tileEl) {
    let fiber = getReactFiber(tileEl);
    let depth = 0;
    while (fiber && depth < 60) {
      const props = fiber.memoizedProps;
      if (props) {
        const candidate = props.mxEvent || props.event;
        if (candidate && typeof candidate.getTs === 'function') return candidate;
      }
      fiber = fiber.return;
      depth++;
    }
    return null;
  }

  function htmlToText(html) {
    const tmp = document.createElement('div');
    tmp.innerHTML = html.replace(/<br\s*\/?>/gi, '\n');
    return tmp.textContent.trim();
  }

  function decorateByType(msgtype, text) {
    switch (msgtype) {
      case 'm.image':
        return `[image] ${text}`;
      case 'm.file':
        return `[file] ${text}`;
      case 'm.video':
        return `[video] ${text}`;
      case 'm.audio':
        return `[audio] ${text}`;
      case 'm.emote':
        return `* ${text}`;
      default:
        return text;
    }
  }

  function contentToText(content) {
    if (!content) return '';
    const msgtype = content.msgtype;
    if (content.format === 'org.matrix.custom.html' && content.formatted_body) {
      const text = htmlToText(content.formatted_body);
      if (text) return decorateByType(msgtype, text);
    }
    return decorateByType(msgtype, content.body || '');
  }

  // ---- DOM extraction -------------------------------------------------------------

  function firstOwn(tileEl, selector) {
    for (const el of tileEl.querySelectorAll(selector)) {
      if (!el.closest('.mx_ReplyChain')) return el;
    }
    return null;
  }

  function getTileText(tileEl) {
    const body = firstOwn(tileEl, '.mx_EventTile_body');
    if (body) return body.textContent.trim();
    const fileEl = firstOwn(tileEl, '.mx_MFileBody_info_filename');
    if (fileEl) return `[file] ${fileEl.textContent.trim()}`;
    const img = firstOwn(tileEl, '.mx_MImageBody img[alt]');
    if (img && img.alt) return `[image] ${img.alt}`;
    const redacted = firstOwn(tileEl, '.mx_RedactedBody');
    if (redacted) return '[message deleted]';
    return null;
  }

  // Element's "bubble" layout doesn't render any sender-name text for 1:1 DMs
  // (only left/right alignment), so a plain "last seen name" carried forward
  // across tiles breaks as soon as two people alternate with no name ever
  // shown. `data-self="true"/"false"` is present on every tile regardless, so
  // it's used as the primary signal for *who* sent a message, with a cache of
  // the last known display name/id seen for "me" vs. "the other side".
  function getTileSender(tileEl, ctx) {
    const self = tileEl.getAttribute('data-self') === 'true';
    const key = self ? 'self' : 'other';
    const nameEl = firstOwn(tileEl, '.mx_DisambiguatedProfile_displayName, .mx_SenderProfile_name');
    const avatarTitleEl = firstOwn(tileEl, '.mx_EventTile_avatar [title]');

    if (nameEl && nameEl.textContent.trim()) {
      const name = nameEl.textContent.trim();
      const id = avatarTitleEl ? avatarTitleEl.getAttribute('title') : name;
      ctx[key] = { name, id };
      return ctx[key];
    }
    if (avatarTitleEl) {
      const id = avatarTitleEl.getAttribute('title');
      const name = ctx[key] ? ctx[key].name : self ? 'Me' : ctx.roomName;
      ctx[key] = { name, id };
      return ctx[key];
    }
    if (ctx[key]) return ctx[key];
    const fallback = { name: self ? 'Me' : ctx.roomName, id: self ? 'me' : 'them' };
    ctx[key] = fallback;
    return fallback;
  }

  function extractTile(tileEl, dayBucket, ctx) {
    const sender = getTileSender(tileEl, ctx);
    const id = tileEl.getAttribute('data-event-id');
    if (!id) return null;

    let ts = null;
    let exact = false;
    let senderName = sender.name;
    let senderId = sender.id;
    let body = null;

    const mxEvent = findMatrixEvent(tileEl);
    if (mxEvent) {
      const type = typeof mxEvent.getType === 'function' ? mxEvent.getType() : null;
      if (!type || type === 'm.room.message' || type === 'm.sticker') {
        ts = mxEvent.getTs();
        exact = true;
        try {
          if (mxEvent.sender && mxEvent.sender.name) senderName = mxEvent.sender.name;
        } catch (e) {
          /* ignore */
        }
        if (typeof mxEvent.getSender === 'function') senderId = mxEvent.getSender();
        const content = typeof mxEvent.getContent === 'function' ? mxEvent.getContent() : null;
        if (content) body = contentToText(content);
      }
    }

    if (body === null) body = getTileText(tileEl);
    if (body === null) return null;

    if (ts === null) {
      if (!dayBucket) return null;
      ts = dayBucket.getTime() + 12 * 3600 * 1000;
    }

    return { id, ts, day: dayBucket ? dayBucket.getTime() : startOfDay(new Date(ts)).getTime(), exact, senderId, senderName, body };
  }

  function getMessageListEl() {
    return document.querySelector(SELECTORS.messageList);
  }

  // Full ordered pass over the currently loaded timeline. Returns both the
  // oldest day-separator seen (to know when to stop scrolling) and, when
  // `collect` is true, the ordered, extracted message records.
  function walkTimeline(collect) {
    const listEl = getMessageListEl();
    if (!listEl) return { minDay: null, records: [] };

    let currentDay = null;
    let minDay = null;
    const records = [];
    const ctx = { self: null, other: null, roomName: getRoomName() };

    for (const li of Array.from(listEl.children)) {
      const sep = li.querySelector(':scope > .mx_TimelineSeparator');
      if (sep) {
        const heading = sep.querySelector(SELECTORS.dateHeading);
        const parsed = heading && parseDaySeparatorText(heading.textContent);
        if (parsed) {
          currentDay = parsed;
          if (minDay === null || parsed.getTime() < minDay.getTime()) minDay = parsed;
        }
        continue;
      }
      if (li.classList.contains('mx_GenericEventListSummary')) {
        if (collect) {
          for (const nested of li.querySelectorAll('.mx_EventTile')) {
            const rec = extractTile(nested, currentDay, ctx);
            if (rec) records.push(rec);
          }
        }
        continue;
      }
      if (li.classList.contains('mx_EventTile')) {
        if (collect) {
          const rec = extractTile(li, currentDay, ctx);
          if (rec) records.push(rec);
        }
      }
    }

    return { minDay, records };
  }

  // ---- Scrolling / pagination ---------------------------------------------------

  function findScrollContainer() {
    const panel = document.querySelector(SELECTORS.scrollPanel);
    if (panel) return panel;

    const tile = document.querySelector(SELECTORS.eventTile);
    if (tile) {
      let node = tile.parentElement;
      while (node && node !== document.body) {
        const style = getComputedStyle(node);
        if (
          (style.overflowY === 'auto' || style.overflowY === 'scroll') &&
          node.scrollHeight > node.clientHeight
        ) {
          return node;
        }
        node = node.parentElement;
      }
    }
    return null;
  }

  function isVisible(el) {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function isAtRoomStart() {
    const spinner = document.querySelector(SELECTORS.spinner);
    if (isVisible(spinner)) return false;
    return !!document.querySelector(SELECTORS.topMarker);
  }

  function waitForMoreContent(scrollEl, prevHeight, timeout = 3500) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (val) => {
        if (done) return;
        done = true;
        obs.disconnect();
        clearTimeout(timer);
        resolve(val);
      };
      const obs = new MutationObserver(() => {
        if (scrollEl.scrollHeight !== prevHeight) finish(true);
      });
      obs.observe(scrollEl, { childList: true, subtree: true });
      const timer = setTimeout(() => finish(scrollEl.scrollHeight !== prevHeight), timeout);
    });
  }

  function getRoomName() {
    const el = document.querySelector(SELECTORS.roomName);
    return el && el.textContent.trim() ? el.textContent.trim() : 'conversation';
  }

  // ---- Export / download ---------------------------------------------------------

  function sanitizeFilename(name) {
    return name.replace(/[^a-z0-9_-]+/gi, '-').replace(/-+/g, '-').slice(0, 60);
  }

  function csvEscape(value) {
    const str = String(value ?? '');
    if (/[",\n]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
    return str;
  }

  function formatLocal(ts) {
    const d = new Date(ts);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(
      d.getMinutes()
    )}`;
  }

  function buildExport(results, format) {
    if (format === 'json') {
      return {
        content: JSON.stringify(
          results.map((r) => ({
            id: r.id,
            timestamp: new Date(r.ts).toISOString(),
            exact: r.exact,
            sender: r.senderName,
            senderId: r.senderId,
            message: r.body,
          })),
          null,
          2
        ),
        mime: 'application/json',
        ext: 'json',
      };
    }
    if (format === 'csv') {
      const rows = [['timestamp', 'sender', 'senderId', 'message']];
      results.forEach((r) => rows.push([new Date(r.ts).toISOString(), r.senderName, r.senderId, r.body]));
      return {
        content: rows.map((row) => row.map(csvEscape).join(',')).join('\n'),
        mime: 'text/csv',
        ext: 'csv',
      };
    }
    return {
      content: results.map((r) => `[${formatLocal(r.ts)}] ${r.senderName}: ${r.body}`).join('\n'),
      mime: 'text/plain',
      ext: 'txt',
    };
  }

  function downloadResults(results, format) {
    const { content, mime, ext } = buildExport(results, format);
    const startLabel = new Date(results[0].ts).toISOString().slice(0, 10);
    const endLabel = new Date(results[results.length - 1].ts).toISOString().slice(0, 10);
    const filename = `tchap-export_${sanitizeFilename(getRoomName())}_${startLabel}_to_${endLabel}.${ext}`;

    const blob = new Blob([content], { type: `${mime};charset=utf-8` });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  // ---- On-page status widget -------------------------------------------------------

  function showWidget(text) {
    if (!widgetEl) {
      widgetEl = document.createElement('div');
      widgetEl.style.cssText = `
        position: fixed; z-index: 2147483647; bottom: 16px; right: 16px;
        background: #1a1a1a; color: #fff; font: 13px/1.4 system-ui, sans-serif;
        padding: 10px 14px; border-radius: 8px; max-width: 320px;
        box-shadow: 0 4px 16px rgba(0,0,0,0.3); display: flex; align-items: center; gap: 10px;
      `;
      const label = document.createElement('span');
      label.className = 'tchap-export-label';
      const cancelBtn = document.createElement('button');
      cancelBtn.textContent = 'Cancel';
      cancelBtn.style.cssText =
        'background:#444;color:#fff;border:none;border-radius:4px;padding:4px 8px;cursor:pointer;flex-shrink:0;';
      cancelBtn.addEventListener('click', () => {
        cancelled = true;
      });
      widgetEl.appendChild(label);
      widgetEl.appendChild(cancelBtn);
      document.body.appendChild(widgetEl);
    }
    widgetEl.querySelector('.tchap-export-label').textContent = text;
    widgetEl.style.display = 'flex';
  }

  function updateWidget(text) {
    showWidget(text);
  }

  function hideWidget() {
    if (widgetEl) widgetEl.style.display = 'none';
  }

  // ---- Main extraction loop -----------------------------------------------------

  async function start(startTs, endTs, format) {
    if (running) return;
    running = true;
    cancelled = false;
    showWidget('Starting export…');

    try {
      const scrollEl = findScrollContainer();
      if (!scrollEl) {
        throw new Error('Could not find the Tchap conversation timeline. Open a conversation with messages visible.');
      }

      const startDayMs = startOfDay(new Date(startTs)).getTime();

      let reachedStart = false;
      let iterations = 0;
      const maxIterations = 800;
      const loopStart = Date.now();
      const maxDurationMs = 8 * 60 * 1000;

      while (!cancelled && !reachedStart && iterations < maxIterations && Date.now() - loopStart < maxDurationMs) {
        iterations++;

        const { minDay } = walkTimeline(false);
        const tileCount = document.querySelectorAll(SELECTORS.eventTile).length;
        updateWidget(`Loading history… ${tileCount} messages in view`);

        if (minDay && minDay.getTime() < startDayMs) {
          reachedStart = true;
          break;
        }
        if (isAtRoomStart()) {
          updateWidget('Reached the beginning of the conversation.');
          break;
        }

        const prevHeight = scrollEl.scrollHeight;
        scrollEl.scrollTop = 0;
        scrollEl.dispatchEvent(new Event('scroll', { bubbles: true }));
        const grew = await waitForMoreContent(scrollEl, prevHeight);
        if (!grew) {
          await sleep(600);
          if (scrollEl.scrollHeight === prevHeight) {
            updateWidget('No more history loaded — stopping.');
            break;
          }
        }
      }

      if (cancelled) {
        updateWidget('Export cancelled.');
        return;
      }

      updateWidget('Extracting messages…');
      const { records } = walkTimeline(true);
      const endDayMs = startOfDay(new Date(endTs)).getTime();
      const results = records.filter((r) => (r.exact ? r.ts >= startTs && r.ts <= endTs : r.day >= startDayMs && r.day <= endDayMs));

      if (results.length === 0) {
        updateWidget('No messages found in that date range.');
      } else {
        updateWidget(`Exporting ${results.length} messages…`);
        downloadResults(results, format);
        updateWidget(`Done — exported ${results.length} messages.`);
      }
    } catch (err) {
      console.error('[Tchap Exporter]', err);
      updateWidget(`Error: ${err.message}`);
    } finally {
      running = false;
      setTimeout(hideWidget, 6000);
    }
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'PING') {
      sendResponse({ ok: true, ready: !!findScrollContainer() || !!document.querySelector(SELECTORS.eventTile) });
      return true;
    }
    if (msg.type === 'START_EXTRACTION') {
      start(msg.startTs, msg.endTs, msg.format);
      sendResponse({ started: true });
      return true;
    }
    if (msg.type === 'CANCEL') {
      cancelled = true;
      sendResponse({ ok: true });
      return true;
    }
    return false;
  });
})();
