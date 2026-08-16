// Booru Bookmark - popup.js

const STORAGE_PFX = "booru_bm_";

// Read a single site's bookmarks, sync first (cross-device), then falling back
// to the legacy local area so pre-sync bookmarks still show a correct count.
const isTombstone = (e) => !!(e && typeof e === "object" && e.deleted);
const entryTime   = (e) => (!e || typeof e !== "object") ? 0
                         : (e.deleted ? (e.at || 0) : (e.addedAt || 0));

// Merge the two areas the same way the content script does, so the popup shows
// the same set the page does. Removed entries are tombstones, not absences, so
// they are filtered out of the count.
function mergeSets(a, b) {
  const out = {};
  for (const k of new Set([...Object.keys(a || {}), ...Object.keys(b || {})])) {
    const ea = a && a[k], eb = b && b[k];
    if (ea === undefined) out[k] = eb;
    else if (eb === undefined) out[k] = ea;
    else out[k] = entryTime(eb) > entryTime(ea) ? eb : ea;
  }
  return out;
}

async function readSiteRaw(storageKey) {
  let sync = null, local = null;
  try { const s = await chrome.storage.sync.get(storageKey);  if (s && (storageKey in s)) sync = s[storageKey] || {}; } catch (_) {}
  try { const l = await chrome.storage.local.get(storageKey); if (l && (storageKey in l)) local = l[storageKey] || {}; } catch (_) {}
  if (sync === null) return local || {};
  const legacyCleared = Object.keys(sync).length === 0 &&
    local && Object.values(local).every(v => entryTime(v) === 0);
  return legacyCleared ? {} : mergeSets(sync, local);
}

async function readSite(storageKey) {
  const raw = await readSiteRaw(storageKey);
  const out = {};
  for (const [k, v] of Object.entries(raw)) if (!isTombstone(v)) out[k] = v;
  return out;
}

// Clear sites by writing an EMPTY OBJECT (a tombstone) to sync and emptying the
// local mirror. The tombstone makes a deliberate clear distinguishable from a
// storage purge: reads treat a present-but-empty sync key as authoritative, so
// a stale mirror on another device can never resurrect cleared bookmarks,
// while a truly absent key still lets the mirror restore after a purge.
async function clearEverywhere(keys) {
  const arr = Array.isArray(keys) ? keys : [keys];
  if (!arr.length) return;
  const now = Date.now();
  const payload = {};
  for (const k of arr) {
    // Tombstone every entry individually rather than writing an empty object.
    // A merge on another device would otherwise treat this device's blank set
    // as "knows nothing" and hand the cleared bookmarks straight back.
    const raw = await readSiteRaw(k);
    const cleared = {};
    for (const id of Object.keys(raw)) cleared[id] = { deleted: true, at: now };
    payload[k] = cleared;
  }
  try { await chrome.storage.sync.set(payload); }  catch (_) {}
  try { await chrome.storage.local.set(payload); } catch (_) {}
}

// Collect every booru_bm_ key present in either area.
async function allSiteKeys() {
  const keys = new Set();
  try {
    const s = await chrome.storage.sync.get(null);
    Object.keys(s).forEach(k => { if (k.startsWith(STORAGE_PFX)) keys.add(k); });
  } catch (_) {}
  try {
    const l = await chrome.storage.local.get(null);
    Object.keys(l).forEach(k => { if (k.startsWith(STORAGE_PFX)) keys.add(k); });
  } catch (_) {}
  return [...keys];
}

(async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  const siteNameEl = document.getElementById("site-name");
  const bmCountEl  = document.getElementById("bm-count");
  const emptyEl    = document.getElementById("empty-state");
  const btnJump    = document.getElementById("btn-jump");

  if (!tab?.url) {
    siteNameEl.textContent = "No active tab";
    bmCountEl.textContent  = "0";
    btnJump.disabled = true;
    return;
  }

  let url;
  try { url = new URL(tab.url); } catch { return; }

  siteNameEl.textContent = url.hostname.replace(/^www\./, "");

  const storageKey = STORAGE_PFX + url.origin;
  const stored     = await readSite(storageKey);
  const count      = Object.keys(stored).length;

  bmCountEl.textContent = count;
  if (count === 0) {
    emptyEl.style.display = "flex";
    btnJump.disabled = true;
  }

  // Jump to bookmark - sends message to content script then closes popup
  // so the user can see the page scroll to the bookmarked thumbnail.
  btnJump.addEventListener("click", () => {
    chrome.tabs.sendMessage(tab.id, { type: "JUMP_TO_BOOKMARK" }).catch(() => {});
    window.close();
  });

  // Clear this site's bookmarks (both areas)
  document.getElementById("btn-clear-page").addEventListener("click", async () => {
    await clearEverywhere(storageKey);
    chrome.tabs.sendMessage(tab.id, { type: "CLEAR_ALL" }).catch(() => {});
    bmCountEl.textContent = "0";
    emptyEl.style.display = "flex";
    btnJump.disabled = true;
  });

  // Clear ALL bookmarks across every booru site (both areas)
  document.getElementById("btn-clear-all").addEventListener("click", async () => {
    const keys = await allSiteKeys();
    await clearEverywhere(keys);
    chrome.tabs.sendMessage(tab.id, { type: "CLEAR_ALL" }).catch(() => {});
    bmCountEl.textContent = "0";
    emptyEl.style.display = "flex";
    btnJump.disabled = true;
  });
})();
