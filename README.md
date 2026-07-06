# Tab Decider

[![Human in the Loop](https://madebyhuman.iamjarl.com/badges/loop-white.svg)](https://madebyhuman.iamjarl.com)
[![Firefox Addon](https://img.shields.io/amo/v/tab-decider.svg?style=flat-square)](https://addons.mozilla.org/en-US/firefox/addon/tab-decider/)

> Step through your open tabs one at a time — **keep** (unload) or **throw** (close).

## Features

- **One tab at a time** — work through your open tabs without overwhelm, sorted oldest-viewed-first by default
- **Keep or Throw** — unload tabs to free memory, or close ones you no longer need
- **Peek** — jump to the tab to take a closer look, then use a keyboard shortcut to decide without leaving it
- **Keyboard shortcuts** — use from anywhere in the browser, including while Peeking

  | Action | Shortcut |
  |---|---|
  | Open / focus Tab Decider | <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>D</kbd> |
  | Keep current tab | <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>K</kbd> |
  | Throw current tab | <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>T</kbd> |

- **Duplicate detection** — live, non-blocking panel shows exact URL matches; close selected or throw all at once
- **Domain grouping** — banner surfaces other open tabs from the same domain and lets you pull them up next
- **Free navigation** — step back/forward by 1 or 10, or jump straight to any position in the queue
- **Settings** — optionally include pinned tabs; choose between oldest-viewed-first or tab order
- **Session-scoped state** — queue and history are automatically forgotten on browser restart, by design
- **Dark mode** — follows system appearance

## Installation

<!-- Update this link once published to AMO -->
Install from the https://addons.mozilla.org/en-US/firefox/addon/tab-decider/.

## Usage

1. Click the **Tab Decider** toolbar icon, or press <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>D</kbd>.
2. The decider opens with your least-recently-used tab first.
3. **Peek** at the tab if you need a closer look — then use <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>K</kbd>/<kbd>T</kbd> to decide from there, and you'll land back on the decider automatically.
4. Or just click **Keep** (unloads it) or **Throw** (closes it) directly.
5. Use the navigation controls to skip around the queue freely — you don't have to decide in order.
6. Hit **Forget decisions** at any time to rebuild the queue from scratch.

## Permissions

| Permission | Reason |
|---|---|
| `tabs` | Read tab metadata — URL, title, last accessed time, pinned and discarded state |
| `storage` | Persist the review queue, cursor position, and user settings |

## Development

```text
tab-decider/
├── manifest.json
├── background.js   # Toolbar action, keyboard shortcuts, queue integrity on external tab close
├── decider.html    # Decider UI
├── decider.js      # Queue building, keep/throw/peek, duplicate + domain logic, rendering
├── decider.css     # Styles (light + dark mode)
└── icons/
    ├── icon-48.png
    └── icon-96.png
```

## License

MIT