// decider.js — Tab Decider (Phase 3)
//
// Phase 1: queue building + display. Phase 2: real Keep/Throw actions.
// Phase 3 (this pass): exact-URL duplicate detection, wired in after EITHER
// Keep or Throw — an inline checklist appears before the queue advances.
// Same-domain grouping is still Phase 4.
//
// Also fixes two Phase 2 bugs found in testing:
//  1. Peek -> switch back -> Keep silently failed to unload. Firefox refuses
//     to discard a window's *active* tab, and switching focus back to the
//     decider's own window/tab does nothing to un-focus the peeked tab
//     *within its own window* if that window is a different one. Fixed by
//     ensureNotActiveInWindow(), which hands that window's active state to
//     a sibling tab first (invisibly, since that window isn't the one in
//     OS focus) so discard can actually succeed.
//  2. innerHTML-based rendering was tripping the extension page's default
//     CSP (script-src 'self') as a "blocked event handler" violation on
//     Keep/Throw. No literal onclick="" was present anywhere in this file
//     or decider.html, so the exact trigger is hard to pin down for
//     certain -- it may be Firefox's own about:debugging reload overlay
//     tripping the page's CSP, which would be cosmetic noise, not our bug.
//     Either way, this rewrite builds the card and duplicate list via
//     createElement/textContent instead of innerHTML, which removes any
//     possible inline-markup CSP surface entirely regardless of the exact
//     cause.
//
// "Forget decisions" rebuilds from scratch: read all currently-open tabs,
// ignore prior history, start clean. That's also exactly what happens
// automatically on a full browser restart, because queue/history/
// deciderTabId live in browser.storage.session, which the browser clears on
// its own. browser.storage.local is only used for durable user settings
// (includePinned, sortOrder).

const els = {
  progress: document.getElementById("progress"),
  currentCard: document.getElementById("current-card"),
  notice: document.getElementById("notice"),
  resetBtn: document.getElementById("reset-btn"),
  actionRow: document.getElementById("action-row"),
  peekBtn: document.getElementById("peek-btn"),
  keepBtn: document.getElementById("keep-btn"),
  throwBtn: document.getElementById("throw-btn"),
  duplicatePanel: document.getElementById("duplicate-panel"),
  duplicateSummary: document.getElementById("duplicate-summary"),
  duplicateList: document.getElementById("duplicate-list"),
  duplicateSkipBtn: document.getElementById("duplicate-skip-btn"),
  duplicateCloseBtn: document.getElementById("duplicate-close-btn"),
};

// Transient -- deliberately NOT persisted. If the decider page reloads mid
// duplicate-review, worst case the prompt is lost and the next render just
// shows the following queue item. Not worth persisting a few seconds of UI
// state across a page reload that shouldn't happen anyway.
let pendingDuplicateReview = null; // { entry, action, matches: [{tabId, title, sameWindow, checked}] }

function showNotice(message) {
  els.notice.textContent = message;
  els.notice.hidden = false;
}

function clearNotice() {
  els.notice.hidden = true;
  els.notice.textContent = "";
}

function computeDomain(url) {
  try {
    const u = new URL(url);
    if (!u.hostname) return null;
    return u.hostname.replace(/^www\./, "");
  } catch {
    return null; // about:, file:, moz-extension:, etc. -- no meaningful domain
  }
}

function formatRelativeTime(ms) {
  if (!ms) return "unknown";
  const diff = Date.now() - ms;
  if (diff < 0) return "just now";
  const minute = 60 * 1000, hour = 60 * minute, day = 24 * hour, month = 30 * day;
  if (diff < minute) return "just now";
  if (diff < hour) return `${Math.round(diff / minute)}m ago`;
  if (diff < day) return `${Math.round(diff / hour)}h ago`;
  if (diff < month) return `${Math.round(diff / day)}d ago`;
  const months = Math.round(diff / month);
  if (months < 12) return `${months}mo ago`;
  return `${Math.round(months / 12)}y ago`;
}

async function getSettings() {
  const { settings } = await browser.storage.local.get("settings");
  return Object.assign({ includePinned: false, sortOrder: "lru" }, settings);
}

async function buildQueue(selfTabId) {
  const settings = await getSettings();
  const tabs = await browser.tabs.query({});

  // Deliberately NOT persisting favIconUrl: some tabs carry data: URI
  // favicons that can run tens of KB each, and storage.session has a hard
  // 10MB quota. Favicons are cheap to re-fetch live at render time from a
  // single tabs.query() instead, so the persisted queue stays tiny text.
  const entries = tabs
    .filter((t) => t.id !== selfTabId)
    .filter((t) => settings.includePinned || !t.pinned)
    .map((t) => ({
      tabId: t.id,
      windowId: t.windowId,
      url: t.url,
      title: t.title || t.url,
      domain: computeDomain(t.url),
      pinned: !!t.pinned,
      discarded: !!t.discarded,
      lastAccessed: t.lastAccessed || 0,
    }));

  if (settings.sortOrder === "lru") {
    entries.sort((a, b) => a.lastAccessed - b.lastAccessed);
  }

  try {
    await browser.storage.session.set({
      queue: entries,
      history: [],
      sessionActive: true,
    });
  } catch (err) {
    els.progress.textContent = `Couldn't save the queue: ${err.message}`;
    throw err;
  }
  pendingDuplicateReview = null;
  return entries;
}

async function getFaviconMap() {
  const liveTabs = await browser.tabs.query({});
  return new Map(liveTabs.map((t) => [t.id, t.favIconUrl || ""]));
}

function makeBadge(text, extraClass) {
  const span = document.createElement("span");
  span.className = extraClass ? `badge ${extraClass}` : "badge";
  span.textContent = text;
  return span;
}

function renderCurrentCard(entry, favIconById) {
  els.currentCard.textContent = ""; // clear -- safe, no markup parsing involved

  if (!entry) {
    const p = document.createElement("p");
    p.className = "empty";
    p.textContent = "Queue is empty. Nice and tidy.";
    els.currentCard.appendChild(p);
    return;
  }

  const card = document.createElement("div");
  card.className = "card";

  const img = document.createElement("img");
  img.className = "favicon";
  img.alt = "";
  img.width = 20;
  img.height = 20;
  const favIconUrl = favIconById.get(entry.tabId) || "";
  if (favIconUrl) {
    img.addEventListener("error", () => { img.style.visibility = "hidden"; });
    img.src = favIconUrl;
  } else {
    img.style.visibility = "hidden";
  }
  card.appendChild(img);

  const textWrap = document.createElement("div");
  textWrap.className = "card-text";

  const title = document.createElement("div");
  title.className = "card-title";
  title.textContent = entry.title;
  textWrap.appendChild(title);

  const url = document.createElement("div");
  url.className = "card-url";
  url.textContent = entry.url;
  textWrap.appendChild(url);

  const meta = document.createElement("div");
  meta.className = "card-meta";
  meta.textContent = `Last viewed ${formatRelativeTime(entry.lastAccessed)}`;
  textWrap.appendChild(meta);

  const badges = document.createElement("div");
  badges.className = "card-badges";
  if (entry.domain) badges.appendChild(makeBadge(entry.domain));
  if (entry.pinned) badges.appendChild(makeBadge("pinned", "badge-pinned"));
  if (entry.discarded) badges.appendChild(makeBadge("already unloaded", "badge-discarded"));
  textWrap.appendChild(badges);

  card.appendChild(textWrap);
  els.currentCard.appendChild(card);
}

function renderDuplicatePanel() {
  els.currentCard.hidden = true;
  els.actionRow.hidden = true;
  els.duplicatePanel.hidden = false;

  const { matches } = pendingDuplicateReview;
  els.duplicateSummary.textContent =
    `${matches.length} other open tab${matches.length === 1 ? "" : "s"} ` +
    `match this URL exactly -- close ${matches.length === 1 ? "it" : "them"} too?`;

  els.duplicateList.textContent = "";
  for (const m of matches) {
    const li = document.createElement("li");
    const label = document.createElement("label");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = m.checked;
    checkbox.addEventListener("change", () => { m.checked = checkbox.checked; });
    const text = document.createElement("span");
    text.textContent = m.sameWindow ? m.title : `${m.title} (another window)`;
    label.appendChild(checkbox);
    label.appendChild(text);
    li.appendChild(label);
    els.duplicateList.appendChild(li);
  }
}

async function render() {
  clearNotice();

  if (pendingDuplicateReview) {
    renderDuplicatePanel();
    return;
  }

  els.duplicatePanel.hidden = true;
  els.currentCard.hidden = false;
  els.actionRow.hidden = false;

  const { queue } = await browser.storage.session.get("queue");
  const entries = queue || [];
  const favIconById = await getFaviconMap();
  els.progress.textContent = `${entries.length} tab${entries.length === 1 ? "" : "s"} in queue`;
  renderCurrentCard(entries[0], favIconById);

  const hasCurrent = entries.length > 0;
  els.peekBtn.disabled = !hasCurrent;
  els.keepBtn.disabled = !hasCurrent;
  els.throwBtn.disabled = !hasCurrent;
}

// Firefox refuses to discard a window's *active* tab (the promise just
// resolves without discarding -- no error). If our target is active in its
// own window -- most commonly because it was just Peeked -- hand that
// window's active state to a sibling tab first. This only ever touches a
// window that ISN'T the one currently in OS focus (ours is, since the user
// had to click a button on the decider page to get here), so it's invisible
// to the user. Returns false only when the tab is the sole tab in its
// window, where there's genuinely nothing to switch to.
async function ensureNotActiveInWindow(tabId, windowId) {
  let tab;
  try {
    tab = await browser.tabs.get(tabId);
  } catch {
    return true; // tab's already gone -- nothing to fix
  }
  if (!tab.active) return true;

  const siblings = await browser.tabs.query({ windowId, active: false });
  if (siblings.length === 0) return false;

  // Prefer a sibling that's already loaded. Picking a discarded one would
  // force Firefox to reload it just to make it "active" -- exactly the kind
  // of needless reload this whole tool is trying to avoid.
  const target = siblings.find((t) => !t.discarded) || siblings[0];
  await browser.tabs.update(target.id, { active: true });
  return true;
}

async function checkForDuplicates(entry, action) {
  const liveTabs = await browser.tabs.query({});
  const matches = liveTabs
    .filter((t) => t.url === entry.url && t.id !== entry.tabId)
    .map((t) => ({
      tabId: t.id,
      title: t.title || t.url,
      sameWindow: t.windowId === entry.windowId,
      checked: true,
    }));

  if (matches.length === 0) {
    await finalizeDecision(entry, action, 0);
    return;
  }

  pendingDuplicateReview = { entry, action, matches };
  await render();
}

// Re-reads storage right before writing (rather than trusting variables
// captured back when the decision started) because the duplicate-review
// pause can take a while, during which background.js's tabs.onRemoved
// pruning -- or another decision -- may have already changed things.
async function finalizeDecision(entry, action, duplicatesClosed) {
  const { queue, history } = await browser.storage.session.get(["queue", "history"]);
  const currentQueue = queue || [];
  const currentHistory = history || [];

  // Throw already removes this entry via background.js's onRemoved
  // listener; Keep needs it dropped explicitly since the tab is still open,
  // just unloaded. Filtering by id (not slicing index 0) is safe either way.
  const nextQueue = currentQueue.filter((e) => e.tabId !== entry.tabId);

  const historyEntry = {
    url: entry.url,
    title: entry.title,
    decision: action,
    duplicatesClosed,
    decidedAt: Date.now(),
  };

  await browser.storage.session.set({
    queue: nextQueue,
    history: [...currentHistory, historyEntry],
  });

  pendingDuplicateReview = null;
  await render();
}

async function decide(action) {
  const { queue } = await browser.storage.session.get("queue");
  const currentQueue = queue || [];
  const entry = currentQueue[0];
  if (!entry) return;

  if (action === "keep") {
    const canDiscard = await ensureNotActiveInWindow(entry.tabId, entry.windowId);
    if (!canDiscard) {
      showNotice(
        `"${entry.title}" is the only tab in its window, so Firefox can't unload it ` +
        `without leaving that window empty. Open another tab into that window, or Throw this one instead.`
      );
      return; // leave it at the head of the queue rather than advancing
    }
    try {
      await browser.tabs.discard(entry.tabId);
      const updated = await browser.tabs.get(entry.tabId);
      if (!updated.discarded) {
        showNotice(`Firefox declined to unload "${entry.title}" -- try again, or Throw it instead.`);
        return;
      }
    } catch (err) {
      console.warn("Tab Decider: keep failed", err);
      // Tab was probably already closed outside the extension -- fall
      // through and advance past it rather than getting stuck.
    }
  } else if (action === "throw") {
    try {
      await browser.tabs.remove(entry.tabId);
    } catch (err) {
      console.warn("Tab Decider: throw failed", err);
    }
  }

  await checkForDuplicates(entry, action);
}

async function confirmDuplicates() {
  if (!pendingDuplicateReview) return;
  const { entry, action, matches } = pendingDuplicateReview;
  const toClose = matches.filter((m) => m.checked);
  for (const m of toClose) {
    try {
      await browser.tabs.remove(m.tabId);
    } catch (err) {
      console.warn("Tab Decider: duplicate close failed", err);
    }
  }
  await finalizeDecision(entry, action, toClose.length);
}

async function skipDuplicates() {
  if (!pendingDuplicateReview) return;
  const { entry, action } = pendingDuplicateReview;
  await finalizeDecision(entry, action, 0);
}

async function peekCurrent() {
  const { queue } = await browser.storage.session.get("queue");
  const entries = queue || [];
  const entry = entries[0];
  if (!entry) return;

  try {
    await browser.tabs.update(entry.tabId, { active: true });
    await browser.windows.update(entry.windowId, { focused: true });
  } catch (err) {
    // Tab's gone -- drop it rather than leaving the queue stuck on it.
    await browser.storage.session.set({ queue: entries.slice(1) });
    await render();
  }
}

async function init() {
  const selfTab = await browser.tabs.getCurrent();
  await browser.storage.session.set({ deciderTabId: selfTab.id });

  const { sessionActive } = await browser.storage.session.get("sessionActive");
  if (!sessionActive) {
    await buildQueue(selfTab.id);
  }
  await render();

  els.resetBtn.addEventListener("click", async () => {
    els.progress.textContent = "Rebuilding...";
    await buildQueue(selfTab.id);
    await render();
  });

  els.peekBtn.addEventListener("click", peekCurrent);
  els.keepBtn.addEventListener("click", () => decide("keep"));
  els.throwBtn.addEventListener("click", () => decide("throw"));
  els.duplicateSkipBtn.addEventListener("click", skipDuplicates);
  els.duplicateCloseBtn.addEventListener("click", confirmDuplicates);
}

init();
