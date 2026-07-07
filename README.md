# Tchap Conversation Exporter

A simple Chrome extension that exports the messages of a [Tchap](https://www.tchap.gouv.fr)
conversation you have open, restricted to a date range you choose.

Tchap is a soft-fork of Element/Matrix web client, so this extension targets its
`mx_*` DOM structure. Per-message timestamps aren't reliably present in the DOM
(Element only renders a timestamp on hover, and even then it's just "HH:MM" with
no date), so dates are read from the `.mx_DateSeparator` headings Element inserts
between days ("today", "yesterday", or a full date) — this gives day-level
accuracy for every message. Where possible, the extension also walks the React
fiber tree to read the tile's underlying `MatrixEvent` directly for an exact
millisecond timestamp and sender.

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
  timeline (`.mx_ScrollPanel`) and walks the message list (`ol.mx_RoomView_MessageList`)
  top to bottom, tracking the current day from each `.mx_DateSeparator` it passes.
- For each message tile (`.mx_EventTile`), it first tries to walk the React fiber
  tree to read the tile's underlying `MatrixEvent` directly (exact timestamp,
  sender, body). If that isn't available, it falls back to the tile's own
  `.mx_EventTile_body` text (explicitly excluding any quoted reply text) and the
  current day bucket for the date.
- It repeatedly scrolls to the top of the timeline to trigger Tchap's own
  history pagination until a day older than the requested start date is loaded
  (or there's no more history), then does one final pass to extract and filter
  messages.
- Only `m.room.message` and `m.sticker` events are included (no membership
  changes, reactions, or redactions).
- The extracted messages are exported as a local file download (no data leaves
  your browser).

## Limitations

- Only messages your browser can already decrypt (i.e. that you can see while
  viewing the room) are exported — this works like a personal export tool, not
  a bypass of any access control.
- Messages without an exact fiber-derived timestamp are filtered by *day*, not
  time-of-day — e.g. picking a start time of 6pm still includes that whole day's
  earlier messages if their precise timestamp couldn't be read.
- Encrypted media and files are exported as a placeholder plus their filename,
  not the actual file contents.
- Very long histories are capped at ~800 scroll iterations / 8 minutes as a
  safety net; adjust `maxIterations`/`maxDurationMs` in `content.js` if needed.
- If Tchap's markup changes significantly, update the selectors in the
  `SELECTORS` object at the top of `content.js`.
