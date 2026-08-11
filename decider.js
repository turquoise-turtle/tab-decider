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
  settingsToggleBtn: document.getElementById("settings-toggle-btn"),
  settingsPanel: document.getElementById("settings-panel"),
  settingIncludePinned: document.getElementById("setting-include-pinned"),
  settingSortOrder: document.getElementById("setting-sort-order"),
  shortcutsList: document.getElementById("shortcuts-list"),
  positionLabel: document.getElementById("position-label"),
  jumpInput: document.getElementById("jump-input"),
  jumpBtn: document.getElementById("jump-btn"),
  stepBack10: document.getElementById("step-back-10"),
  stepBack1: document.getElementById("step-back-1"),
  stepFwd1: document.getElementById("step-fwd-1"),
  stepFwd10: document.getElementById("step-fwd-10"),
  currentCard: document.getElementById("current-card"),
  notice: document.getElementById("notice"),
  noticeText: document.getElementById("notice-text"),
  noticeUndoBtn: document.getElementById("notice-undo-btn"),
  resetBtn: document.getElementById("reset-btn"),
  actionRow: document.getElementById("action-row"),
  peekBtn: document.getElementById("peek-btn"),
  keepBtn: document.getElementById("keep-btn"),
  throwBtn: document.getElementById("throw-btn"),
  duplicatePanel: document.getElementById("duplicate-panel"),
  duplicateSummary: document.getElementById("duplicate-summary"),
  duplicateList: document.getElementById("duplicate-list"),
  duplicateCloseBtn: document.getElementById("duplicate-close-btn"),
  duplicateThrowAllBtn: document.getElementById("duplicate-throw-all-btn"),
  domainBanner: document.getElementById("domain-banner"),
  domainBannerText: document.getElementById("domain-banner-text"),
  domainBumpBtn: document.getElementById("domain-bump-btn"),
  repoBanner: document.getElementById("repo-banner"),
  repoBannerText: document.getElementById("repo-banner-text"),
  repoBumpBtn: document.getElementById("repo-bump-btn"),
  summaryCard: document.getElementById("summary-card"),
  summaryKept: document.getElementById("summary-kept"),
  summaryThrown: document.getElementById("summary-thrown"),
  summaryDuplicates: document.getElementById("summary-duplicates"),
  summaryRestartBtn: document.getElementById("summary-restart-btn"),
};

// Transient, recomputed on every render -- not persisted. Just lets the
// "Close selected" button know which checkboxes are currently ticked.
let currentDuplicateMatches = [];

function showNotice(message, undoAvailable = false) {
  els.noticeText.textContent = message;
  els.notice.hidden = false;
  els.noticeUndoBtn.hidden = !undoAvailable;
}

function clearNotice() {
  els.notice.hidden = true;
  els.noticeText.textContent = "";
  els.noticeUndoBtn.hidden = true;
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

const GIT_HOSTS = new Set(["github.com", "gitlab.com", "codeberg.org"]);

// A handful of top-level path segments that look like a username/org but
// aren't, shared across GitHub/GitLab/Codeberg's URL conventions. Not
// exhaustive -- a real false-positive-free version would need to check
// against each host's actual reserved-word list -- but it covers the
// common cases cheaply.
const GIT_HOST_RESERVED_OWNERS = new Set([
  "settings", "notifications", "marketplace", "explore", "sponsors",
  "topics", "trending", "orgs", "about", "pricing", "features",
  "login", "signup", "join", "dashboard", "issues", "pulls", "search",
  "new", "codespaces", "gists", "gist", "-", "stars",
]);

// Only ever groups at the owner+repo level -- e.g. "github.com/facebook/react"
// -- never at just "github.com/facebook", since a user/org page isn't a
// meaningful review-together unit the way a single repo's tabs are.
function computeRepoKey(url, domain) {
  if (!domain || !GIT_HOSTS.has(domain)) return null;
  try {
    const u = new URL(url);
    const parts = u.pathname.split("/").filter(Boolean);
    if (parts.length < 2) return null; // just the host root or a lone user/org page
    const [owner, repo] = parts;
    if (!owner || !repo) return null;
    if (GIT_HOST_RESERVED_OWNERS.has(owner.toLowerCase())) return null;
    return `${domain}/${owner}/${repo}`;
  } catch {
    return null;
  }
}

// "github.com/facebook/react" -> "facebook/react", for display only. The
// full key (including host) is still what's used for actual matching, so a
// GitHub and a GitLab repo that happen to share an owner/repo name never
// collide.
function repoDisplayLabel(repoKey) {
  const idx = repoKey.indexOf("/");
  return idx === -1 ? repoKey : repoKey.slice(idx + 1);
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

async function loadSettingsIntoUI() {
  const settings = await getSettings();
  els.settingIncludePinned.checked = settings.includePinned;
  els.settingSortOrder.value = settings.sortOrder;
}

async function saveSettingsFromUI() {
  const settings = {
    includePinned: els.settingIncludePinned.checked,
    sortOrder: els.settingSortOrder.value,
  };
  await browser.storage.local.set({ settings });
  await rebuildAndRender();
  showNotice("Settings updated -- queue rebuilt.");
}

// Reads the actual live bindings rather than hardcoding them, so this can't
// go stale if the user rebinds shortcuts in about:addons -> Manage Extension
// Shortcuts.
async function renderShortcutsList() {
  let commands = [];
  try {
    commands = await browser.commands.getAll();
  } catch (err) {
    console.warn("Tab Decider: couldn't read command shortcuts", err);
  }

  els.shortcutsList.textContent = "";
  for (const cmd of commands) {
    const li = document.createElement("li");
    const kbd = document.createElement("kbd");
    kbd.textContent = cmd.shortcut || "unassigned";
    li.appendChild(kbd);
    li.appendChild(document.createTextNode(cmd.description || cmd.name));
    els.shortcutsList.appendChild(li);
  }
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
    .map((t) => {
      const domain = computeDomain(t.url);
      return {
        tabId: t.id,
        windowId: t.windowId,
        url: t.url,
        title: t.title || t.url,
        domain,
        repoKey: computeRepoKey(t.url, domain),
        pinned: !!t.pinned,
        discarded: !!t.discarded,
        lastAccessed: t.lastAccessed || 0,
      };
    });

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

async function rebuildAndRender() {
  els.progress.textContent = "Rebuilding...";
  const selfTab = await browser.tabs.getCurrent();
  await buildQueue(selfTab.id);
  await render();
}

// "Forget decisions" throws away a whole session's progress with no undo,
// and sits one stray click away from Settings in the header -- so it needs
// a deliberate second click. Two-step inline rather than window.confirm(),
// which blocks the page and looks nothing like the rest of the UI. Arming
// auto-expires so the button can't sit in a dangerous state indefinitely.
let resetConfirmTimer = null;

function disarmResetConfirm() {
  if (resetConfirmTimer !== null) {
    clearTimeout(resetConfirmTimer);
    resetConfirmTimer = null;
  }
  els.resetBtn.textContent = "Forget decisions";
  els.resetBtn.classList.remove("btn-throw");
}

async function handleResetClick() {
  if (resetConfirmTimer !== null) {
    disarmResetConfirm();
    await rebuildAndRender();
    return;
  }

  // Nothing decided yet means nothing to lose -- skip the confirm entirely
  // rather than nagging about discarding an empty history.
  const { history } = await browser.storage.session.get("history");
  const reviewedCount = (history || []).length;
  if (reviewedCount === 0) {
    await rebuildAndRender();
    return;
  }

  els.resetBtn.textContent = "Click again to confirm";
  els.resetBtn.classList.add("btn-throw");
  resetConfirmTimer = setTimeout(disarmResetConfirm, 6000);
  showNotice(
    `This discards ${reviewedCount} reviewed tab${reviewedCount === 1 ? "" : "s"} of progress and rebuilds the queue. Click again to confirm.`
  );
}

// Runs instead of buildQueue() when a session is already active (e.g. the
// decider page was just reloaded, not opened fresh after a browser
// restart). Leaves cursor, history, and existing queue entries completely
// untouched -- anything newly opened since the queue was built just gets
// appended to the end. A tab already sitting in `queue` OR already decided
// in `history` (most importantly: a Kept tab, which is removed from queue
// but still open) is never re-added.
async function mergeNewTabs(selfTabId) {
  const settings = await getSettings();
  const { queue, history } = await browser.storage.session.get(["queue", "history"]);
  const entries = queue || [];
  const hist = history || [];

  const knownTabIds = new Set(entries.map((e) => e.tabId));
  for (const h of hist) {
    if (h.tabId != null) knownTabIds.add(h.tabId);
  }

  const liveTabs = await browser.tabs.query({});
  const newEntries = liveTabs
    .filter((t) => t.id !== selfTabId)
    .filter((t) => settings.includePinned || !t.pinned)
    .filter((t) => !knownTabIds.has(t.id))
    .map((t) => {
      const domain = computeDomain(t.url);
      return {
        tabId: t.id,
        windowId: t.windowId,
        url: t.url,
        title: t.title || t.url,
        domain,
        repoKey: computeRepoKey(t.url, domain),
        pinned: !!t.pinned,
        discarded: !!t.discarded,
        lastAccessed: t.lastAccessed || 0,
      };
    });

  if (newEntries.length === 0) return 0;

  if (settings.sortOrder === "lru") {
    newEntries.sort((a, b) => a.lastAccessed - b.lastAccessed);
  }

  await browser.storage.session.set({ queue: [...entries, ...newEntries] });
  return newEntries.length;
}

function makeBadge(text, extraClass) {
  const span = document.createElement("span");
  span.className = extraClass ? `badge ${extraClass}` : "badge";
  span.textContent = text;
  return span;
}

function renderCurrentCard(entry, liveTab) {
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
  const favIconUrl = (liveTab && liveTab.favIconUrl) || "";
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
  title.title = entry.title;
  textWrap.appendChild(title);

  const url = document.createElement("div");
  url.className = "card-url";
  url.textContent = entry.url;
  url.title = entry.url;
  textWrap.appendChild(url);

  const meta = document.createElement("div");
  meta.className = "card-meta";
  meta.textContent = `Last viewed ${formatRelativeTime(entry.lastAccessed)}`;
  textWrap.appendChild(meta);

  const badges = document.createElement("div");
  badges.className = "card-badges";
  if (entry.domain) badges.appendChild(makeBadge(entry.domain));
  if (entry.repoKey) badges.appendChild(makeBadge(repoDisplayLabel(entry.repoKey), "badge-repo"));
  if (entry.pinned) badges.appendChild(makeBadge("pinned", "badge-pinned"));
  // Prefer the live value: the stored one is a snapshot from queue-build
  // time, so a tab discarded by Firefox since then would show stale.
  const isDiscarded = liveTab ? liveTab.discarded : entry.discarded;
  if (isDiscarded) badges.appendChild(makeBadge("already unloaded", "badge-discarded"));
  textWrap.appendChild(badges);

  card.appendChild(textWrap);
  els.currentCard.appendChild(card);
}

// Live, non-blocking, and scoped to the PENDING QUEUE rather than every
// open tab. That scoping is deliberate: a tab that's been Kept is removed
// from the queue but stays open (just discarded from memory), and offering
// to close it later would undo a decision the user explicitly made. Same
// protection falls out for anything else deliberately excluded from review
// -- pinned tabs when includePinned is off, and the decider tab itself.
//
// Tradeoff worth knowing: entries hold the URL captured when the queue was
// built, so a tab that navigates afterwards is matched on its old URL.
// closeDuplicates/throwAllDuplicates re-verify against the live tab before
// actually closing anything, so a stale match can't cause a wrong close --
// it can only cause a stale row to appear here briefly.
function renderDuplicates(entry, entries) {
  if (!entry) {
    els.duplicatePanel.hidden = true;
    currentDuplicateMatches = [];
    return;
  }

  const matches = entries
    .filter((e) => e.url === entry.url && e.tabId !== entry.tabId)
    .map((e) => ({
      tabId: e.tabId,
      url: e.url,
      title: e.title,
      sameWindow: e.windowId === entry.windowId,
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

// Live and non-blocking: siblings are searched for across the whole pending
// queue, not just what's ahead of the cursor.
//
// Domain and repo counts are gathered in ONE pass rather than two separate
// .filter() scans. At a few hundred tabs that made no difference; at the
// ~1,900 this actually gets used with, it was two full array walks on every
// cursor step. The repo count is always a subset of the domain count (same
// host, narrower path), but they're shown as independent banners because
// "other tabs from github.com" and "other tabs from this exact repo" are
// separately useful things to act on.
function renderSiblingBanners(entry, entries) {
  if (!entry) {
    els.domainBanner.hidden = true;
    els.repoBanner.hidden = true;
    return;
  }

  let domainCount = 0;
  let repoCount = 0;
  for (const e of entries) {
    if (e.tabId === entry.tabId) continue;
    if (entry.domain && e.domain === entry.domain) domainCount++;
    if (entry.repoKey && e.repoKey === entry.repoKey) repoCount++;
  }

  if (!entry.domain || domainCount === 0) {
    els.domainBanner.hidden = true;
  } else {
    els.domainBanner.hidden = false;
    els.domainBannerText.textContent =
      `${domainCount} other tab${domainCount === 1 ? "" : "s"} from ${entry.domain} open.`;
  }

  if (!entry.repoKey || repoCount === 0) {
    els.repoBanner.hidden = true;
  } else {
    els.repoBanner.hidden = false;
    els.repoBannerText.textContent =
      `${repoCount} other tab${repoCount === 1 ? "" : "s"} from ${repoDisplayLabel(entry.repoKey)} open.`;
  }
}

function renderSummary(history, duplicatesClosedTotal) {
  const kept = history.filter((h) => h.decision === "keep").length;
  const thrown = history.filter((h) => h.decision === "throw").length;
  els.summaryKept.textContent = String(kept);
  els.summaryThrown.textContent = String(thrown);
  els.summaryDuplicates.textContent = String(duplicatesClosedTotal);
}

async function render() {
  clearNotice();
  // Any other activity cancels a pending reset confirm -- otherwise the
  // button could sit armed while the user does something else entirely,
  // and their next click on it would wipe progress with no warning.
  disarmResetConfirm();

  const { queue, cursor, history, duplicatesClosedTotal } = await browser.storage.session.get([
    "queue", "cursor", "history", "duplicatesClosedTotal",
  ]);
  const entries = queue || [];
  const reviewedCount = (history || []).length;
  const dupCount = duplicatesClosedTotal || 0;

  els.progress.textContent =
    `${entries.length} tab${entries.length === 1 ? "" : "s"} in queue · ` +
    `${reviewedCount} reviewed` +
    (dupCount ? ` · ${dupCount} duplicate${dupCount === 1 ? "" : "s"} closed` : "") +
    ` this session`;

  if (entries.length === 0) {
    els.positionLabel.textContent = "Queue empty";
    els.jumpInput.value = "";

    els.currentCard.hidden = true;
    els.duplicatePanel.hidden = true;
    els.domainBanner.hidden = true;
    els.repoBanner.hidden = true;
    els.actionRow.hidden = true;
    const enteringSummary = els.summaryCard.hidden;
    els.summaryCard.hidden = false;
    renderSummary(history || [], dupCount);
    if (enteringSummary) {
      els.summaryRestartBtn.focus();
    }

    els.peekBtn.disabled = true;
    els.keepBtn.disabled = true;
    els.throwBtn.disabled = true;
    els.stepBack10.disabled = true;
    els.stepBack1.disabled = true;
    els.stepFwd1.disabled = true;
    els.stepFwd10.disabled = true;
    return;
  }

  els.summaryCard.hidden = true;
  els.currentCard.hidden = false;
  els.actionRow.hidden = false;

  const rawCursor = cursor || 0;
  const pos = Math.max(0, Math.min(rawCursor, entries.length - 1));
  if (pos !== rawCursor) {
    await browser.storage.session.set({ cursor: pos }); // correct drift after external changes
  }

  els.positionLabel.textContent = `Viewing #${pos + 1} of ${entries.length}`;
  els.jumpInput.value = "";

  const entry = entries[pos];

  // One tabs.get() for the current entry, instead of the tabs.query({})
  // this used to run on every single render -- that pulled every open tab
  // (~1,900 in real use) and built a favicon Map of all of them just to
  // read one entry's icon. Duplicates no longer need the full list either,
  // since they're matched against the queue now.
  let liveTab = null;
  try {
    liveTab = await browser.tabs.get(entry.tabId);
  } catch {
    // Tab's gone; background.js's onRemoved listener will prune it from the
    // queue. Render what we have from the stored entry rather than blanking.
  }

  renderCurrentCard(entry, liveTab);
  renderDuplicates(entry, entries);
  renderSiblingBanners(entry, entries);

  els.peekBtn.disabled = false;
  els.keepBtn.disabled = false;
  els.throwBtn.disabled = false;
  els.stepBack10.disabled = pos <= 0;
  els.stepBack1.disabled = pos <= 0;
  els.stepFwd1.disabled = pos >= entries.length - 1;
  els.stepFwd10.disabled = pos >= entries.length - 1;
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

// Called right after any tab-closing action. `closedItems` is what was just
// closed (each flagged `wasCurrent` if it was the entry actually being
// decided, vs. a duplicate closed alongside it). `historyEntriesToRemove`
// and `duplicatesToUncount` let undo roll back the session-stats bookkeeping
// too, not just reopen the tabs.
//
// Two things this has to get right, both of which the earlier per-item
// version got wrong:
//
//  1. Duplicates share a URL by definition, so matching on URL alone and
//     taking the first hit handed back the SAME sessionId for every one of
//     them -- undo then tried to restore one tab N times instead of N tabs
//     once. Session ids are claimed here as they're matched, so each closed
//     tab maps to a distinct closed-session entry.
//
//  2. getRecentlyClosed() is queried once per attempt for the whole batch,
//     not once per item. The old code polled 5 x 150ms PER ITEM, so a
//     Throw All over tabs Firefox doesn't record in closed-tab history
//     (about: pages, for instance) stalled the UI for seconds. Worst case
//     here is now three lookups total regardless of batch size.
async function captureClosedForUndo(closedItems, historyEntriesToRemove, duplicatesToUncount) {
  if (closedItems.length === 0) return;

  const items = [];
  const claimedSessionIds = new Set();
  let pending = closedItems.slice();

  for (let attempt = 0; attempt < 3 && pending.length > 0; attempt++) {
    let sessions = [];
    try {
      sessions = await browser.sessions.getRecentlyClosed({
        maxResults: Math.min(100, Math.max(25, closedItems.length * 2)),
      });
    } catch (err) {
      console.warn("Tab Decider: couldn't read recently-closed sessions", err);
      break;
    }

    const stillPending = [];
    for (const closed of pending) {
      const match = sessions.find(
        (s) => s.tab && s.tab.url === closed.url && !claimedSessionIds.has(s.tab.sessionId)
      );
      if (match) {
        claimedSessionIds.add(match.tab.sessionId);
        items.push({
          sessionId: match.tab.sessionId,
          url: closed.url,
          title: closed.title,
          wasCurrent: closed.wasCurrent,
        });
      } else {
        stillPending.push(closed);
      }
    }
    pending = stillPending;

    // Firefox can lag a beat behind tabs.remove() before a tab shows up in
    // closed-tab history, so retry briefly -- but only if something's
    // actually still missing.
    if (pending.length > 0 && attempt < 2) {
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }

  if (items.length === 0) return;
  await browser.storage.session.set({
    lastClosedAction: { items, historyEntriesToRemove, duplicatesToUncount, closedAt: Date.now() },
  });
}

// Restores every tab from the last closing action via the real
// sessions.restore() API -- an actually-reopened tab, not a queue-only
// simulation. The item that was the entry actually being decided (if any)
// goes back to exactly where the cursor is now; anything else closed
// alongside it (duplicates) gets appended to the end, same as any other
// newly-appeared tab. Also rolls back the history/duplicate-count
// bookkeeping so the session summary stays accurate.
async function undoLastClose() {
  const { lastClosedAction, queue, cursor, history, duplicatesClosedTotal } = await browser.storage.session.get([
    "lastClosedAction", "queue", "cursor", "history", "duplicatesClosedTotal",
  ]);
  if (!lastClosedAction) return;

  const restoredCurrent = [];
  const restoredOthers = [];

  for (const item of lastClosedAction.items) {
    try {
      const result = await browser.sessions.restore(item.sessionId);
      const restoredTab = result && result.tab;
      if (!restoredTab) continue;
      // Deliberately NOT reading restoredTab.url/title here: right at the
      // moment this promise resolves, Firefox has the tab's title populated
      // from the session data but the URL can still be mid-navigation and
      // read as "about:blank" -- a real, reproducible race, not a rare
      // edge case. item.url/item.title were captured before the tab was
      // ever closed, so they're already ground truth -- no need to trust
      // (or poll around) the freshly-restored tab for those two fields.
      const domain = computeDomain(item.url);
      const restoredEntry = {
        tabId: restoredTab.id,
        windowId: restoredTab.windowId,
        url: item.url,
        title: item.title,
        domain,
        repoKey: computeRepoKey(item.url, domain),
        pinned: !!restoredTab.pinned,
        discarded: !!restoredTab.discarded,
        lastAccessed: restoredTab.lastAccessed || Date.now(),
      };
      (item.wasCurrent ? restoredCurrent : restoredOthers).push(restoredEntry);
    } catch (err) {
      console.warn("Tab Decider: couldn't restore a tab", err);
    }
  }

  const totalRestored = restoredCurrent.length + restoredOthers.length;
  if (totalRestored === 0) {
    await browser.storage.session.set({ lastClosedAction: null });
    showNotice("Couldn't undo -- Firefox may have already cleared that from its closed-tabs history.");
    return;
  }

  const entries = queue || [];
  const pos = cursor || 0;
  const nextQueue = [...entries.slice(0, pos), ...restoredCurrent, ...entries.slice(pos), ...restoredOthers];

  const hist = (history || []).slice();
  for (let i = 0; i < lastClosedAction.historyEntriesToRemove && hist.length; i++) {
    hist.pop();
  }
  const nextDupTotal = Math.max(0, (duplicatesClosedTotal || 0) - lastClosedAction.duplicatesToUncount);

  await browser.storage.session.set({
    queue: nextQueue,
    cursor: pos,
    history: hist,
    duplicatesClosedTotal: nextDupTotal,
    lastClosedAction: null,
  });

  await render();
  showNotice(`Restored ${totalRestored} tab${totalRestored === 1 ? "" : "s"}.`);
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

  if (action === "throw") {
    await captureClosedForUndo([{ url: entry.url, title: entry.title, wasCurrent: true }], 1, 0);
    showNotice(`Threw "${entry.title}".`, true);
  }
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

  const historyEntry = { tabId: entry.tabId, url: entry.url, title: entry.title, decision: action, decidedAt: Date.now() };

  await browser.storage.session.set({
    queue: nextQueue,
    cursor: nextCursor,
    history: [...(history || []), historyEntry],
  });
  await render();
}

// Queue entries hold the URL captured when the queue was built, so a tab
// that navigated since then could be matched as a duplicate on a URL it no
// longer has. Closing is destructive, so confirm against the live tab first
// -- a stale match then costs nothing worse than a skipped row.
async function closeTabIfStillMatching(tabId, expectedUrl) {
  try {
    const live = await browser.tabs.get(tabId);
    if (live.url !== expectedUrl) {
      console.warn("Tab Decider: skipping close, tab no longer matches", { tabId, expectedUrl, actual: live.url });
      return false;
    }
    await browser.tabs.remove(tabId);
    return true;
  } catch (err) {
    console.warn("Tab Decider: close failed", err);
    return false;
  }
}

async function closeDuplicates() {
  const toClose = currentDuplicateMatches.filter((m) => m.checked);
  if (toClose.length === 0) return;

  const closedItems = [];
  for (const m of toClose) {
    if (await closeTabIfStillMatching(m.tabId, m.url)) {
      closedItems.push({ url: m.url, title: m.title, wasCurrent: false });
    }
  }

  // Count only what actually closed, not what we attempted -- a failed
  // tabs.remove() used to still inflate the session total (and the notice).
  const { duplicatesClosedTotal } = await browser.storage.session.get("duplicatesClosedTotal");
  await browser.storage.session.set({ duplicatesClosedTotal: (duplicatesClosedTotal || 0) + closedItems.length });

  await render();
  await captureClosedForUndo(closedItems, 0, closedItems.length);
  showNotice(`Closed ${closedItems.length} duplicate tab${closedItems.length === 1 ? "" : "s"}.`, true);
}

// Closes the current entry AND every duplicate match together, regardless
// of checkbox state -- "All" means all, unlike "Close selected" which
// leaves the current tab's own Keep/Throw decision untouched. This counts
// as a Throw decision on the current entry, so it advances the queue too.
async function throwAllDuplicates() {
  if (currentDuplicateMatches.length === 0) return;

  const { queue, cursor } = await browser.storage.session.get(["queue", "cursor"]);
  const entries = queue || [];
  const entry = entries[cursor || 0];
  if (!entry) return;

  const matches = currentDuplicateMatches.slice();
  const closedItems = [];

  try {
    await browser.tabs.remove(entry.tabId);
    closedItems.push({ url: entry.url, title: entry.title, wasCurrent: true });
  } catch (err) {
    console.warn("Tab Decider: throw-all failed on current tab", err);
  }
  let duplicatesClosedCount = 0;
  for (const m of matches) {
    if (await closeTabIfStillMatching(m.tabId, m.url)) {
      closedItems.push({ url: m.url, title: m.title, wasCurrent: false });
      duplicatesClosedCount++;
    }
  }

  const { duplicatesClosedTotal } = await browser.storage.session.get("duplicatesClosedTotal");
  await browser.storage.session.set({ duplicatesClosedTotal: (duplicatesClosedTotal || 0) + duplicatesClosedCount });

  await finalizeDecision(entry, "throw");
  await captureClosedForUndo(closedItems, 1, duplicatesClosedCount);
  showNotice(
    `Threw ${closedItems.length} tabs -- this one plus ${duplicatesClosedCount} duplicate${duplicatesClosedCount === 1 ? "" : "s"}.`,
    true
  );
}

// Moves every other pending entry sharing the current tab's domain to
// right after the current position, wherever they currently sit in the
// queue (before or after the cursor).
// Shared by bumpDomainSiblings and bumpRepoSiblings -- both are "find every
// other pending entry matching some key on the current entry, and move them
// to right after it," just with a different key (domain vs. repo).
async function bumpSiblingsBy(getKey, describeGroup) {
  const { queue, cursor } = await browser.storage.session.get(["queue", "cursor"]);
  const entries = (queue || []).slice();
  const pos = cursor || 0;
  const entry = entries[pos];
  const key = entry && getKey(entry);
  if (!entry || !key) return;

  const siblingIndexes = [];
  entries.forEach((e, i) => {
    if (i !== pos && getKey(e) === key) siblingIndexes.push(i);
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
    `Moved ${siblings.length} tab${siblings.length === 1 ? "" : "s"} from ${describeGroup(entry)} to review right after this one.`
  );
}

async function bumpDomainSiblings() {
  await bumpSiblingsBy((e) => e.domain, (e) => e.domain);
}

async function bumpRepoSiblings() {
  await bumpSiblingsBy((e) => e.repoKey, (e) => repoDisplayLabel(e.repoKey));
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

  await loadSettingsIntoUI();
  await renderShortcutsList();

  const { sessionActive } = await browser.storage.session.get("sessionActive");
  let addedCount = 0;
  if (!sessionActive) {
    await buildQueue(selfTab.id);
  } else {
    // Reloading the page (not a browser restart) shouldn't lose your
    // position or rebuild from scratch -- just pick up anything opened
    // since the queue was last built and tack it onto the end.
    addedCount = await mergeNewTabs(selfTab.id);
  }
  await render();
  if (addedCount > 0) {
    showNotice(`Added ${addedCount} new tab${addedCount === 1 ? "" : "s"} to the end of the queue.`);
  }

  // Keyboard shortcuts are handled in background.js (global commands work
  // regardless of which tab has focus) and relayed here as a message, so
  // there's exactly one decide() implementation whether it was triggered by
  // a click or Alt+Shift+K/T from wherever you Peeked to. Returning the
  // decide() promise lets background.js's sendMessage() await full
  // completion (decision + duplicate/domain re-render) before it brings
  // this tab into focus.
  browser.runtime.onMessage.addListener((message) => {
    if (!message || message.type !== "decide") return;
    return decide(message.action);
  });

  els.resetBtn.addEventListener("click", handleResetClick);
  // No confirm needed here: the summary only appears once the queue is
  // already empty, so there's no in-progress review left to lose.
  els.summaryRestartBtn.addEventListener("click", rebuildAndRender);
  els.noticeUndoBtn.addEventListener("click", undoLastClose);

  els.settingsToggleBtn.addEventListener("click", () => {
    const isHidden = els.settingsPanel.hidden;
    els.settingsPanel.hidden = !isHidden;
    els.settingsToggleBtn.setAttribute("aria-expanded", String(isHidden));
  });
  els.settingIncludePinned.addEventListener("change", saveSettingsFromUI);
  els.settingSortOrder.addEventListener("change", saveSettingsFromUI);

  els.peekBtn.addEventListener("click", peekCurrent);
  els.keepBtn.addEventListener("click", () => decide("keep"));
  els.throwBtn.addEventListener("click", () => decide("throw"));

  els.duplicateCloseBtn.addEventListener("click", closeDuplicates);
  els.duplicateThrowAllBtn.addEventListener("click", throwAllDuplicates);
  els.domainBumpBtn.addEventListener("click", bumpDomainSiblings);
  els.repoBumpBtn.addEventListener("click", bumpRepoSiblings);

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
