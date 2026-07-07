const form = document.getElementById('form');
const statusEl = document.getElementById('status');
const startInput = document.getElementById('start');
const endInput = document.getElementById('end');

function toLocalInputValue(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(
    date.getMinutes()
  )}`;
}

const now = new Date();
const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
endInput.value = toLocalInputValue(now);
startInput.value = toLocalInputValue(yesterday);

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  statusEl.textContent = '';

  const tab = await getActiveTab();
  if (!tab || !tab.url || !/tchap\.gouv\.fr/.test(tab.url)) {
    statusEl.textContent = 'Open a Tchap conversation tab first.';
    return;
  }

  const startTs = new Date(startInput.value).getTime();
  const endTs = new Date(endInput.value).getTime();
  if (Number.isNaN(startTs) || Number.isNaN(endTs) || startTs >= endTs) {
    statusEl.textContent = 'Please choose a valid date range (start before end).';
    return;
  }

  const format = document.querySelector('input[name="format"]:checked').value;

  chrome.tabs.sendMessage(tab.id, { type: 'PING' }, (resp) => {
    if (chrome.runtime.lastError || !resp || !resp.ready) {
      statusEl.textContent = 'Open a Tchap conversation with messages visible, then try again.';
      return;
    }
    chrome.tabs.sendMessage(tab.id, { type: 'START_EXTRACTION', startTs, endTs, format });
    statusEl.textContent =
      'Export started — watch the status badge on the page. You can close this popup; the download starts automatically when done.';
  });
});
