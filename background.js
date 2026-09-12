// @ts-check
/* global browser */

// Chrome 148+ ships a native, promise-based `browser` namespace matching
// Firefox's -- including runtime.onMessage listeners returning a Promise
// instead of the callback-based sendResponse()/return-true dance, which is
// exactly what relayDecision below depends on. Only Chrome needs this guard;
// Firefox has always had `browser` as a real global. Duplicated in decider.js
// -- these are two separate top-level script contexts with no shared module
// to hold one copy in.
if (typeof browser === "undefined") {
  globalThis.browser = chrome;
}

// background.js — Tab Decider
//
// Kept deliberately thin: this file only opens/focuses the decider tab and
// keeps the in-progress queue honest if a tab closes outside the extension.
// All decision logic (queue building, keep/throw, duplicate + domain checks)
// lives in decider.js, so there's exactly one code path for a decision
// regardless of what triggered it.
//
// State lives in browser.storage.session (queue, history, deciderTabId) so it
// is automatically wiped when the browser fully restarts — by design, per the
// "forget everything on restart" requirement. browser.storage.local is only
// used for durable user settings (includePinned, sortOrder).

const DECIDER_PATH = "decider.html";

function deciderUrl() {
  return browser.runtime.getURL(DECIDER_PATH);
}

async function findExistingDeciderTab() {
  const { deciderTabId } = await browser.storage.session.get("deciderTabId");
  if (deciderTabId == null) return null;
  try {
    const tab = await browser.tabs.get(deciderTabId);
    if (tab.url && tab.url.startsWith(deciderUrl())) return tab;
  } catch (e) {
    // Stale id — the tab was closed some other way. Fall through.
  }
  return null;
}

async function openOrFocusDecider() {
  const existing = await findExistingDeciderTab();
  if (existing) {
    await browser.tabs.update(existing.id, { active: true });
    await browser.windows.update(existing.windowId, { focused: true });
    return;
  }
  const tab = await browser.tabs.create({ url: deciderUrl() });
  await browser.storage.session.set({ deciderTabId: tab.id });
}

// Relays a keyboard-triggered Keep/Throw to decider.js (which owns the one
// real decide() implementation — no duplicating that logic here), waits for
// it to actually finish deciding + re-rendering, then brings the decider
// tab into focus so whatever happens next (e.g. a duplicate prompt, or the
// next card) is immediately visible. This is what lets you Peek at a tab,
// use the shortcut from there, and land back on the decider automatically.
//
// If there's no decider tab open at all, a shortcut isn't acting on
// anything visible — just open one instead of guessing at stale queue
// state from storage.
async function relayDecision(action) {
  const existing = await findExistingDeciderTab();
  if (!existing) {
    await openOrFocusDecider();
    return;
  }

  try {
    await browser.runtime.sendMessage({ type: "decide", action });
  } catch (err) {
    // decider.js's script context wasn't reachable (e.g. Firefox discarded
    // that tab under memory pressure). Focusing it below will reload it via
    // init(), and the user can just click the button once it's back.
  }

  await browser.tabs.update(existing.id, { active: true });
  await browser.windows.update(existing.windowId, { focused: true });
}

browser.action.onClicked.addListener(openOrFocusDecider);

browser.commands.onCommand.addListener((command) => {
  if (command === "decider-open") {
    openOrFocusDecider();
  } else if (command === "decider-keep") {
    relayDecision("keep");
  } else if (command === "decider-throw") {
    relayDecision("throw");
  }
});

// Removing a tab from the queue is a read-modify-write over the whole array,
// and onRemoved fires once per closed tab -- so closing a batch of duplicates
// (which decider.js does concurrently) used to run several of these at once,
// each reading the SAME queue and writing back a copy missing only its own
// tabId. Last write won and the rest of the batch was silently resurrected as
// dead entries that no later close could clear. Chaining makes each removal
// build on the previous one's result.
let queueWrite = Promise.resolve();

function serializeQueueWrite(fn) {
  queueWrite = queueWrite.catch(() => {}).then(fn);
  return queueWrite;
}

// Chaining only orders the writes made *here*. decider.js does its own
// read-modify-writes on the same queue (finalizeDecision, mergeNewTabs,
// undo, sibling bumps), and a page write that reads before one of ours and
// writes after it silently resurrects whatever we removed in between --
// which is exactly how "Throw all" could put its duplicates back. So the
// page takes this lock: acquiring it parks a pending entry on our chain, so
// our writes wait for the page and the page waits for ours.
//
// The lease is watchdogged. If the decider page navigates, is discarded, or
// throws while holding the lock, we release on our own rather than wedging
// every later onRemoved for the rest of the session.
const QUEUE_LOCK_TIMEOUT_MS = 5000;
let lockTimer = null;
let releaseHeldLock = null;

function releaseQueueLock() {
  if (lockTimer !== null) {
    clearTimeout(lockTimer);
    lockTimer = null;
  }
  if (releaseHeldLock) {
    const release = releaseHeldLock;
    releaseHeldLock = null;
    release();
  }
}

// Resolves once the lock is actually held -- i.e. once every queue write
// already queued ahead of it has finished.
function acquireQueueLock() {
  let granted;
  const acquired = new Promise((resolve) => { granted = resolve; });
  serializeQueueWrite(() => new Promise((release) => {
    releaseHeldLock = release;
    lockTimer = setTimeout(() => {
      console.warn("Tab Decider: queue lock timed out, releasing");
      releaseQueueLock();
    }, QUEUE_LOCK_TIMEOUT_MS);
    granted();
  }));
  return acquired;
}

// Same trust boundary decider.js applies to its own listener: only our own
// extension contexts get to hold the lock. Returning undefined for anything
// else leaves other listeners (decider.js handles "decide") free to answer.
browser.runtime.onMessage.addListener((message, sender) => {
  if (!sender || sender.id !== browser.runtime.id) return;
  if (!message || typeof message !== "object") return;
  if (message.type === "queue-lock") {
    return acquireQueueLock().then(() => ({ ok: true }));
  }
  if (message.type === "queue-unlock") {
    releaseQueueLock();
    return Promise.resolve({ ok: true });
  }
});

// If the user closes some other tab manually while a review session is
// open, drop it from the pending queue so it's never offered up as a
// decision. Also keeps `cursor` pointing at the same logical entry: since
// Phase 4 lets you skip around instead of always deciding on index 0,
// removing an entry that sat BEFORE the cursor would otherwise silently
// shift everything after it and skip one. A no-op if decider.js's own
// finalizeDecision already handled this same removal (idx === -1) -- the
// two can race for the Throw case, but both compute the same end state.
//
// Returning the serialized promise from the listener is what keeps this
// event page alive until the write actually lands.
browser.tabs.onRemoved.addListener((tabId) =>
  serializeQueueWrite(async () => {
    const { queue, cursor } = await browser.storage.session.get(["queue", "cursor"]);
    if (!queue || !queue.length) return;

    const idx = queue.findIndex((entry) => entry.tabId === tabId);
    if (idx === -1) return;

    const next = queue.filter((entry) => entry.tabId !== tabId);
    const pos = cursor || 0;
    const nextCursor = idx < pos ? Math.max(0, pos - 1) : pos;
    await browser.storage.session.set({ queue: next, cursor: nextCursor });
  })
);
