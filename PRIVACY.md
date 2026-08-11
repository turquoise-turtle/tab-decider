# Privacy Policy

**Tab Decider** does not collect, transmit, or store any personal data.

## What it reads

To build and display the review queue, the extension reads metadata about your
open tabs: URL, title, favicon, last accessed time, and pinned and discarded
state.

To support the undo feature, it also reads Firefox's list of recently closed
tabs, so a tab you close by mistake can be reopened. This list is provided by
Firefox itself and is only read when undo is used.

## What it stores

Both storage areas are local to your device.

- `browser.storage.session` holds the active review queue, your position in it,
  and this session's decisions. Firefox wipes this automatically when the browser
  restarts, which is intentional.
- `browser.storage.local` holds your two preferences: sort order and whether
  pinned tabs are included. This is removed when you uninstall the extension.

---

*Last updated: August 2026*