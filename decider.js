// decider.js — Tab Decider (Phase 4)
//
// Phase 1: queue + display. Phase 2: real Keep/Throw. Phase 3: duplicate
// detection (originally a post-decision confirm panel).
//
// Phase 4 (this pass) changes the model in two ways:
//
// 1. The queue is no longer strictly "decide index 0, remove it, repeat."
//    There's now a `cursor` (a plain index into `queue`) so you can move
//    around without deciding anything: Back/Skip by 1 or 10, or jump
//    straight to a numbered position. This is what makes "reviewed count"
//    and "jump to ~150" meaningful. Deciding Keep/Throw always acts on
//    whatever's at the cursor, then removes that entry -- entries BEFORE
//    the cursor that you skipped over are untouched and still sit in the
//    queue for whenever you move back to them.
//
//    Position is necessarily approximate across a browser restart (which
//    wipes all state by design -- see below): Peeking a tab bumps its
//    lastAccessed to "now", which reshuffles the oldest-first sort order
//    on the next rebuild. "Jump to 150" gets you in the neighborhood, not
//    to the exact tab you were on -- which is the known, accepted tradeoff.
//
// 2. Duplicate-URL info is now live and non-blocking: it's computed fresh
//    on every render of the current entry and shown right in view, with a
//    "Close selected" action available at any time -- not gated behind
//    making a Keep/Throw decision first, and no more separate confirm
//    panel that pauses the queue.
//
// Same-domain grouping ("N other tabs from x.com -- review these next")
// works the same way: computed against whatever's currently in `queue`
// (regardless of position relative to the cursor), reordering the array to
// move siblings to right after the current entry.
//
// State lives in browser.storage.session (queue, cursor, history,
// duplicatesClosedTotal, deciderTabId) so it's automatically wiped when the
// browser fully restarts -- by design, per "forget everything on restart."
// browser.storage.local only holds durable user settings (includePinned,
// sortOrder).

const els = {
  progress: document.getElementById("progress"),
  positionLabel: document.getElementById("position-label"),
  jumpInput: document.getElementById("jump-input"),
  jumpBtn: document.getElementById("jump-btn"),
  stepBack10: document.getElementById("step-back-10"),
  stepBack1: document.getElementById("step-back-1"),
  stepFwd1: document.getElementById("step-fwd-1"),
  stepFwd10: document.getElementById("step-fwd-10"),
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
  duplicateCloseBtn: document.getElementById("duplicate-close-btn"),
  domainBanner: document.getElementById("domain-banner"),
  domainBannerText: document.getElementById("domain-banner-text"),
  domainBumpBtn: document.getElementById("domain-bump-btn"),
};

// Transient, recomputed on every render -- not persisted. Just lets the
// "Close selected" button know which checkboxes are currently ticked.
let currentDuplicateMatches = [];

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

  // Deliberately NOT persisting favIconUrl in the queue -- some tabs carry
  // data: URI favicons tens of KB each, and storage.session has a 10MB
  // quota. Favicons are re-fetched live at render time instead.
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
      cursor: 0,
      duplicatesClosedTotal: 0,
      sessionActive: true,
    });
  } catch (err) {
    els.progress.textContent = `Couldn't save the queue: ${err.message}`;
    throw err;
  }
  return entries;
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

// Live, non-blocking: recomputed against currently-open tabs on every
// render of the current entry. Not tied to making a decision at all.
function renderDuplicates(entry, liveTabs) {
  if (!entry) {
    els.duplicatePanel.hidden = true;
    currentDuplicateMatches = [];
    return;
  }

  const matches = liveTabs
    .filter((t) => t.url === entry.url && t.id !== entry.tabId)
    .map((t) => ({
      tabId: t.id,
      title: t.title || t.url,
      sameWindow: t.windowId === entry.windowId,
      checked: true,
    }));

  currentDuplicateMatches = matches;

  if (matches.length === 0) {
    els.duplicatePanel.hidden = true;
    return;
  }

  els.duplicatePanel.hidden = false;
  els.duplicateSummary.textContent =
    `${matches.length} other open tab${matches.length === 1 ? "" : "s"} match this URL exactly.`;

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

// Also live and non-blocking: siblings are searched for across the whole
// pending queue, not just what's ahead of the cursor.
function renderDomainBanner(entry, entries) {
  if (!entry || !entry.domain) {
    els.domainBanner.hidden = true;
    return;
  }
  const siblingCount = entries.filter((e) => e.domain === entry.domain && e.tabId !== entry.tabId).length;
  if (siblingCount === 0) {
    els.domainBanner.hidden = true;
    return;
  }
  els.domainBanner.hidden = false;
  els.domainBannerText.textContent =
    `${siblingCount} other tab${siblingCount === 1 ? "" : "s"} from ${entry.domain} open.`;
}

async function render() {
  clearNotice();

  const { queue, cursor, history, duplicatesClosedTotal } = await browser.storage.session.get([
    "queue", "cursor", "history", "duplicatesClosedTotal",
  ]);
  const entries = queue || [];
  const rawCursor = cursor || 0;
  const pos = entries.length === 0 ? 0 : Math.max(0, Math.min(rawCursor, entries.length - 1));
  if (pos !== rawCursor) {
    await browser.storage.session.set({ cursor: pos }); // correct drift after external changes
  }

  const reviewedCount = (history || []).length;
  const dupCount = duplicatesClosedTotal || 0;
  els.progress.textContent =
    `${entries.length} tab${entries.length === 1 ? "" : "s"} in queue · ` +
    `${reviewedCount} reviewed` +
    (dupCount ? ` · ${dupCount} duplicate${dupCount === 1 ? "" : "s"} closed` : "") +
    ` this session`;

  els.positionLabel.textContent = entries.length ? `Viewing #${pos + 1} of ${entries.length}` : "Queue empty";
  els.jumpInput.value = "";

  const entry = entries[pos];
  const liveTabs = await browser.tabs.query({});
  const favIconById = new Map(liveTabs.map((t) => [t.id, t.favIconUrl || ""]));

  renderCurrentCard(entry, favIconById);
  renderDuplicates(entry, liveTabs);
  renderDomainBanner(entry, entries);

  const hasCurrent = !!entry;
  els.peekBtn.disabled = !hasCurrent;
  els.keepBtn.disabled = !hasCurrent;
  els.throwBtn.disabled = !hasCurrent;
  els.stepBack10.disabled = pos <= 0;
  els.stepBack1.disabled = pos <= 0;
  els.stepFwd1.disabled = !hasCurrent || pos >= entries.length - 1;
  els.stepFwd10.disabled = !hasCurrent || pos >= entries.length - 1;
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
  // of needless reload this tool is trying to avoid.
  const target = siblings.find((t) => !t.discarded) || siblings[0];
  await browser.tabs.update(target.id, { active: true });
  return true;
}

async function decide(action) {
  const { queue, cursor } = await browser.storage.session.get(["queue", "cursor"]);
  const entries = queue || [];
  const pos = cursor || 0;
  const entry = entries[pos];
  if (!entry) return;

  if (action === "keep") {
    const canDiscard = await ensureNotActiveInWindow(entry.tabId, entry.windowId);
    if (!canDiscard) {
      showNotice(
        `"${entry.title}" is the only tab in its window, so Firefox can't unload it ` +
        `without leaving that window empty. Open another tab into that window, or Throw this one instead.`
      );
      return; // leave it at the cursor rather than advancing
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

  await finalizeDecision(entry, action);
}

// Re-reads storage right before writing (rather than trusting the entry
// captured earlier) since background.js's tabs.onRemoved pruning can race
// with this for the Throw case. Both compute the same end state (entry
// gone, cursor adjusted the same way) so whichever writes last is fine.
async function finalizeDecision(entry, action) {
  const { queue, cursor, history } = await browser.storage.session.get(["queue", "cursor", "history"]);
  const entries = queue || [];
  const pos = cursor || 0;
  const idx = entries.findIndex((e) => e.tabId === entry.tabId);

  const nextQueue = idx === -1 ? entries : entries.filter((e) => e.tabId !== entry.tabId);
  const nextCursor = idx !== -1 && idx < pos ? Math.max(0, pos - 1) : pos;

  const historyEntry = { url: entry.url, title: entry.title, decision: action, decidedAt: Date.now() };

  await browser.storage.session.set({
    queue: nextQueue,
    cursor: nextCursor,
    history: [...(history || []), historyEntry],
  });
  await render();
}

async function closeDuplicates() {
  const toClose = currentDuplicateMatches.filter((m) => m.checked);
  if (toClose.length === 0) return;

  for (const m of toClose) {
    try {
      await browser.tabs.remove(m.tabId);
    } catch (err) {
      console.warn("Tab Decider: duplicate close failed", err);
    }
  }

  const { duplicatesClosedTotal } = await browser.storage.session.get("duplicatesClosedTotal");
  await browser.storage.session.set({ duplicatesClosedTotal: (duplicatesClosedTotal || 0) + toClose.length });

  await render();
  showNotice(`Closed ${toClose.length} duplicate tab${toClose.length === 1 ? "" : "s"}.`);
}

// Moves every other pending entry sharing the current tab's domain to
// right after the current position, wherever they currently sit in the
// queue (before or after the cursor).
async function bumpDomainSiblings() {
  const { queue, cursor } = await browser.storage.session.get(["queue", "cursor"]);
  const entries = (queue || []).slice();
  const pos = cursor || 0;
  const entry = entries[pos];
  if (!entry || !entry.domain) return;

  const siblingIndexes = [];
  entries.forEach((e, i) => {
    if (i !== pos && e.domain === entry.domain) siblingIndexes.push(i);
  });
  if (siblingIndexes.length === 0) return;

  // Remove from the end first so earlier removals don't shift indexes we
  // still need to pull out.
  const siblings = [];
  for (let i = siblingIndexes.length - 1; i >= 0; i--) {
    siblings.unshift(entries.splice(siblingIndexes[i], 1)[0]);
  }

  const removedBeforePos = siblingIndexes.filter((i) => i < pos).length;
  const newPos = pos - removedBeforePos;
  entries.splice(newPos + 1, 0, ...siblings);

  await browser.storage.session.set({ queue: entries, cursor: newPos });
  await render();
  showNotice(
    `Moved ${siblings.length} tab${siblings.length === 1 ? "" : "s"} from ${entry.domain} to review right after this one.`
  );
}

async function setCursor(newPos) {
  const { queue } = await browser.storage.session.get("queue");
  const entries = queue || [];
  const clamped = entries.length === 0 ? 0 : Math.max(0, Math.min(newPos, entries.length - 1));
  await browser.storage.session.set({ cursor: clamped });
  await render();
}

async function stepCursor(delta) {
  const { cursor } = await browser.storage.session.get("cursor");
  await setCursor((cursor || 0) + delta);
}

async function jumpToInput() {
  const raw = parseInt(els.jumpInput.value, 10);
  if (Number.isNaN(raw)) return;
  await setCursor(raw - 1); // input is shown/entered as 1-based
}

async function peekCurrent() {
  const { queue, cursor } = await browser.storage.session.get(["queue", "cursor"]);
  const entries = queue || [];
  const entry = entries[cursor || 0];
  if (!entry) return;

  try {
    await browser.tabs.update(entry.tabId, { active: true });
    await browser.windows.update(entry.windowId, { focused: true });
  } catch (err) {
    // Tab's gone -- background.js's onRemoved listener will prune it;
    // just re-render so the UI catches up.
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

  els.duplicateCloseBtn.addEventListener("click", closeDuplicates);
  els.domainBumpBtn.addEventListener("click", bumpDomainSiblings);

  els.stepBack10.addEventListener("click", () => stepCursor(-10));
  els.stepBack1.addEventListener("click", () => stepCursor(-1));
  els.stepFwd1.addEventListener("click", () => stepCursor(1));
  els.stepFwd10.addEventListener("click", () => stepCursor(10));
  els.jumpBtn.addEventListener("click", jumpToInput);
  els.jumpInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") jumpToInput();
  });
}

init();
