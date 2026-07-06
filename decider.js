// decider.js — Tab Decider (Phase 1)
//
// Scope for this phase: build the review queue from every open tab (minus
// this page and pinned tabs) and display it. No Keep/Throw actions yet —
// this phase is just proving that we can read tab data correctly and that
// the storage-backed queue survives a page reload.
//
// "Forget decisions" is already wired up here since it's the same operation
// as building the queue for the first time: read all currently-open tabs,
// ignore any prior history, start clean. That's also exactly what happens
// automatically on a full browser restart, because queue/history/deciderTabId
// live in browser.storage.session, which the browser clears on its own.

const els = {
  progress: document.getElementById("progress"),
  currentCard: document.getElementById("current-card"),
  queueBody: document.getElementById("queue-body"),
  resetBtn: document.getElementById("reset-btn"),
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

function formatLastAccessed(ms) {
  if (!ms) return "—";
  const diffMin = Math.round((Date.now() - ms) / 60000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  return `${Math.round(diffHr / 24)}d ago`;
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

  const entries = tabs
    .filter((t) => t.id !== selfTabId)
    .filter((t) => settings.includePinned || !t.pinned)
    .map((t) => ({
      tabId: t.id,
      windowId: t.windowId,
      url: t.url,
      title: t.title || t.url,
      favIconUrl: t.favIconUrl || "",
      domain: computeDomain(t.url),
      pinned: !!t.pinned,
      discarded: !!t.discarded,
      lastAccessed: t.lastAccessed || 0,
    }));

  if (settings.sortOrder === "lru") {
    entries.sort((a, b) => a.lastAccessed - b.lastAccessed);
  }

  await browser.storage.session.set({
    queue: entries,
    history: [],
    sessionActive: true,
  });
  return entries;
}

function renderCurrentCard(entry) {
  if (!entry) {
    els.currentCard.innerHTML = `<p class="empty">Queue is empty. Nice and tidy.</p>`;
    return;
  }
  els.currentCard.innerHTML = `
    <div class="card">
      <img class="favicon" src="${escapeHtml(entry.favIconUrl)}" alt="" width="20" height="20"
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

function renderDebugTable(entries) {
  els.queueBody.innerHTML = entries
    .map(
      (e) => `
      <tr>
        <td>${escapeHtml(e.title)}</td>
        <td class="mono">${escapeHtml(e.url)}</td>
        <td>${escapeHtml(e.domain || "—")}</td>
        <td>${e.pinned ? "yes" : ""}</td>
        <td>${formatLastAccessed(e.lastAccessed)}</td>
      </tr>`
    )
    .join("");
}

async function render() {
  const { queue } = await browser.storage.session.get("queue");
  const entries = queue || [];
  els.progress.textContent = `${entries.length} tab${entries.length === 1 ? "" : "s"} in queue`;
  renderCurrentCard(entries[0]);
  renderDebugTable(entries);
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
}

init();
