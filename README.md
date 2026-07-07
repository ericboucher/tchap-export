# Tchap Conversation Exporter

A simple Chrome extension that exports the messages of a [Tchap](https://www.tchap.gouv.fr)
conversation you have open, restricted to a date range you choose.

Tchap is a soft-fork of Element/Matrix web client, so this extension targets its
`mx_*` DOM structure. It reads message data from the app's React component tree
(sender, timestamp, message body) rather than scraping displayed, locale-dependent
text, so it stays accurate regardless of grouped messages or date/time formatting.
If that lookup ever fails (e.g. after a Tchap UI update), it falls back to
scraping the visible DOM text.

## Install (unpacked, for development/personal use)

1. Open `chrome://extensions`.
2. Enable **Developer mode** (top right).
3. Click **Load unpacked** and select the `extension/` folder in this repo.
4. Pin the extension if you'd like quick access to its icon.

## Usage

1. Open `https://www.tchap.gouv.fr` and navigate to the conversation you want to export.
2. Click the extension icon.
3. Choose a **From** and **To** date/time, and an output format (Text, CSV, or JSON).
4. Click **Extract & download**.

The extension will automatically scroll the conversation upward to load older
history until it reaches the start of your date range (or the beginning of the
conversation), then it triggers a file download with the matching messages.
A small status badge appears in the bottom-right corner of the page while this
runs — you can cancel from there, and you can safely close the popup once the
export has started.

## How it works

- The content script (`extension/content.js`) locates the scrollable message
  timeline (`.mx_ScrollPanel`) and each message tile (`.mx_EventTile`).
- For each tile, it walks the React fiber tree to find the tile's underlying
  `MatrixEvent` object and reads `getTs()`, `getSender()`, and `getContent()`
  directly — giving an exact millisecond timestamp and full message body
  regardless of UI language or message grouping.
- It repeatedly scrolls to the top of the timeline to trigger Tchap's own
  history pagination, collecting newly rendered tiles after each load, until
  the requested start date is reached (or there's no more history).
- Only `m.room.message` and `m.sticker` events are included (no membership
  changes, reactions, or redactions).
- The collected, deduplicated, and sorted messages are exported as a local
  file download (no data leaves your browser).

## Limitations

- Only messages your browser can already decrypt (i.e. that you can see while
  viewing the room) are exported — this works like a personal export tool, not
  a bypass of any access control.
- Encrypted media, files, and images are exported as a placeholder plus their
  filename, not the actual file contents.
- Very long histories are capped at ~800 scroll iterations / 8 minutes as a
  safety net; adjust `maxIterations`/`maxDurationMs` in `content.js` if needed.
- If Tchap's markup changes significantly, update the selectors in the
  `SELECTORS` object at the top of `content.js`.
