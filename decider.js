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

// @ts-check
/* global browser */

/**
 * @typedef {"keep" | "throw"} DecisionAction
 * @typedef {"lru" | "tab-order"} SortOrder
 * @typedef {"closed" | "gone" | "mismatch"} CloseResult
 */

/**
 * A tab as stored in the review queue. Note url/title/domain/repoKey are
 * SNAPSHOTS from when the entry was built -- a tab that navigates afterwards
 * keeps its old values here until the queue is rebuilt, which is why
 * destructive paths re-verify against the live tab first.
 * @typedef {object} QueueEntry
 * @property {number} tabId
 * @property {number} windowId
 * @property {string} url
 * @property {string} title
 * @property {string|null} domain
 * @property {string|null} repoKey
 * @property {boolean} pinned
 * @property {boolean} discarded
 * @property {number} lastAccessed
 */

/**
 * @typedef {object} HistoryEntry
 * @property {number} tabId
 * @property {string} url
 * @property {string} title
 * @property {DecisionAction} decision
 * @property {number} decidedAt
 */

/**
 * @typedef {object} DuplicateMatch
 * @property {number} tabId
 * @property {string} url
 * @property {string} title
 * @property {boolean} sameWindow
 * @property {boolean} checked
 */

/**
 * @typedef {object} ClosedItem
 * @property {string} url
 * @property {string} title
 * @property {boolean} wasCurrent
 */

/**
 * @typedef {object} SessionState
 * @property {QueueEntry[]} queue
 * @property {number} cursor
 * @property {HistoryEntry[]} history
 * @property {number} duplicatesClosedTotal
 * @property {string} filterQuery
 * @property {boolean} sessionActive
 */

/**
 * @typedef {object} Settings
 * @property {boolean} includePinned
 * @property {SortOrder} sortOrder
 */

const els = {
  progress: document.getElementById("progress"),
  settingsToggleBtn: /** @type {HTMLButtonElement} */ (document.getElementById("settings-toggle-btn")),
  settingsPanel: document.getElementById("settings-panel"),
  settingIncludePinned: /** @type {HTMLInputElement} */ (document.getElementById("setting-include-pinned")),
  settingSortOrder: /** @type {HTMLSelectElement} */ (document.getElementById("setting-sort-order")),
  shortcutsList: document.getElementById("shortcuts-list"),
  reviewMain: document.getElementById("review-main"),
  announcer: document.getElementById("announcer"),
  filterInput: /** @type {HTMLInputElement} */ (document.getElementById("filter-input")),
  filterClearBtn: /** @type {HTMLButtonElement} */ (document.getElementById("filter-clear-btn")),
  filterStatus: document.getElementById("filter-status"),
  positionLabel: document.getElementById("position-label"),
  jumpInput: /** @type {HTMLInputElement} */ (document.getElementById("jump-input")),
  jumpBtn: /** @type {HTMLButtonElement} */ (document.getElementById("jump-btn")),
  stepBack10: /** @type {HTMLButtonElement} */ (document.getElementById("step-back-10")),
  stepBack1: /** @type {HTMLButtonElement} */ (document.getElementById("step-back-1")),
  stepFwd1: /** @type {HTMLButtonElement} */ (document.getElementById("step-fwd-1")),
  stepFwd10: /** @type {HTMLButtonElement} */ (document.getElementById("step-fwd-10")),
  currentCard: document.getElementById("current-card"),
  notice: document.getElementById("notice"),
  noticeText: document.getElementById("notice-text"),
  noticeUndoBtn: /** @type {HTMLButtonElement} */ (document.getElementById("notice-undo-btn")),
  resetBtn: /** @type {HTMLButtonElement} */ (document.getElementById("reset-btn")),
  actionRow: document.getElementById("action-row"),
  peekBtn: /** @type {HTMLButtonElement} */ (document.getElementById("peek-btn")),
  keepBtn: /** @type {HTMLButtonElement} */ (document.getElementById("keep-btn")),
  throwBtn: /** @type {HTMLButtonElement} */ (document.getElementById("throw-btn")),
  duplicatePanel: document.getElementById("duplicate-panel"),
  duplicateSummary: document.getElementById("duplicate-summary"),
  duplicateList: document.getElementById("duplicate-list"),
  duplicateCloseBtn: /** @type {HTMLButtonElement} */ (document.getElementById("duplicate-close-btn")),
  duplicateThrowAllBtn: /** @type {HTMLButtonElement} */ (document.getElementById("duplicate-throw-all-btn")),
  domainBanner: document.getElementById("domain-banner"),
  domainBannerText: document.getElementById("domain-banner-text"),
  domainBumpBtn: /** @type {HTMLButtonElement} */ (document.getElementById("domain-bump-btn")),
  repoBanner: document.getElementById("repo-banner"),
  repoBannerText: document.getElementById("repo-banner-text"),
  repoBumpBtn: /** @type {HTMLButtonElement} */ (document.getElementById("repo-bump-btn")),
  summaryCard: document.getElementById("summary-card"),
  summaryKept: document.getElementById("summary-kept"),
  summaryThrown: document.getElementById("summary-thrown"),
  summaryDuplicates: document.getElementById("summary-duplicates"),
  summaryRestartBtn: /** @type {HTMLButtonElement} */ (document.getElementById("summary-restart-btn")),
};

// Transient, recomputed on every render -- not persisted. Just lets the
// "Close selected" button know which checkboxes are currently ticked.
let currentDuplicateMatches = [];

// Every action that mutates tabs or queue state goes through runExclusive.
// Nothing previously stopped two of them overlapping: a double-click, a held
// key repeating, or a global shortcut firing twice could both read the same
// cursor snapshot before either wrote, so two decisions would act on one tab
// (or one decision would be silently lost).
const DECISION_ACTIONS = new Set(["keep", "throw"]);

let actionInProgress = false;

async function runExclusive(operation) {
  if (actionInProgress) return;
  actionInProgress = true;
  setBusy(true);
  try {
    return await operation();
  } catch (err) {
    console.error("Tab Decider: action failed", err);
    showNotice("Something went wrong with that action -- see the console for details.");
  } finally {
    actionInProgress = false;
    setBusy(false);
  }
}

// Only sets aria-busy. Deliberately does NOT disable the buttons: re-enabling
// them afterwards would fight render()'s own disabled-state logic, and an
// operation that returns early (e.g. decide() bailing on an undiscardable
// tab) would leave them stuck disabled. The actionInProgress flag already
// prevents re-entry on its own.
function setBusy(busy) {
  els.reviewMain.setAttribute("aria-busy", String(busy));
}

// The single screen-reader announcement channel. One concise sentence per
// state change beats the old approach of marking the whole card aria-live,
// which re-read title + URL + relative time + every badge on every step.
function announce(message) {
  // Reassigning identical text does not re-fire a live region; clearing first
  // guarantees repeated states (e.g. two identical titles) still announce.
  els.announcer.textContent = "";
  els.announcer.textContent = message;
}

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

/**
 * The one place a browser Tab becomes a QueueEntry. Previously this mapping
 * was copy-pasted in buildQueue, mergeNewTabs and undoLastClose, so every new
 * field (repoKey was the last one) had to be added in three places or the
 * three would silently disagree.
 *
 * `override` exists for undo: a restored tab's url/title can still be
 * mid-navigation ("about:blank") at the moment sessions.restore() resolves,
 * so the caller passes the values captured before the tab was closed.
 *
 * @param {any} tab
 * @param {{url?: string, title?: string, lastAccessed?: number}} [override]
 * @returns {QueueEntry}
 */
function tabToQueueEntry(tab, override = {}) {
  const url = override.url ?? tab.url ?? "";
  const title = override.title ?? tab.title ?? url;
  const domain = computeDomain(url);
  return {
    tabId: tab.id,
    windowId: tab.windowId,
    url,
    title,
    domain,
    repoKey: computeRepoKey(url, domain),
    pinned: Boolean(tab.pinned),
    discarded: Boolean(tab.discarded),
    lastAccessed: override.lastAccessed ?? tab.lastAccessed ?? 0,
  };
}

/**
 * Persisted state is not inherently trustworthy: an extension reload mid-
 * session, or a build with a different schema, can leave shapes that no
 * longer match what the code expects. Normalising on read means a damaged
 * value degrades to a sane default instead of throwing somewhere deep in
 * render().
 * @param {any} raw
 * @returns {SessionState}
 */
function normaliseSessionState(raw) {
  const state = raw && typeof raw === "object" ? raw : {};
  const queue = Array.isArray(state.queue) ? state.queue.filter(isQueueEntry) : [];
  const cursor = Number.isSafeInteger(state.cursor) && state.cursor >= 0 ? state.cursor : 0;
  return {
    queue,
    // Clamp here as well as in getView: a cursor past the end of a recovered
    // queue would otherwise render nothing at all.
    cursor: queue.length === 0 ? 0 : Math.min(cursor, queue.length - 1),
    history: Array.isArray(state.history) ? state.history.filter(isHistoryEntry) : [],
    duplicatesClosedTotal:
      Number.isSafeInteger(state.duplicatesClosedTotal) && state.duplicatesClosedTotal >= 0
        ? state.duplicatesClosedTotal
        : 0,
    filterQuery: typeof state.filterQuery === "string" ? state.filterQuery : "",
    sessionActive: state.sessionActive === true,
  };
}

/** @param {any} value @returns {boolean} */
function isQueueEntry(value) {
  return (
    value &&
    typeof value === "object" &&
    Number.isInteger(value.tabId) &&
    typeof value.url === "string" &&
    typeof value.title === "string"
  );
}

/** @param {any} value @returns {boolean} */
function isHistoryEntry(value) {
  return (
    value &&
    typeof value === "object" &&
    (value.decision === "keep" || value.decision === "throw")
  );
}

/** @returns {Promise<SessionState>} */
async function readSessionState() {
  const raw = await browser.storage.session.get([
    "queue", "cursor", "history", "duplicatesClosedTotal", "filterQuery", "sessionActive",
  ]);
  return normaliseSessionState(raw);
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
    .map((t) => tabToQueueEntry(t));

  if (settings.sortOrder === "lru") {
    entries.sort((a, b) => a.lastAccessed - b.lastAccessed);
  }

  // Under the lock even though it's a blind write, not a read-modify-write:
  // a background prune that read the OLD queue and lands after this one would
  // otherwise overwrite the fresh queue with a stale one.
  try {
    await withQueueLock(() =>
      browser.storage.session.set({
        queue: entries,
        history: [],
        cursor: 0,
        duplicatesClosedTotal: 0,
        sessionActive: true,
      })
    );
  } catch (err) {
    els.progress.textContent = `Couldn't save the queue: ${err.message}`;
    throw err;
  }
  return entries;
}

// Two-step inline confirm, reusable by any destructive button. Chosen over
// window.confirm() because that blocks the page and looks nothing like the
// rest of the UI. Arming auto-expires so a button can never sit in a
// dangerous state indefinitely, and render() disarms too -- otherwise a
// button could stay armed while the user does something else entirely and
// their next click would fire it with no warning.
const CONFIRM_TIMEOUT_MS = 6000;

// Any action closing more than this many tabs at once asks first.
const BULK_CONFIRM_THRESHOLD = 5;

let pendingConfirm = null; // { btn, label, className, timer }

function disarmConfirm() {
  if (!pendingConfirm) return;
  clearTimeout(pendingConfirm.timer);
  pendingConfirm.btn.textContent = pendingConfirm.label;
  pendingConfirm.btn.className = pendingConfirm.className;
  pendingConfirm = null;
}

// Returns true when this is the confirming (second) click, false when it
// has just armed and is waiting. Callers bail out on false.
function requestConfirm(btn, confirmLabel, message) {
  if (pendingConfirm && pendingConfirm.btn === btn) {
    disarmConfirm();
    return true;
  }
  disarmConfirm();

  pendingConfirm = {
    btn,
    label: btn.textContent,
    className: btn.className,
    timer: setTimeout(disarmConfirm, CONFIRM_TIMEOUT_MS),
  };
  btn.textContent = confirmLabel;
  btn.classList.remove("btn-neutral");
  btn.classList.add("btn-throw");
  showNotice(message);
  return false;
}

async function rebuildAndRender() {
  els.progress.textContent = "Rebuilding...";
  const selfTab = await browser.tabs.getCurrent();
  await buildQueue(selfTab.id);
  await render();
}

// "Forget decisions" throws away a whole session's progress with no undo,
// and sits one stray click away from Settings in the header.
async function handleResetClick() {
  // Nothing decided yet means nothing to lose -- skip the confirm entirely
  // rather than nagging about discarding an empty history.
  const { history } = await browser.storage.session.get("history");
  const reviewedCount = (history || []).length;
  if (reviewedCount === 0) {
    await rebuildAndRender();
    return;
  }

  const confirmed = requestConfirm(
    els.resetBtn,
    "Click again to confirm",
    `This discards ${reviewedCount} reviewed tab${reviewedCount === 1 ? "" : "s"} of progress and rebuilds the queue. Click again to confirm.`
  );
  if (confirmed) await rebuildAndRender();
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
  const liveTabs = await browser.tabs.query({});

  // The read of `queue` and the write back are both inside the lock: a
  // background prune landing between them would otherwise be undone by the
  // write, putting a tab the user just closed back in the queue.
  return withQueueLock(async () => {
    const { queue, history } = await browser.storage.session.get(["queue", "history"]);
    const entries = queue || [];
    const hist = history || [];

    const knownTabIds = new Set(entries.map((e) => e.tabId));
    for (const h of hist) {
      if (h.tabId != null) knownTabIds.add(h.tabId);
    }

    const newEntries = liveTabs
      .filter((t) => t.id !== selfTabId)
      .filter((t) => settings.includePinned || !t.pinned)
      .filter((t) => !knownTabIds.has(t.id))
      .map((t) => tabToQueueEntry(t));

    if (newEntries.length === 0) return 0;

    if (settings.sortOrder === "lru") {
      newEntries.sort((a, b) => a.lastAccessed - b.lastAccessed);
    }

    await browser.storage.session.set({ queue: [...entries, ...newEntries] });
    return newEntries.length;
  });
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
  // Any other activity cancels a pending confirm -- otherwise a button
  // could sit armed while the user does something else entirely, and their
  // next click on it would fire it with no warning.
  disarmConfirm();

  const { history, duplicatesClosedTotal } = await readSessionState();
  const view = await getView();
  const entries = view.entries;
  const reviewedCount = history.length;
  const dupCount = duplicatesClosedTotal;

  els.progress.textContent =
    `${entries.length} tab${entries.length === 1 ? "" : "s"} in queue \u00b7 ` +
    `${reviewedCount} reviewed` +
    (dupCount ? ` \u00b7 ${dupCount} duplicate${dupCount === 1 ? "" : "s"} closed` : "") +
    ` this session`;

  // Keep the input in sync without stomping what the user is mid-typing.
  if (document.activeElement !== els.filterInput) {
    els.filterInput.value = view.query;
  }
  els.filterClearBtn.hidden = !view.query;
  els.filterStatus.textContent = view.query
    ? `${view.viewSize} of ${entries.length} match`
    : "";

  const hasEntry = !!view.entry;
  els.peekBtn.disabled = !hasEntry;
  els.keepBtn.disabled = !hasEntry;
  els.throwBtn.disabled = !hasEntry;
  els.stepBack10.disabled = !hasEntry || view.viewPos <= 0;
  els.stepBack1.disabled = !hasEntry || view.viewPos <= 0;
  els.stepFwd1.disabled = !hasEntry || view.viewPos >= view.viewSize - 1;
  els.stepFwd10.disabled = !hasEntry || view.viewPos >= view.viewSize - 1;
  els.jumpInput.value = "";

  // The whole queue is done -- that's the session summary. Distinct from a
  // filter simply matching nothing, which is not an end state.
  if (entries.length === 0) {
    els.positionLabel.textContent = "Queue empty";
    els.currentCard.hidden = true;
    els.duplicatePanel.hidden = true;
    els.domainBanner.hidden = true;
    els.repoBanner.hidden = true;
    els.actionRow.hidden = true;
    const enteringSummary = els.summaryCard.hidden;
    els.summaryCard.hidden = false;
    renderSummary(history, dupCount);
    if (enteringSummary) {
      els.summaryRestartBtn.focus();
      const kept = history.filter((h) => h.decision === "keep").length;
      const thrown = history.filter((h) => h.decision === "throw").length;
      announce(`Review complete. ${kept} kept, ${thrown} thrown.`);
    }
    return;
  }

  els.summaryCard.hidden = true;
  els.currentCard.hidden = false;

  // Filter matched nothing: say so plainly rather than showing the summary
  // (nothing is finished) or a blank card.
  if (!hasEntry) {
    els.positionLabel.textContent = "No matches";
    els.currentCard.textContent = "";
    const p = document.createElement("p");
    p.className = "empty";
    p.textContent = `Nothing in the queue matches \u201c${view.query}\u201d.`;
    els.currentCard.appendChild(p);
    announce(`No tabs match ${view.query}.`);
    els.duplicatePanel.hidden = true;
    els.domainBanner.hidden = true;
    els.repoBanner.hidden = true;
    els.actionRow.hidden = true;
    return;
  }

  els.actionRow.hidden = false;

  // Snapping can land the cursor on a different entry than stored (e.g. the
  // filter excluded where it was); persist that so navigation continues
  // from what is actually on screen.
  if (view.queueIndex !== undefined && view.queueIndex >= 0) {
    await browser.storage.session.set({ cursor: view.queueIndex });
  }

  els.positionLabel.textContent = view.query
    ? `Viewing #${view.viewPos + 1} of ${view.viewSize} matching`
    : `Viewing #${view.viewPos + 1} of ${view.viewSize}`;

  const entry = view.entry;

  // One tabs.get() for the current entry, instead of the tabs.query({})
  // this used to run on every single render -- that pulled every open tab
  // (~1,900 in real use) and built a favicon Map of all of them just to
  // read one entry\u2019s icon. Duplicates no longer need the full list
  // either, since they\u2019re matched against the queue now.
  let liveTab = null;
  try {
    liveTab = await browser.tabs.get(entry.tabId);
  } catch {
    // Tab's gone; background.js's onRemoved listener will prune it from the
    // queue. Render what we have from the stored entry rather than blanking.
  }

  renderCurrentCard(entry, liveTab);
  // Duplicates and sibling counts are deliberately computed against the
  // FULL queue, not the filtered view: a duplicate you can't see because
  // of a filter is still a duplicate, and hiding it would be misleading.
  renderDuplicates(entry, entries);
  renderSiblingBanners(entry, entries);

  // One sentence covering position, identity, and whatever contextual panels
  // just appeared -- those panels are otherwise silent to screen readers,
  // and "Throw all" in the duplicate panel is destructive.
  const parts = [`Tab ${view.viewPos + 1} of ${view.viewSize}${view.query ? " matching" : ""}: ${entry.title}`];
  if (currentDuplicateMatches.length > 0) {
    parts.push(`${currentDuplicateMatches.length} duplicate${currentDuplicateMatches.length === 1 ? "" : "s"} of this URL open`);
  }
  if (!els.repoBanner.hidden) parts.push(els.repoBannerText.textContent);
  else if (!els.domainBanner.hidden) parts.push(els.domainBannerText.textContent);
  announce(parts.join(". "));
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
  const { lastClosedAction } = await browser.storage.session.get("lastClosedAction");
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
      const restoredEntry = tabToQueueEntry(restoredTab, {
        url: item.url,
        title: item.title,
        lastAccessed: restoredTab.lastAccessed || Date.now(),
      });
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

  // The restores above are a sessions.restore() round-trip per tab, far too
  // slow to hold the queue lock across -- so the queue is read inside the
  // lock instead, and the write reflects whatever it looks like by the time
  // we actually hold it.
  await withQueueLock(async () => {
    const { queue, cursor, history, duplicatesClosedTotal } = await browser.storage.session.get([
      "queue", "cursor", "history", "duplicatesClosedTotal",
    ]);
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
  });

  await render();
  showNotice(`Restored ${totalRestored} tab${totalRestored === 1 ? "" : "s"}.`);
}

async function decide(action) {
  // Belt and braces: the message listener already whitelists this, but an
  // internal caller could still get it wrong, and silently mis-finalising a
  // decision is the worst possible failure mode here.
  if (!DECISION_ACTIONS.has(action)) {
    console.error("Tab Decider: refusing unsupported decision action", action);
    return;
  }

  const view = await getView();
  const entry = view.entry;
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

// `queue` has two writers in two contexts: this page, and background.js's
// tabs.onRemoved pruning. Both read it, edit it, and write the whole array
// back, so a page write that reads before a background write and lands after
// it puts back whatever the background just removed. Closing one tab was
// survivable (both sides compute the same end state), but "Throw all" closes
// the current tab AND its duplicates, so the clobber resurrected every
// duplicate in the batch as a dead entry.
//
// background.js owns the lock; taking it parks an entry on the same chain its
// own writes run through, so neither side can read a queue the other is about
// to replace. Every read-modify-write of `queue` on this page goes through
// here -- a lock only some writers take isn't a lock.
//
// Page-local calls are chained too: that keeps this page to one outstanding
// lease, since a second acquire while we already hold one would wait on a
// chain that only our own release can unblock.
let pageQueueWrite = Promise.resolve();

/**
 * @template T
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
function withQueueLock(fn) {
  const run = async () => {
    let locked = false;
    try {
      await browser.runtime.sendMessage({ type: "queue-lock" });
      locked = true;
    } catch (err) {
      // No background context to coordinate with (it was reloaded, or the
      // extension is shutting down). Proceeding unlocked is what the code did
      // before the lock existed -- better than dropping a decision the user
      // just made.
      console.warn("Tab Decider: queue lock unavailable, proceeding unlocked", err);
    }
    try {
      return await fn();
    } finally {
      if (locked) {
        try {
          await browser.runtime.sendMessage({ type: "queue-unlock" });
        } catch (err) {
          // Background is gone; its watchdog would have released this anyway.
        }
      }
    }
  };
  pageQueueWrite = pageQueueWrite.catch(() => {}).then(run);
  return pageQueueWrite;
}

// Re-reads storage right before writing (rather than trusting the entry
// captured earlier) since the queue can have changed since -- most often
// because background.js pruned a tab closed outside the extension.
async function finalizeDecision(entry, action) {
  await withQueueLock(async () => {
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
  });
  await render();
}

// Queue entries hold the URL captured when the queue was built, so a tab
// that navigated since then could be matched as a duplicate on a URL it no
// longer has. Closing is destructive, so confirm against the live tab first
// -- a stale match then costs nothing worse than a skipped row.
//
// The two non-close outcomes are NOT the same and mustn't be collapsed into
// one falsy value: "mismatch" is a live tab the user hasn't decided on, so it
// stays in the queue, while "gone" is proof the entry is dead and should be
// pruned (see closeMatchesInParallel).
/**
 * @param {number} tabId
 * @param {string} expectedUrl
 * @returns {Promise<CloseResult>}
 */
async function closeTabIfStillMatching(tabId, expectedUrl) {
  let live;
  try {
    live = await browser.tabs.get(tabId);
  } catch {
    return "gone";
  }

  if (live.url !== expectedUrl) {
    console.warn("Tab Decider: skipping close, tab no longer matches", { tabId, expectedUrl, actual: live.url });
    return "mismatch";
  }

  try {
    await browser.tabs.remove(tabId);
    return "closed";
  } catch (err) {
    // The tab existed a moment ago, so this is a genuine failure rather than
    // a stale entry -- leave it in the queue and say so.
    console.warn("Tab Decider: close failed", err);
    return "mismatch";
  }
}

// Drops a batch of entries from the queue in ONE read-modify-write, so a
// multi-tab prune can't lose updates to itself the way per-tab writes can.
// Mirrors finalizeDecision's cursor handling: entries removed from before the
// cursor shift it back, so it keeps pointing at the same logical entry.
/** @param {number[]} tabIds */
async function pruneFromQueue(tabIds) {
  const dead = new Set(tabIds);
  await withQueueLock(async () => {
    const { queue, cursor } = await browser.storage.session.get(["queue", "cursor"]);
    const entries = queue || [];
    const pos = cursor || 0;

    const nextQueue = entries.filter((e) => !dead.has(e.tabId));
    if (nextQueue.length === entries.length) return;

    const removedBeforeCursor = entries.filter((e, i) => i < pos && dead.has(e.tabId)).length;
    await browser.storage.session.set({
      queue: nextQueue,
      cursor: Math.max(0, pos - removedBeforeCursor),
    });
  });
}

/**
 * Closes a batch of duplicate matches concurrently rather than one round-trip
 * at a time -- with 20 duplicates the serial version meant 20 sequential
 * awaits. Each close still goes through closeTabIfStillMatching, so the
 * stale-URL guard is preserved; allSettled means one rejection can't abandon
 * the rest of the batch.
 *
 * Matches whose tab turned out to be already gone are pruned from the queue
 * here. Without that, a queue entry left behind by a lost onRemoved update
 * stayed a permanent phantom duplicate: it kept appearing in the panel and
 * every close attempt just re-logged "Invalid tab ID" until the browser
 * restarted. They're pruned but NOT reported as closed -- we didn't close
 * them, so they must not inflate duplicatesClosedTotal or the undo snapshot.
 * @param {DuplicateMatch[]} matches
 * @returns {Promise<ClosedItem[]>}
 */
async function closeMatchesInParallel(matches) {
  const results = await Promise.allSettled(
    matches.map((m) => closeTabIfStillMatching(m.tabId, m.url))
  );
  /** @type {ClosedItem[]} */
  const closed = [];
  /** @type {number[]} */
  const deadIds = [];
  results.forEach((result, i) => {
    if (result.status !== "fulfilled") return;
    if (result.value === "closed") {
      closed.push({ url: matches[i].url, title: matches[i].title, wasCurrent: false });
    } else if (result.value === "gone") {
      deadIds.push(matches[i].tabId);
    }
  });
  if (deadIds.length > 0) await pruneFromQueue(deadIds);
  return closed;
}

async function closeDuplicates() {
  const toClose = currentDuplicateMatches.filter((m) => m.checked);
  if (toClose.length === 0) return;

  const closedItems = await closeMatchesInParallel(toClose);

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

  const totalToClose = currentDuplicateMatches.length + 1; // + the current tab
  if (totalToClose > BULK_CONFIRM_THRESHOLD) {
    const confirmed = requestConfirm(
      els.duplicateThrowAllBtn,
      `Close ${totalToClose} tabs?`,
      `This closes ${totalToClose} tabs at once -- this one plus ${currentDuplicateMatches.length} duplicates. Click again to confirm.`
    );
    if (!confirmed) return;
  }

  const view = await getView();
  const entry = view.entry;
  if (!entry) return;

  const matches = currentDuplicateMatches.slice();
  const closedItems = [];

  try {
    await browser.tabs.remove(entry.tabId);
    closedItems.push({ url: entry.url, title: entry.title, wasCurrent: true });
  } catch (err) {
    console.warn("Tab Decider: throw-all failed on current tab", err);
  }
  const closedDuplicates = await closeMatchesInParallel(matches);
  closedItems.push(...closedDuplicates);
  const duplicatesClosedCount = closedDuplicates.length;

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
  // Reorders the whole queue, so the view it works from has to be read under
  // the lock -- reordering a stale copy would reinstate any entry the
  // background pruned while we were computing the new order.
  const moved = await withQueueLock(async () => {
    const view = await getView();
    const entries = view.entries.slice();
    const pos = view.queueIndex; // full-queue index, not the filtered position
    const entry = view.entry;
    const key = entry && getKey(entry);
    if (!entry || pos < 0 || !key) return null;

    const siblingIndexes = [];
    entries.forEach((e, i) => {
      if (i !== pos && getKey(e) === key) siblingIndexes.push(i);
    });
    if (siblingIndexes.length === 0) return null;

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
    return { count: siblings.length, entry };
  });

  if (!moved) return;

  await render();
  showNotice(
    `Moved ${moved.count} tab${moved.count === 1 ? "" : "s"} from ${describeGroup(moved.entry)} to review right after this one.`
  );
}

async function bumpDomainSiblings() {
  await bumpSiblingsBy((e) => e.domain, (e) => e.domain);
}

async function bumpRepoSiblings() {
  await bumpSiblingsBy((e) => e.repoKey, (e) => repoDisplayLabel(e.repoKey));
}

// --- Filter (10B) -------------------------------------------------------
//
// `cursor` deliberately remains an index into the FULL queue, not the
// filtered view. Keeping one canonical coordinate space means decisions,
// bumping, undo and background.js's onRemoved pruning all keep working
// unchanged -- only display and navigation are translated into filtered
// space. The alternative (cursor indexes the filtered list) would have made
// every one of those paths filter-aware.
//
// matchIndices is the bridge: an ascending array of full-queue indices that
// match the current filter. Position "#3 of 47" means matchIndices[2].

function matchesFilter(entry, lowerQuery) {
  return (
    entry.title.toLowerCase().includes(lowerQuery) ||
    entry.url.toLowerCase().includes(lowerQuery)
  );
}

function computeMatchIndices(entries, query) {
  if (!query) return null; // null = no filter active, whole queue is the view
  const q = query.toLowerCase();
  const indices = [];
  for (let i = 0; i < entries.length; i++) {
    if (matchesFilter(entries[i], q)) indices.push(i);
  }
  return indices;
}

// Where the cursor sits within the filtered view. If the cursor's entry
// doesn't itself match (very common -- you filter while parked on a
// non-matching tab), snap forward to the next match so the view lands
// somewhere sensible instead of nowhere.
function resolveViewPosition(matchIndices, cursor) {
  if (matchIndices.length === 0) return -1;
  const exact = matchIndices.indexOf(cursor);
  if (exact !== -1) return exact;
  for (let i = 0; i < matchIndices.length; i++) {
    if (matchIndices[i] >= cursor) return i;
  }
  return matchIndices.length - 1;
}

// Single place that resolves "what is the user actually looking at right
// now", so render() and every navigation path agree.
async function getView() {
  const { queue, cursor, filterQuery } = await readSessionState();
  const entries = queue;
  const query = filterQuery;
  const rawCursor = cursor;

  const matchIndices = computeMatchIndices(entries, query);
  if (matchIndices === null) {
    const pos = entries.length === 0 ? -1 : Math.max(0, Math.min(rawCursor, entries.length - 1));
    return {
      entries, query, matchIndices: null,
      viewSize: entries.length,
      viewPos: pos,
      queueIndex: pos,
      entry: pos === -1 ? null : entries[pos],
    };
  }

  const viewPos = resolveViewPosition(matchIndices, rawCursor);
  const queueIndex = viewPos === -1 ? -1 : matchIndices[viewPos];
  return {
    entries, query, matchIndices,
    viewSize: matchIndices.length,
    viewPos,
    queueIndex,
    entry: queueIndex === -1 ? null : entries[queueIndex],
  };
}

// Moves within the CURRENT view (filtered or not), then writes the result
// back as a full-queue cursor index.
async function setViewPosition(newViewPos) {
  const view = await getView();
  if (view.viewSize === 0) return;
  const clamped = Math.max(0, Math.min(newViewPos, view.viewSize - 1));
  const queueIndex = view.matchIndices === null ? clamped : view.matchIndices[clamped];
  await browser.storage.session.set({ cursor: queueIndex });
  await render();
}

async function stepCursor(delta) {
  const view = await getView();
  if (view.viewPos === -1) return;
  await setViewPosition(view.viewPos + delta);
}

async function jumpToInput() {
  const raw = parseInt(els.jumpInput.value, 10);
  if (Number.isNaN(raw)) return;
  await setViewPosition(raw - 1); // input is shown/entered as 1-based
}

let filterDebounceTimer = null;

// Debounced: at ~1,900 entries, re-filtering and re-rendering on every
// keystroke is enough work to feel laggy while typing.
function onFilterInput() {
  clearTimeout(filterDebounceTimer);
  filterDebounceTimer = setTimeout(async () => {
    await browser.storage.session.set({ filterQuery: els.filterInput.value.trim() });
    await render();
  }, 150);
}

async function clearFilter() {
  clearTimeout(filterDebounceTimer);
  els.filterInput.value = "";
  await browser.storage.session.set({ filterQuery: "" });
  await render();
}

async function peekCurrent() {
  const view = await getView();
  const entry = view.entry;
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

// Page-level shortcuts, deliberately NOT manifest commands. Manifest
// commands are global (they fire from any tab), which is exactly why Keep
// and Throw need them -- you press those while looking at a peeked tab.
// Peek, stepping, undo and filtering are only ever used while you're
// already on this page, so plain keydown handling works: no manifest
// changes, no OS-level shortcut conflicts, and no cap on how many.
function onPageKeydown(e) {
  // Never hijack typing, and leave OS/browser combos alone.
  const tag = e.target && e.target.tagName;
  const isTyping = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || e.target.isContentEditable;

  if (e.key === "Escape") {
    if (pendingConfirm) {
      disarmConfirm();
      clearNotice();
      e.preventDefault();
      return;
    }
    if (isTyping && e.target === els.filterInput) {
      clearFilter();
      els.filterInput.blur();
      e.preventDefault();
    }
    return;
  }

  if (isTyping) return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;

  switch (e.key) {
    case "/":
      els.filterInput.focus();
      els.filterInput.select();
      e.preventDefault();
      break;
    case "Enter":
      if (!els.keepBtn.disabled) runExclusive(() => decide("keep"));
      e.preventDefault();
      break;
    case "x":
    case "X":
      if (!els.throwBtn.disabled) runExclusive(() => decide("throw"));
      e.preventDefault();
      break;
    case "p":
    case "P":
      if (!els.peekBtn.disabled) runExclusive(peekCurrent);
      e.preventDefault();
      break;
    case "u":
    case "U":
      if (!els.noticeUndoBtn.hidden) runExclusive(undoLastClose);
      e.preventDefault();
      break;
    case "ArrowRight":
      stepCursor(e.shiftKey ? 10 : 1);
      e.preventDefault();
      break;
    case "ArrowLeft":
      stepCursor(e.shiftKey ? -10 : -1);
      e.preventDefault();
      break;
    default:
      break;
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
  // runtime.onMessage is a trust boundary even with no content scripts and
  // nothing externally connectable. Without the action whitelist, a message
  // like {type:"decide", action:"anything"} fell straight through decide()'s
  // keep/throw branches into finalizeDecision() -- silently dropping the
  // entry from the queue and writing a bogus history record WITHOUT ever
  // discarding or closing the tab.
  browser.runtime.onMessage.addListener((message, sender) => {
    if (!sender || sender.id !== browser.runtime.id) return;
    if (!message || typeof message !== "object") return;
    if (message.type !== "decide") return;
    if (!DECISION_ACTIONS.has(message.action)) {
      console.warn("Tab Decider: ignoring unsupported decision action", message.action);
      return;
    }
    return runExclusive(() => decide(message.action));
  });

  els.resetBtn.addEventListener("click", () => runExclusive(handleResetClick));
  // No confirm needed here: the summary only appears once the queue is
  // already empty, so there's no in-progress review left to lose.
  els.summaryRestartBtn.addEventListener("click", () => runExclusive(rebuildAndRender));
  els.noticeUndoBtn.addEventListener("click", () => runExclusive(undoLastClose));

  els.settingsToggleBtn.addEventListener("click", () => {
    const opening = els.settingsPanel.hidden;
    els.settingsPanel.hidden = !opening;
    els.settingsToggleBtn.setAttribute("aria-expanded", String(opening));
    if (opening) {
      els.settingIncludePinned.focus();
    } else {
      // Focus would otherwise be left on a now-hidden control and fall back
      // to document.body, stranding keyboard users.
      els.settingsToggleBtn.focus();
    }
  });
  els.settingIncludePinned.addEventListener("change", saveSettingsFromUI);
  els.settingSortOrder.addEventListener("change", saveSettingsFromUI);

  els.peekBtn.addEventListener("click", () => runExclusive(peekCurrent));
  els.keepBtn.addEventListener("click", () => runExclusive(() => decide("keep")));
  els.throwBtn.addEventListener("click", () => runExclusive(() => decide("throw")));

  els.duplicateCloseBtn.addEventListener("click", () => runExclusive(closeDuplicates));
  els.duplicateThrowAllBtn.addEventListener("click", () => runExclusive(throwAllDuplicates));
  els.domainBumpBtn.addEventListener("click", () => runExclusive(bumpDomainSiblings));
  els.repoBumpBtn.addEventListener("click", () => runExclusive(bumpRepoSiblings));

  els.stepBack10.addEventListener("click", () => stepCursor(-10));
  els.stepBack1.addEventListener("click", () => stepCursor(-1));
  els.stepFwd1.addEventListener("click", () => stepCursor(1));
  els.stepFwd10.addEventListener("click", () => stepCursor(10));
  els.jumpBtn.addEventListener("click", jumpToInput);
  els.jumpInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") jumpToInput();
  });

  els.filterInput.addEventListener("input", onFilterInput);
  els.filterClearBtn.addEventListener("click", clearFilter);
  document.addEventListener("keydown", onPageKeydown);
}

init().catch((error) => {
  // Without this, a failure in init leaves the page sitting on "Loading..."
  // forever with no indication that anything went wrong.
  console.error("Tab Decider failed to initialise", error);
  const progress = document.getElementById("progress");
  if (progress) {
    progress.textContent = "Tab Decider could not start -- see the browser console for details.";
  }
});
