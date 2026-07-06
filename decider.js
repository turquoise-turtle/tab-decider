// decider.js — Tab Decider (Phase 2)
//
// Adds real Keep/Throw actions on top of Phase 1's queue-building: Keep
// discards the tab (unloads it, stays open), Throw closes it. Either way the
// decision is logged to history and the queue advances. Peek jumps focus to
// the tab under review without deciding anything.
//
// Duplicate-URL and same-domain checks are NOT wired up yet — that's Phase 3
// and Phase 4. `duplicatesClosed` is hardcoded to 0 in the history entry
// until then.
//
// "Forget decisions" rebuilds from scratch: read all currently-open tabs,
// ignore prior history, start clean. That's also exactly what happens
// automatically on a full browser restart, because queue/history/deciderTabId
// live in browser.storage.session, which the browser clears on its own.

const els = {
  progress: document.getElementById("progress"),
  currentCard: document.getElementById("current-card"),
  resetBtn: document.getElementById("reset-btn"),
  peekBtn: document.getElementById("peek-btn"),
  keepBtn: document.getElementById("keep-btn"),
  throwBtn: document.getElementById("throw-btn"),
};

function computeDomain(url) {
  try {
    const u = new URL(url);
    if (!u.hostname) return null;
    return u.hostname.replace(/^www\./, "");
  } catch {
    return null; // about:, file:, moz-extension:, etc. — no meaningful domain
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
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
  return entries;
}

async function getFaviconMap() {
  const liveTabs = await browser.tabs.query({});
  return new Map(liveTabs.map((t) => [t.id, t.favIconUrl || ""]));
}

function renderCurrentCard(entry, favIconById) {
  if (!entry) {
    els.currentCard.innerHTML = `<p class="empty">Queue is empty. Nice and tidy.</p>`;
    return;
  }
  const favIconUrl = favIconById.get(entry.tabId) || "";
  els.currentCard.innerHTML = `
    <div class="card">
      <img class="favicon" src="${escapeHtml(favIconUrl)}" alt="" width="20" height="20"
           onerror="this.style.visibility='hidden'" />
      <div class="card-text">
        <div class="card-title">${escapeHtml(entry.title)}</div>
        <div class="card-url">${escapeHtml(entry.url)}</div>
        <div class="card-badges">
          ${entry.domain ? `<span class="badge">${escapeHtml(entry.domain)}</span>` : ""}
          ${entry.pinned ? `<span class="badge badge-pinned">pinned</span>` : ""}
          ${entry.discarded ? `<span class="badge badge-discarded">already unloaded</span>` : ""}
        </div>
      </div>
    </div>
  `;
}

async function render() {
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

// Re-reads storage right before acting (rather than trusting a JS variable
// from the last render) so we're always acting on the true current head —
// background.js's tabs.onRemoved pruning could have changed things since.
async function decide(action) {
  const { queue, history } = await browser.storage.session.get(["queue", "history"]);
  const currentQueue = queue || [];
  const currentHistory = history || [];
  const entry = currentQueue[0];
  if (!entry) return;

  try {
    if (action === "keep") {
      await browser.tabs.discard(entry.tabId);
    } else if (action === "throw") {
      await browser.tabs.remove(entry.tabId);
    }
  } catch (err) {
    // Tab was probably already closed outside the extension — that's fine,
    // just move on rather than getting stuck on a dead entry.
    console.warn(`Tab Decider: ${action} failed for tab ${entry.tabId}`, err);
  }

  const historyEntry = {
    url: entry.url,
    title: entry.title,
    decision: action,
    duplicatesClosed: 0, // wired up in Phase 3
    decidedAt: Date.now(),
  };

  await browser.storage.session.set({
    queue: currentQueue.slice(1),
    history: [...currentHistory, historyEntry],
  });

  await render();
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
    // Tab's gone — drop it rather than leaving the queue stuck on it.
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
    els.progress.textContent = "Rebuilding…";
    await buildQueue(selfTab.id);
    await render();
  });

  els.peekBtn.addEventListener("click", peekCurrent);
  els.keepBtn.addEventListener("click", () => decide("keep"));
  els.throwBtn.addEventListener("click", () => decide("throw"));
}

init();
