// Tchap Conversation Exporter - content script
//
// Tchap is a soft-fork of Element/matrix-react-sdk, so the DOM keeps the
// same `mx_*` class names. Rather than scraping visible, locale-dependent
// text, we walk the React fiber tree from each message tile to read the
// underlying MatrixEvent object directly (exact timestamp, sender, body),
// which is stable regardless of language, message grouping, or theme.
// A DOM-text fallback is used only if that lookup fails.

(() => {
  const SELECTORS = {
    eventTile: '.mx_EventTile',
    scrollPanel: '.mx_ScrollPanel',
    spinner: '.mx_Spinner',
    topMarker: '.mx_RoomWelcomeView, .mx_NewRoomIntro, .mx_RoomView_topUnreadBar',
    roomName: '.mx_RoomHeader_heading, .mx_RoomHeader_name',
    senderName: '.mx_DisambiguatedProfile_displayName, .mx_EventTile_senderDetails, .mx_EventTile_sender',
    body: '.mx_EventTile_body',
    timestamp: '.mx_MessageTimestamp',
  };

  let running = false;
  let cancelled = false;
  let widgetEl = null;

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // ---- React internals access -------------------------------------------------

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

  // ---- Message content decoding ------------------------------------------------

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

  // ---- Fallback: plain DOM scraping --------------------------------------------

  let lastKnownSender = { name: 'Unknown', id: 'unknown' };

  function extractFromDom(tileEl) {
    const senderEl = tileEl.querySelector(SELECTORS.senderName);
    const bodyEl = tileEl.querySelector(SELECTORS.body);
    const tsEl = tileEl.querySelector(SELECTORS.timestamp);
    if (!bodyEl) return null;

    if (senderEl && senderEl.textContent.trim()) {
      lastKnownSender = { name: senderEl.textContent.trim(), id: senderEl.textContent.trim() };
    }

    let ts = null;
    if (tsEl) {
      const title = tsEl.getAttribute('title') || '';
      const parsed = Date.parse(title);
      if (!Number.isNaN(parsed)) ts = parsed;
    }
    if (ts === null) return null; // without a reliable timestamp we can't place this message in range

    const id = tileEl.getAttribute('data-scroll-tokens') || `${ts}-${bodyEl.textContent.slice(0, 20)}`;

    return {
      id,
      ts,
      senderId: lastKnownSender.id,
      senderName: lastKnownSender.name,
      body: bodyEl.textContent.trim(),
      source: 'dom',
    };
  }

  function extractFromTile(tileEl) {
    const mxEvent = findMatrixEvent(tileEl);
    if (mxEvent) {
      const type = typeof mxEvent.getType === 'function' ? mxEvent.getType() : null;
      if (type !== 'm.room.message' && type !== 'm.sticker') return null;
      const content = typeof mxEvent.getContent === 'function' ? mxEvent.getContent() : {};
      let senderName = mxEvent.getSender ? mxEvent.getSender() : 'unknown';
      try {
        if (mxEvent.sender && mxEvent.sender.name) senderName = mxEvent.sender.name;
      } catch (e) {
        /* ignore */
      }
      return {
        id: mxEvent.getId ? mxEvent.getId() : `${mxEvent.getTs()}`,
        ts: mxEvent.getTs(),
        senderId: mxEvent.getSender ? mxEvent.getSender() : 'unknown',
        senderName,
        body: contentToText(content),
        source: 'fiber',
      };
    }
    return extractFromDom(tileEl);
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
    const collected = new Map();
    const processedNodes = new WeakSet();
    showWidget('Starting export…');

    try {
      const scrollEl = findScrollContainer();
      if (!scrollEl) {
        throw new Error('Could not find the Tchap conversation timeline. Open a conversation with messages visible.');
      }

      let reachedStart = false;
      let iterations = 0;
      const maxIterations = 800;
      const loopStart = Date.now();
      const maxDurationMs = 8 * 60 * 1000;

      while (!cancelled && !reachedStart && iterations < maxIterations && Date.now() - loopStart < maxDurationMs) {
        iterations++;

        const tiles = document.querySelectorAll(SELECTORS.eventTile);
        for (const tile of tiles) {
          if (processedNodes.has(tile)) continue;
          processedNodes.add(tile);
          const rec = extractFromTile(tile);
          if (!rec) continue;
          if (!collected.has(rec.id)) collected.set(rec.id, rec);
          if (rec.ts < startTs) reachedStart = true;
        }

        updateWidget(`Scanning… ${collected.size} messages found so far`);
        if (reachedStart) break;
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

      const results = Array.from(collected.values())
        .filter((r) => r.ts >= startTs && r.ts <= endTs)
        .sort((a, b) => a.ts - b.ts);

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
