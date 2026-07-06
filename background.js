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

browser.action.onClicked.addListener(openOrFocusDecider);

browser.commands.onCommand.addListener((command) => {
  if (command === "decider-open") openOrFocusDecider();
});

// If the user closes some other tab manually while a review session is open,
// drop it from the pending queue so it's never offered up as a decision.
browser.tabs.onRemoved.addListener(async (tabId) => {
  const { queue } = await browser.storage.session.get("queue");
  if (!queue || !queue.length) return;
  const next = queue.filter((entry) => entry.tabId !== tabId);
  if (next.length !== queue.length) {
    await browser.storage.session.set({ queue: next });
  }
});
