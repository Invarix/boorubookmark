// Booru Bookmark content.js

(function () {
  "use strict";

  // Guard: if the extension context is invalidated (e.g. after an update),
  // chrome.runtime is undefined or disconnected. Bail out silently.
  if (typeof chrome === "undefined" || !chrome.runtime?.sendMessage) return;

  // Post-link URL patterns shared by every booru running a given engine.
  // Matching on these covers all sites on that engine, present and future
  // without naming individual boorus. Five engine families cover the vast
  // majority of boorus in existence:
  //   Gelbooru family   index.php?page=post&s=view&id=N   (Gelbooru, Safebooru,
  //                                                         rule34.xxx, booru.org)
  //   Danbooru family   /posts/N                          (Danbooru, e621)
  //   Shimmie2          /post/view/N                      (paheal, Pixboard)
  //   Moebooru          /post/show/N                      (yande.re, konachan)
  //   Philomena         /images/N                         (derpibooru, furbooru)
  const POST_LINK_PATTERNS = [
    /[?&]s=view&(amp;)?id=\d+/i,   // Gelbooru-family (also matches s=view&amp;id=)
    /[?&]id=\d+/i,                  // Gelbooru-family loose (id param on a post link)
    /\/posts?\/\d+/i,               // Danbooru-family /posts/N (and /post/N)
    /\/post\/view\/\d+/i,           // Shimmie2
    /\/post\/show\/\d+/i,           // Moebooru
    /\/images\/\d+/i,               // Philomena
  ];

  // Returns true if an <a href> looks like a booru post permalink.
  function isPostLink(href) {
    if (!href) return false;
    // Gelbooru post links must also be on a post page (page=post), to avoid
    // matching unrelated ?id= links elsewhere on a site.
    if (/[?&]id=\d+/i.test(href) && !/[?&]s=view/i.test(href)) {
      return /page=post/i.test(href);
    }
    return POST_LINK_PATTERNS.some(re => re.test(href));
  }

  function looksLikeBooru() {
    // 1. Engine identity in meta tags (fast path for engines that set them)
    const appName = document.querySelector('meta[name="application-name"]')
                             ?.content?.toLowerCase() || "";
    if (appName && /danbooru|booru|shimmie|gelbooru|moebooru|szurubooru|philomena/.test(appName))
      return true;
    const generator = document.querySelector('meta[name="generator"]')
                               ?.content?.toLowerCase() || "";
    if (generator && /shimmie|danbooru|booru/.test(generator)) return true;

    // 2. Danbooru body class
    if (document.body?.classList?.contains("c-posts")) return true;

    // 3. Engine-specific markers
    if (document.querySelector(".shm-thumb, [data-post-id], #shm-tag-list")) return true;

    // 4. Universal: a cluster of thumbnail links matching a known post-link
    //    pattern. This is the catch-all that covers Gelbooru/booru.org sites,
    //    Moebooru, Philomena, and any engine whose thumbnails are <a><img>.
    //    Require at least 3 such links so a single stray link doesn't trigger.
    let postLinkCount = 0;
    for (const a of document.querySelectorAll("a[href] > img, a[href] img")) {
      if (isPostLink(a.closest("a[href]")?.getAttribute("href"))) {
        if (++postLinkCount >= 3) return true;
      }
    }

    return false;
  }

  if (!looksLikeBooru()) return;

  function signalBooru() {
    try {
      chrome.runtime.sendMessage({ type: "IS_BOORU" }).catch(() => {});
    } catch (_) {}
  }
  signalBooru();

  const BOOKMARK_CLASS = "booru-bookmark-active";
  const PULSE_CLASS    = "booru-bookmark-pulse";
  const BM_ATTR        = "data-booru-bm-id";
  const STORAGE_KEY    = "booru_bm_" + location.origin;

  let _lastTarget    = null;
  let _mutingObs     = false;
  let _jumpIndex     = -1;
  let _pendingJumpId = null;
  let _pendingTimer  = null; // timeout to navigate if pending jump never resolves
  let _jumpInFlight  = false; // true while a cross-page search is running
  // True for a short window after page load, during which a zero local bookmark
  // count might still be resolved by an incoming cross-device sync. Drives the
  // nav button's "Bookmark Sync in Progress" state. Opened at load, closed once
  // the sync window elapses.
  // The cross-device sync wait should appear only on the FIRST page a user
  // opens on this device in this browsing session, not on every page they click
  // through. sessionStorage is per-tab and per-origin and clears when the
  // session ends, so a flag there distinguishes "just arrived on this site" from
  // "casually paging through the index". Once consumed, the syncing state never
  // shows again until a new session.
  const SYNC_SEEN_KEY = "booru_bm_sync_window_used";
  let _withinSyncWindow = (() => {
    try {
      if (sessionStorage.getItem(SYNC_SEEN_KEY)) return false; // already used this session
      return true;
    } catch (_) {
      return false; // if sessionStorage is unavailable, never show the wait
    }
  })();

  // ── True page URL detection ───────────────────────────────────────────────
  // location.href is unreliable for storing the bookmark's page boorus
  // often update it asynchronously after the page loads (e.g. adding tags=,
  // changing page numbers, etc.). We read the canonical URL from the page
  // itself, which is always accurate.

  function getTruePageUrl() {
    // Prefer the live location.href when it's a real listing URL, it always
    // reflects the page you're actually on. Some engines (modern Danbooru) set
    // <link rel="canonical"> to the bare site root on the index, which would
    // lose the /posts listing path, so we don't trust canonical blindly.
    const here = (() => { try { return new URL(location.href); } catch { return null; } })();
    if (here && /\/(post\/list|posts?|index\.php)/i.test(here.pathname + here.search)) {
      return location.href;
    }

    // 1. <link rel="canonical"> only trust it if it carries a listing path.
    const canonical = document.querySelector('link[rel="canonical"]');
    if (canonical?.href) {
      try {
        const cu = new URL(canonical.href);
        if (/\/(post\/list|posts?|index\.php)/i.test(cu.pathname + cu.search)) {
          return canonical.href;
        }
      } catch (_) {}
    }

    // 2. Paginator current page link (e621/Danbooru style)
    //    <span class="page current"> with adjacent <a> links
    //    or prev/next links let us reconstruct the current page URL
    const paginatorNav = document.querySelector('nav.pagination, #paginator, .pagination');
    if (paginatorNav) {
      // Try the current page span's surrounding context if there's a
      // data-current attribute, combine with the next/prev link to get the URL
      const nextLink = document.querySelector('#paginator-next[href], a#paginator-next, nav.pagination a.next');
      const prevLink = document.querySelector('#paginator-prev[href], a#paginator-prev, nav.pagination a.prev');
      const currentData = paginatorNav.dataset?.current;

      if (nextLink?.href && currentData) {
        // Next link is for page N+1; current page is N
        // Replace the page number in the next URL with current page number
        try {
          const url = new URL(nextLink.href);
          // Handle ?page=N query param style
          if (url.searchParams.has('page')) {
            url.searchParams.set('page', currentData);
            return url.toString();
          }
          // Handle /page/N path style (Shimmie2)
          const pathWithPage = url.pathname.replace(/\/\d+\/?$/, '/' + currentData);
          if (pathWithPage !== url.pathname) {
            url.pathname = pathWithPage;
            return url.toString();
          }
        } catch (_) {}
      }

      if (prevLink?.href && currentData) {
        // Prev link is for page N-1; current page is N
        try {
          const url = new URL(prevLink.href);
          if (url.searchParams.has('page')) {
            url.searchParams.set('page', currentData);
            return url.toString();
          }
          const pathWithPage = url.pathname.replace(/\/\d+\/?$/, '/' + currentData);
          if (pathWithPage !== url.pathname) {
            url.pathname = pathWithPage;
            return url.toString();
          }
        } catch (_) {}
      }
    }

    // 3. Fall back to location.href
    return location.href;
  }

  // ── Storage ────────────────────────────────────────────────────────────────

  // isExtensionAlive checks whether chrome.storage/runtime are still usable.
  // The extension context can be invalidated mid-session (e.g. the user
  // updates or reloads the extension while this tab stays open). Once that
  // happens, every chrome.* call throws synchronously. All Promise-returning
  // wrappers below guard against this so the page never crashes, they just
  // resolve to empty/no-op results, which silently disables the extension's
  // functionality on this tab until the page is refreshed.

  function isExtensionAlive() {
    try {
      return !!(chrome?.runtime?.id && chrome?.storage?.local);
    } catch (_) {
      return false;
    }
  }

  // Bookmarks live in chrome.storage.sync so they can follow the user across
  // devices where the browser supports syncing extension data, carried by the
  // browser's own encrypted sync (never sent to the developer). sync uses the
  // same "storage" permission as local, so this needs no extra permission.
  //
  // WRITE-THROUGH MIRRORING: every save writes the same data to BOTH sync and
  // local. The local copy is a persistent on-device backup and is never
  // deleted. This matters because browsers can purge an extension's sync area
  // (some browsers do not round-trip extension data through their sync service
  // at all, and unpacked developer builds have no cloud copy), and a purge must
  // never cost the user their bookmarks.
  //
  // TOMBSTONES: a deliberate clear writes an EMPTY OBJECT to sync rather than
  // removing the key. That makes a purge (key absent) distinguishable from a
  // clear (key present, empty). Reads treat a present key as authoritative,
  // even when empty, so a stale mirror can never resurrect bookmarks the user
  // deliberately deleted. Only when the key is entirely absent from sync does
  // the local mirror restore, which is exactly the purge/fresh-install case
  // where restoring is what the user wants.
  //
  // _loadedFromLocal records that this read came from the mirror (sync had no
  // key), so init re-promotes the mirror to sync once.
  let _loadedFromLocal = false;

  // _bookmarkStateKnown records whether THIS DEVICE has an authoritative answer
  // for this site, meaning a key exists in sync or in the local mirror. A key
  // exists as soon as the device has ever saved anything here, including an
  // empty object written by a deliberate clear (a tombstone). It is false only
  // when the device has genuinely never seen this site's bookmark data, which
  // is exactly the "second device visiting for the first time" case where
  // waiting for a cross-device sync makes sense.
  let _bookmarkStateKnown = false;

  function loadBookmarks() {
    return new Promise(res => {
      if (!isExtensionAlive()) { res({}); return; }
      try {
        chrome.storage.sync.get(STORAGE_KEY, d => {
          if (!chrome.runtime.lastError && d && (STORAGE_KEY in d)) {
            // Key present in sync: authoritative, even if empty (tombstone).
            _loadedFromLocal = false;
            _bookmarkStateKnown = true;
            res(d[STORAGE_KEY] || {});
            return;
          }
          // Key absent from sync (fresh device, purge, or sync unavailable):
          // fall back to the on-device mirror and flag for re-promotion.
          try {
            chrome.storage.local.get(STORAGE_KEY, l => {
              if (chrome.runtime.lastError) { res({}); return; }
              // A mirror key existing at all is also authoritative knowledge:
              // this device has saved here before, so zero really means zero.
              _bookmarkStateKnown = (STORAGE_KEY in l);
              const mirror = l[STORAGE_KEY] || {};
              _loadedFromLocal = Object.keys(mirror).length > 0;
              res(mirror);
            });
          } catch (_) { res({}); }
        });
      } catch (_) {
        res({});
      }
    });
  }

  function saveBookmarks(obj) {
    return new Promise(res => {
      if (!isExtensionAlive()) { res(); return; }
      try {
        chrome.storage.sync.set({ [STORAGE_KEY]: obj }, () => {
          // Regardless of the sync write's outcome (it can fail on quota),
          // ALWAYS write the local mirror so the data survives on this device.
          void chrome.runtime.lastError; // consume; sync failure is non-fatal
          try {
            chrome.storage.local.set({ [STORAGE_KEY]: obj }, () => res());
          } catch (_) { res(); }
        });
      } catch (_) {
        // sync API itself unavailable: still persist locally.
        try { chrome.storage.local.set({ [STORAGE_KEY]: obj }, () => res()); }
        catch (_) { res(); }
      }
    });
  }

  // One-time migration: older versions stored the same post under different key
  // formats (did:N, pid:N, eid:N, or href:...id=N) depending on render timing,
  // which could leave a single post recorded as two separate bookmarks. Collapse
  // any legacy numeric-bearing key into the canonical "num:N" form and merge
  // duplicates, keeping the entry that has the most complete value.
  function migrateBookmarkKeys(stored) {
    let changed = false;
    const out = {};

    const numFromKey = (key) => {
      let m;
      if ((m = key.match(/^num:(\d+)$/)))                 return m[1];
      if ((m = key.match(/^(?:did|pid|eid):(\d+)$/)))     return m[1];
      if ((m = key.match(/[?&]id=(\d+)/)))                return m[1]; // href:...&id=N
      if ((m = key.match(/\/posts?\/(\d+)/)))             return m[1];
      if ((m = key.match(/\/post\/(?:view|show)\/(\d+)/))) return m[1];
      if ((m = key.match(/\/images\/(\d+)/)))             return m[1];
      return null;
    };

    const valueRichness = (v) => {
      if (v && typeof v === "object") return (v.page ? 1 : 0) + (v.post ? 1 : 0);
      if (typeof v === "string") return 0.5;
      return 0;
    };

    for (const [key, val] of Object.entries(stored)) {
      const num = numFromKey(key);
      const canonical = num ? "num:" + num : key;
      if (canonical !== key) changed = true;

      if (!(canonical in out)) {
        out[canonical] = val;
      } else {
        // Duplicate - keep the richer value (one with page + post info)
        if (valueRichness(val) > valueRichness(out[canonical])) out[canonical] = val;
        changed = true;
      }
    }
    return { migrated: out, changed };
  }

  // ── Container & ID resolution ──────────────────────────────────────────────

  // Extract a numeric post ID purely from an anchor's href. Unlike getPostId,
  // this deliberately ignores the anchor's own id attribute, which on some
  // engines carries unrelated numbers (e.g. id="delete_99", "post-vote-up-12")
  // that must NOT be mistaken for a post ID when we're inspecting the links
  // inside a wrapper.
  function postIdFromAnchorHref(a) {
    const href = a?.getAttribute?.("href");
    if (!href) return null;
    let m;
    if ((m = href.match(/[?&]id=(\d+)/i))) {
      // Gelbooru id= only counts on an actual post-view link, not list/pool links
      if (/s=view|page=post/i.test(href)) return "num:" + m[1];
    }
    if ((m = href.match(/\/posts\/(\d+)(?:[/?#]|$)/i)))      return "num:" + m[1]; // Danbooru /posts/N
    if ((m = href.match(/\/post\/view\/(\d+)(?:[/?#]|$)/i))) return "num:" + m[1]; // Shimmie2 /post/view/N
    if ((m = href.match(/\/post\/show\/(\d+)(?:[/?#]|$)/i))) return "num:" + m[1]; // Moebooru /post/show/N
    if ((m = href.match(/\/images\/(\d+)(?:[/?#]|$)/i)))     return "num:" + m[1]; // Philomena /images/N
    return null; // /post/delete/N, /post/list/tag/N, votes, etc. are NOT posts
  }

  // A real thumbnail wrapper corresponds to exactly one post. A page-level
  // container (post list, content column) corresponds to many. We distinguish
  // them by counting DISTINCT POST IDs reachable via post-permalink hrefs. We
  // ignore images, navigation/tag links, and anchor id attributes, so a single
  // captioned thumbnail (with tag links, vote/flag/delete links, icon images)
  // is never mistaken for a multi-post container.
  function isSinglePostWrapper(node) {
    if (!node || !node.querySelectorAll) return true; // an <img> itself qualifies
    const anchors = node.querySelectorAll("a[href]");
    const distinctPosts = new Set();
    for (const a of anchors) {
      const id = postIdFromAnchorHref(a); // href-only: only true post permalinks
      if (id) {
        distinctPosts.add(id);
        if (distinctPosts.size > 1) return false;
      }
    }
    return true;
  }

  // True only for elements that are genuine single-post thumbnail wrappers,
  // never page-level containers. Used by every code path that applies or
  // searches for a bookmark so the border can only ever land on a thumbnail.
  function isThumbWrapper(node) {
    if (!node) return false;
    // Never treat anything inside a transient hover overlay as a thumbnail.
    // Some engines show a floating preview card when a thumbnail is hovered,
    // and that card contains vote/score widgets stamped with the post's own
    // numeric id. Those widgets would otherwise match a bookmarked post and
    // get bordered. Real index thumbnails are never mounted inside a floating
    // tooltip container, so excluding overlay subtrees is safe on every engine.
    // Covers tippy.js (div[data-tippy-root] > .tippy-box), jQuery UI, and
    // generic role="tooltip" containers.
    if (node.closest?.('[data-tippy-root], .tippy-box, [role="tooltip"], .ui-tooltip')) {
      return false;
    }
    const tag = node.tagName?.toLowerCase();
    const cls = node.classList;
    const ds  = node.dataset;
    const numericDataId =
      (ds?.postId && /^\d+$/.test(ds.postId)) ||
      (ds?.id     && /^\d+$/.test(ds.id));
    const matches =
      tag === "article"                          ||
      numericDataId                              ||
      (tag === "span" && cls?.contains("thumb")) ||
      (tag === "li"   && (cls?.contains("thumb") || cls?.contains("shm-thumb"))) ||
      cls?.contains("shm-thumb")                ||
      cls?.contains("post-preview")             ||
      cls?.contains("thumbnail-preview");
    return matches && isSinglePostWrapper(node);
  }

  function getBestContainer(startEl) {
    let node = startEl;
    for (let i = 0; i < 12; i++) {
      if (!node || node === document.body) break;
      if (node.hasAttribute(BM_ATTR)) return node;
      if (isThumbWrapper(node)) return node;
      node = node.parentElement;
    }
    // No recognised wrapper - fall back to the <img> itself (bare-img boorus).
    const img = startEl.tagName?.toLowerCase() === "img"
      ? startEl : startEl.closest?.("img");
    return img || startEl.parentElement || startEl;
  }

  function getPostId(container) {
    // Pull a stable numeric post id out of a post-link href, covering all
    // engine families so the same post always maps to the same storage key.
    const idFromHref = (href) => {
      if (!href) return null;
      let m;
      if ((m = href.match(/[?&]id=(\d+)/i)))        return m[1]; // Gelbooru
      if ((m = href.match(/\/posts?\/(\d+)/i)))     return m[1]; // Danbooru
      if ((m = href.match(/\/post\/view\/(\d+)/i))) return m[1]; // Shimmie2
      if ((m = href.match(/\/post\/show\/(\d+)/i))) return m[1]; // Moebooru
      if ((m = href.match(/\/images\/(\d+)/i)))     return m[1]; // Philomena
      return null;
    };

    // Canonical key: the numeric post ID, normalised to "num:N" no matter which
    // source it came from. This is CRITICAL. On some boorus the same post can
    // be identified via data-id, an element id, OR its link href depending on
    // render timing (e.g. deferred loaders that add data-id late). If those
    // produced different keys, one post could be stored as two bookmarks.
    // Collapsing every numeric source to "num:N" guarantees one post = one key.

    // 1. data-* numeric attributes
    const dataNum = container.dataset?.postId || container.dataset?.id;
    if (dataNum && /^\d+$/.test(dataNum)) return "num:" + dataNum;

    // 2. element id like "p12345" / "post_12345" / "12345"
    if (container.id) {
      const m = container.id.match(/^[a-z_]*?(\d+)$/i);
      if (m) return "num:" + m[1];
    }

    // 3. post-link href (covers bare <a><img> boorus and as a fallback)
    if (container.tagName?.toLowerCase() === "img") {
      const href = container.closest("a[href]")?.getAttribute("href");
      const n = idFromHref(href);
      if (n) return "num:" + n;
      const src = container.src || container.currentSrc;
      if (src && !src.startsWith("data:")) return "src:" + src;
      return null;
    }
    // If the element is itself an anchor, read its own href first.
    if (container.tagName?.toLowerCase() === "a") {
      const ownHref = container.getAttribute("href");
      const n = idFromHref(ownHref);
      if (n) return "num:" + n;
      if (ownHref) return "href:" + ownHref;
    }
    const innerHref = container.querySelector?.("a[href]")?.getAttribute("href");
    const n = idFromHref(innerHref);
    if (n) return "num:" + n;

    // 4. Non-numeric fallbacks (rare engines) keep stable per-post
    if (container.dataset?.postId) return "pid:" + container.dataset.postId;
    if (container.dataset?.id)     return "did:" + container.dataset.id;
    if (innerHref)                 return "href:" + innerHref;
    return null;
  }

  // Extract the post's own permalink from a container (e.g. /posts/12345).
  // This is the stable destination for the "open post page" fallback, unlike
  // the index page URL, a post's permalink never changes as the index reshuffles.
  function getPostLink(container) {
    // The first <a href> inside the container that looks like a post permalink
    const links = container.tagName?.toLowerCase() === "a"
      ? [container]
      : Array.from(container.querySelectorAll("a[href]"));
    // Also consider an enclosing <a> if the container is an <img>
    const enclosing = container.closest?.("a[href]");
    if (enclosing) links.unshift(enclosing);

    for (const a of links) {
      const href = a.getAttribute("href");
      if (!href) continue;
      // Common booru post permalink patterns:
      //   /posts/12345           (Danbooru / e621 family)
      //   /post/view/12345       (Shimmie2 / paheal)
      //   /index.php?page=post&s=view&id=12345  (Gelbooru)
      if (/\/post[s]?\/(view\/)?\d+/i.test(href)) return new URL(href, location.origin).href;
      if (/[?&]id=\d+/.test(href) && /s=view|page=post/.test(href))
        return new URL(href, location.origin).href;
    }
    return null;
  }

  function resolveFromElement(el) {
    const container = getBestContainer(el);
    const id        = getPostId(container);
    const imgEl     = container.tagName?.toLowerCase() === "img"
                    ? container : container.querySelector("img");
    const srcUrl    = imgEl?.src && !imgEl.src.startsWith("data:")
                    ? imgEl.src : (imgEl?.currentSrc || null);
    return { container, id, srcUrl };
  }

  // True when the current page is a single post's own page rather than an
  // index/listing. On a post page, the post's ID appears on many unrelated
  // elements (vote and score widgets, favorite buttons, comment sections), so
  // matching stored bookmarks against the DOM there borders random UI. The
  // bookmark border belongs only on index thumbnails, so restore and container
  // matching are disabled on post pages entirely.
  function isSinglePostPage() {
    const here = location.pathname + location.search;
    return (
      /\/posts\/\d+(?:[/?#]|$)/i.test(here) ||      // Danbooru family
      /\/post\/view\/\d+(?:[/?#]|$)/i.test(here) || // Shimmie2
      /\/post\/show\/\d+(?:[/?#]|$)/i.test(here) || // Moebooru
      /\/images\/\d+(?:[/?#]|$)/i.test(here) ||     // Philomena
      (/[?&]s=view/i.test(here) && /[?&]id=\d+/i.test(here)) // Gelbooru family
    );
  }

  function findContainerByPostId(postId) {
    if (isSinglePostPage()) return null; // post pages have no thumbnails to match
    const stamped = document.querySelector(`[${BM_ATTR}="${CSS.escape(postId)}"]`);
    if (stamped) return { container: stamped, id: postId };
    for (const el of document.querySelectorAll(
      "article, [data-post-id], [data-id], span.thumb, li.thumb, li.shm-thumb"
    )) {
      if (!isThumbWrapper(el)) continue; // skip page-level containers
      if (getPostId(el) === postId) return { container: el, id: postId };
    }
    for (const img of document.querySelectorAll("img")) {
      if (img.closest("article, [data-post-id], [data-id], span.thumb, li.thumb")) continue;
      if (getPostId(img) === postId) return { container: img, id: postId };
    }
    return null;
  }

  function findContainerBySrc(srcUrl) {
    for (const img of document.querySelectorAll("img")) {
      const srcs = new Set([img.src, img.currentSrc, img.dataset?.src]);
      const pic  = img.closest("picture");
      if (pic) {
        pic.querySelectorAll("source").forEach(s => {
          const first = (s.srcset || s.dataset?.srcset || "").split(/[\s,]+/)[0];
          if (first) srcs.add(first);
        });
      }
      if (srcs.has(srcUrl)) {
        const r = resolveFromElement(img);
        return r.id ? r : null;
      }
    }
    return null;
  }

  // ── Apply / remove bookmark visuals ───────────────────────────────────────

  function applyBookmark(container, id) {
    _mutingObs = true;
    try {
      container.setAttribute(BM_ATTR, id);
      container.classList.add(BOOKMARK_CLASS);
      container.classList.remove(PULSE_CLASS);
      void container.offsetWidth;
      container.classList.add(PULSE_CLASS);
      container.addEventListener("animationend",
        () => container.classList.remove(PULSE_CLASS), { once: true });
      const tag = container.tagName?.toLowerCase();
      if (tag === "img") {
        // Only <img> containers need display/position overrides for the outline
        // to render. Tagging them separately keeps us from touching the layout
        // of the booru's own wrapper elements (span.thumb, article, li), which
        // would break the page's grid (e.g. collapse it to one column).
        container.classList.add("booru-bookmark-img");
      }
      if (tag !== "img" && !container.querySelector(".booru-bookmark-label")) {
        const label       = document.createElement("span");
        label.className   = "booru-bookmark-label";
        label.textContent = "📌";
        label.title       = "Bookmarked - right-click to remove";
        container.appendChild(label);
      }
      if (tag !== "img" && getComputedStyle(container).position === "static")
        container.style.position = "relative";
    } finally {
      _mutingObs = false;
    }
  }

  function removeBookmark(container) {
    _mutingObs = true;
    try {
      container.classList.remove(BOOKMARK_CLASS, PULSE_CLASS, "booru-bookmark-img");
      container.removeAttribute(BM_ATTR);
      container.querySelector(".booru-bookmark-label")?.remove();
      if (container.style.position === "relative") container.style.position = "";
    } finally {
      _mutingObs = false;
    }
  }

  // ── Restore bookmarks ──────────────────────────────────────────────────────

  let _restoreTimer   = null;
  let _restoreRunning = false;

  function scheduleRestore() {
    if (_mutingObs) return;
    clearTimeout(_restoreTimer);
    _restoreTimer = setTimeout(runRestore, 100);
  }

  async function runRestore() {
    if (_restoreRunning) return;
    if (isSinglePostPage()) return; // borders belong only on index thumbnails
    _restoreRunning = true;
    try {
      const stored = await loadBookmarks();
      if (!Object.keys(stored).length) return;
      const applied = new Set();
      for (const el of document.querySelectorAll(
        "article, [data-post-id], [data-id], span.thumb, li.thumb, li.shm-thumb"
      )) {
        // Only apply to genuine single-post thumbnail wrappers. Page-level
        // containers can carry a data-id and resolve (via their first inner
        // post link) to a bookmarked post's ID without this guard the border
        // would wrap the entire index.
        if (!isThumbWrapper(el)) continue;
        const id = getPostId(el);
        if (id && stored[id] && !el.classList.contains(BOOKMARK_CLASS) && !applied.has(id)) {
          applyBookmark(el, id);
          applied.add(id);
          checkPendingJump(el, id);
        }
      }
      for (const img of document.querySelectorAll("img")) {
        if (img.closest("article, [data-post-id], [data-id], span.thumb, li.thumb")) continue;
        const id = getPostId(img);
        if (id && stored[id] && !img.classList.contains(BOOKMARK_CLASS) && !applied.has(id)) {
          applyBookmark(img, id);
          applied.add(id);
          checkPendingJump(img, id);
        }
      }
    } finally {
      _restoreRunning = false;
    }
  }

  // ── Nav button ─────────────────────────────────────────────────────────────
  //
  // The nav button has three states:
  //   - hidden:  no bookmarks for this site, or we are on a post page.
  //   - syncing: at page load the local count is 0, but bookmarks made on
  //              another device may still be arriving via browser sync. Rather
  //              than show nothing (which looks like "no bookmarks"), we show a
  //              non-clickable "Bookmark Sync in Progress" state for a short
  //              window. If synced data lands (the storage.onChanged listener
  //              fires), it flips to the navigate state; if the window passes
  //              with nothing, it hides (genuinely no bookmarks here).
  //   - navigate: "Navigate Bookmarks [N]", clickable, runs jumpToBookmark.
  const JUMP_STATE = { HIDDEN: "hidden", SYNCING: "syncing", NAVIGATE: "navigate" };
  let _jumpState = JUMP_STATE.HIDDEN;
  let _syncWindowTimer = null;
  // How long after load to keep showing "syncing" before giving up on a pending
  // cross-device sync and concluding there are simply no bookmarks here. Kept
  // short so a user who genuinely has no bookmarks sees only a brief flash.
  const SYNC_WAIT_MS = 4000;

  function getJumpToast() {
    let el = document.getElementById("booru-bookmark-jump-toast");
    if (!el) {
      el = document.createElement("div");
      el.id = "booru-bookmark-jump-toast";
      document.documentElement.appendChild(el);
      el.addEventListener("click", () => {
        // Only actionable in the navigate state; a click while syncing is a
        // no-op with a brief explanation.
        if (_jumpState === JUMP_STATE.SYNCING) {
          showToast("Waiting for bookmarks to sync from your other devices...", "info");
          return;
        }
        jumpToBookmark();
      });
    }
    if (el.parentElement !== document.documentElement)
      document.documentElement.appendChild(el);
    return el;
  }

  function showJumpToast() { getJumpToast().classList.add("visible"); }
  function hideJumpToast() {
    _jumpState = JUMP_STATE.HIDDEN;
    const el = document.getElementById("booru-bookmark-jump-toast");
    if (el) { el.classList.remove("visible"); el.classList.remove("syncing"); }
  }

  // Put the button into the navigate (clickable) state with the given count.
  function setJumpNavigate(count) {
    _jumpState = JUMP_STATE.NAVIGATE;
    const el = getJumpToast();
    el.classList.remove("syncing");
    el.textContent = `Navigate Bookmarks [${count}]`;
    el.classList.add("visible");
  }

  // Put the button into the syncing (non-clickable) state.
  function setJumpSyncing() {
    _jumpState = JUMP_STATE.SYNCING;
    const el = getJumpToast();
    el.classList.add("syncing");
    el.textContent = "Bookmark Sync in Progress";
    el.classList.add("visible");
  }

  // Backwards-compatible helper still used elsewhere.
  function updateJumpToastLabel(count) { setJumpNavigate(count); }

  async function refreshJumpToast() {
    // The navigate button belongs to index/catalog browsing. On a post's own
    // page it is noise: bookmarking is declined there and borders never render
    // there, so the button has nothing meaningful to do. Hide it, including
    // any instance carried over from a previous page by soft navigation.
    if (isSinglePostPage()) {
      if (_syncWindowTimer) { clearTimeout(_syncWindowTimer); _syncWindowTimer = null; }
      hideJumpToast();
      return;
    }

    const stored = await loadBookmarks();
    const total  = Object.keys(stored).length;

    if (total > 0) {
      // We have bookmarks: show the real button and cancel any sync window.
      if (_syncWindowTimer) { clearTimeout(_syncWindowTimer); _syncWindowTimer = null; }
      setJumpNavigate(total);
      return;
    }

    // Zero bookmarks. Distinguish two very different situations:
    //
    //   a) This device KNOWS the answer is zero, because a key exists in sync or
    //      in the local mirror. That happens once the device has saved anything
    //      here, including the empty object written by removing the last
    //      bookmark or clearing the site. Zero is correct and final: show
    //      nothing. This is the device that placed (and then removed) the
    //      bookmarks, so it must never wait on a sync that is not coming.
    //
    //   b) This device has NEVER seen this site's bookmark data (no key in
    //      either area). That is a second device visiting for the first time,
    //      where bookmarks placed elsewhere may still be propagating. Only here
    //      is a brief wait meaningful.
    //
    // The session flag additionally keeps case (b) to a single appearance per
    // session, so even a genuinely new device does not repeat it while browsing.
    let syncUsable = false;
    try { syncUsable = !!(chrome?.storage?.sync); } catch (_) { syncUsable = false; }

    if (!_bookmarkStateKnown && _withinSyncWindow && syncUsable) {
      // Consume the one-shot session flag immediately so any later navigation in
      // this session skips the syncing state entirely.
      try { sessionStorage.setItem(SYNC_SEEN_KEY, "1"); } catch (_) {}

      setJumpSyncing();
      // Ensure a timer is running to hide the button if nothing arrives.
      if (!_syncWindowTimer) {
        _syncWindowTimer = setTimeout(() => {
          _syncWindowTimer = null;
          _withinSyncWindow = false;
          // Re-evaluate: if still zero, hide; if data arrived, refresh shows it.
          refreshJumpToast();
        }, SYNC_WAIT_MS);
      }
    } else {
      hideJumpToast();
    }
  }

  // Persistent red error toast shown above the nav button when a bookmarked
  // post can't be located (e.g. deleted from the site). Stays until clicked
  // or until the user navigates / triggers another successful jump.
  function getErrorToast() {
    let el = document.getElementById("booru-bookmark-error-toast");
    if (!el) {
      el = document.createElement("div");
      el.id = "booru-bookmark-error-toast";
      document.documentElement.appendChild(el);
      el.addEventListener("click", () => hideErrorToast());
    }
    if (el.parentElement !== document.documentElement)
      document.documentElement.appendChild(el);
    return el;
  }
  function showErrorToast(msg) {
    const el = getErrorToast();
    el.textContent = msg;
    el.classList.add("visible");
  }
  function hideErrorToast() {
    document.getElementById("booru-bookmark-error-toast")?.classList.remove("visible");
  }

  // ── Pending jump ───────────────────────────────────────────────────────────
  // Arms a post ID to scroll to as soon as it appears in the DOM via
  // runRestore. If it hasn't appeared within 2 seconds, navigate to the
  // stored page URL instead - the bookmark is on a different page.

  function checkPendingJump(container, id) {
    if (!_pendingJumpId || id !== _pendingJumpId) return;
    _pendingJumpId = null;
    clearTimeout(_pendingTimer);
    sessionStorage.removeItem("booru_bm_walked"); // success - clear walk guard
    if (!isDeleted(container)) {
      scrollToBookmark(container);
    } else {
      highlightNearest(container);
    }
  }

  function maybeAutoJump() {
    if (!sessionStorage.getItem("booru_bm_autojump")) return;
    sessionStorage.removeItem("booru_bm_autojump");
    const savedIdx = sessionStorage.getItem("booru_bm_jumpindex");
    if (savedIdx !== null) {
      _jumpIndex = parseInt(savedIdx, 10);
      sessionStorage.removeItem("booru_bm_jumpindex");
    }
    loadBookmarks().then(stored => {
      const entries = Object.entries(stored);
      if (!entries.length) return;
      const idx = Math.max(0, Math.min(_jumpIndex, entries.length - 1));
      const [postId, value] = entries[idx];

      // Extract the stored index page URL for the page-walk fallback
      let pageUrl = null;
      if (value && typeof value === "object") pageUrl = value.page || null;
      else if (typeof value === "string")     pageUrl = value;

      // Actively poll for the post in the DOM rather than passively waiting for
      // a MutationObserver tick. e621 and other deferred-loading boorus inject
      // thumbnails over time, so we re-check directly on a short interval until
      // the post appears (then scroll to it) or we exhaust the window (then walk
      // pages / report). This eliminates the race where the element rendered
      // just after a fixed timeout and required a manual second click.
      _pendingJumpId = postId;
      clearTimeout(_pendingTimer);

      let attempts = 0;
      const MAX_ATTEMPTS = 40;     // 40 * 200ms = up to 8s of polling
      const tick = () => {
        if (_pendingJumpId !== postId) return; // resolved elsewhere
        const result = findContainerByPostId(postId);
        if (result && !isDeleted(result.container)) {
          _pendingJumpId = null;
          sessionStorage.removeItem("booru_bm_walked");
          scrollToBookmark(result.container);
          return;
        }
        if (result && isDeleted(result.container)) {
          _pendingJumpId = null;
          sessionStorage.removeItem("booru_bm_walked");
          highlightNearest(result.container);
          return;
        }
        if (++attempts < MAX_ATTEMPTS) {
          _pendingTimer = setTimeout(tick, 200);
          return;
        }
        // Window exhausted, the post genuinely isn't on this page.
        _pendingJumpId = null;
        if (sessionStorage.getItem("booru_bm_walked")) {
          // We already walked here and confirmed the post should be present,
          // but it never rendered. Do one final restore-driven attempt.
          sessionStorage.removeItem("booru_bm_walked");
          runRestore().then(() => {
            const r = findContainerByPostId(postId);
            if (r && !isDeleted(r.container)) scrollToBookmark(r.container);
            else showToast("Bookmark should be on this page", "info");
          });
          return;
        }
        // Not where we expected, it drifted to another page. Walk to find it.
        findPostPageAndGo(postId, pageUrl);
      };
      tick();
    });
  }

  // ── Deleted-post detection ─────────────────────────────────────────────────

  function isDeleted(container) {
    if (container.classList.contains("deleted")) return true;
    const flags = container.dataset?.flags || "";
    if (flags.includes("deleted")) return true;
    const img = container.tagName?.toLowerCase() === "img"
      ? container : container.querySelector("img");
    if (img && img.complete && img.naturalWidth === 0 &&
        img.src && !img.src.startsWith("data:")) return true;
    return false;
  }

  // ── Scroll helpers ─────────────────────────────────────────────────────────

  function scrollToBookmark(target) {
    hideErrorToast(); // a successful find clears any prior "deleted?" notice

    const doScroll = () => target.scrollIntoView({ behavior: "smooth", block: "center" });

    // Scroll immediately, then re-assert after layout settles. On lazy-loading
    // boorus, thumbnails above the target finish loading and expand AFTER the
    // first scroll, pushing the target off-centre - re-centering fixes that.
    doScroll();
    requestAnimationFrame(doScroll);          // after the next paint
    setTimeout(doScroll, 250);                // after early lazy-load shifts
    setTimeout(doScroll, 600);                // after later shifts settle

    // If the target's own thumbnail image is still loading, re-center once it's
    // done (its final height may differ from the placeholder).
    const img = target.tagName?.toLowerCase() === "img"
      ? target : target.querySelector("img");
    if (img && !img.complete) {
      img.addEventListener("load", () => doScroll(), { once: true });
    }

    // Pulse animation to draw the eye to the bookmark once it's in view.
    target.classList.remove(PULSE_CLASS);
    void target.offsetWidth;
    target.classList.add(PULSE_CLASS);
    target.addEventListener("animationend",
      () => target.classList.remove(PULSE_CLASS), { once: true });
  }

  function highlightNearest(deletedContainer) {
    const all = Array.from(document.querySelectorAll(
      "article, [data-post-id], [data-id], span.thumb, li.thumb, li.shm-thumb, a[href] > img"
    ));
    if (!all.length) return;
    let idx = all.indexOf(deletedContainer);
    if (idx === -1) {
      idx = all.findIndex(el =>
        el.compareDocumentPosition(deletedContainer) & Node.DOCUMENT_POSITION_FOLLOWING
      );
      if (idx === -1) idx = all.length - 1;
    }
    const candidate = all[idx + 1] || all[idx - 1] || all[0];
    if (!candidate) return;
    candidate.scrollIntoView({ behavior: "smooth", block: "center" });
    candidate.classList.remove(PULSE_CLASS);
    void candidate.offsetWidth;
    candidate.classList.add(PULSE_CLASS);
    candidate.addEventListener("animationend",
      () => candidate.classList.remove(PULSE_CLASS), { once: true });
  }

  // ── Jump to bookmark ───────────────────────────────────────────────────────

  async function jumpToBookmark() {
    // Guard against a second click while a search/navigation is already in
    // flight. On deferred-loading boorus the search takes a moment, and a second
    // click would restart it from scratch (the "took two clicks" problem).
    if (_jumpInFlight) {
      showToast("Still locating your bookmark...", "info");
      return;
    }

    const stored  = await loadBookmarks();
    const entries = Object.entries(stored);
    if (!entries.length) {
      showToast("No bookmarks saved for this site", "info");
      return;
    }

    _jumpIndex = (_jumpIndex + 1) % entries.length;
    sessionStorage.setItem("booru_bm_jumpindex", String(_jumpIndex));

    const [postId, value] = entries[_jumpIndex];

    // Normalise storage value, it may be an object { page, post } (current
    // schema) or a bare URL string (legacy schema). Extract both URLs.
    let pageUrl = null, postUrl = null;
    if (value && typeof value === "object") {
      pageUrl = value.page || null;
      postUrl = value.post || null;
    } else if (typeof value === "string") {
      pageUrl = value; // legacy: only the index page URL was stored
    }

    // STEP 1 - is the bookmarked thumbnail on the current page right now?
    // If so, just scroll to it. This is the common case while browsing.
    const result = findContainerByPostId(postId);
    if (result && !isDeleted(result.container)) {
      scrollToBookmark(result.container);
      return;
    }
    if (result && isDeleted(result.container)) {
      // The post is on this page but deleted - show the nearest neighbour
      highlightNearest(result.container);
      return;
    }

    // STEP 2 - not on this page. Search the index to find which page the post
    // lives on NOW, then navigate straight there. We no longer hop to the
    // stored page first (which caused a wasted reload when the post had drifted
    // away from it). The walk starts from whichever page is the better guess:
    // the page we're currently on, or the page the bookmark was placed on.
    let walkFromUrl = null;
    if (sameIndexPage(pageUrl)) {
      // We're already on the stored listing - the page may still be rendering
      // (deferred thumbnails). Give it a brief chance before walking.
      if (document.readyState !== "complete") {
        _pendingJumpId = postId;
        clearTimeout(_pendingTimer);
        _pendingTimer = setTimeout(() => {
          if (_pendingJumpId !== postId) return;
          _pendingJumpId = null;
          findPostPageAndGo(postId, pageUrl);
        }, 1000);
        return;
      }
      walkFromUrl = pageUrl;
    } else {
      walkFromUrl = sameListing(pageUrl) ? location.href : pageUrl;
    }

    if (!walkFromUrl) {
      showToast("No saved location for this bookmark", "info");
      return;
    }

    _jumpInFlight = true;
    try {
      // When several bookmarks are stored, say which one is being located so
      // cycling through them is visible and never looks like a wrong recall.
      const label = entries.length > 1
        ? `Locating bookmark ${_jumpIndex + 1} of ${entries.length}...`
        : null;
      await findPostPageAndGo(postId, walkFromUrl, label);
    } finally {
      // If the search navigated, the page changes and this instance goes away.
      // If it didn't navigate (e.g. showed a notice), clear so a retry works.
      _jumpInFlight = false;
    }
  }

  // ── Page-walk search ───────────────────────────────────────────────────────
  // Boorus reshuffle the index as new posts arrive, so a bookmarked post drifts
  // to later pages over time. To land the user on the INDEX PAGE where the
  // thumbnail now lives (not the post's standalone page), we fetch successive
  // index pages and scan each for the target post ID, then navigate there.

  // Build the index URL for a given page number, based on the stored page URL.
  // Handles both ?page=N query style and /list/N path style.
  function buildIndexPageUrl(baseUrl, pageNum) {
    try {
      let u = new URL(baseUrl, location.origin);

      // If the base URL has no recognisable listing path (e.g. a bare origin
      // "https://site/" that a canonical link produced), borrow the listing
      // path + query from the page we're currently on, which IS a real listing.
      const hasListing = /\/(post\/list|posts?|index\.php)/i.test(u.pathname + u.search);
      if (!hasListing) {
        try {
          const cur = new URL(location.href);
          if (/\/(post\/list|posts?|index\.php)/i.test(cur.pathname + cur.search)) {
            u = cur;
          }
        } catch (_) {}
      }

      // Query-param pagination (Danbooru family /posts, Gelbooru index.php).
      // Use this whenever a page param already exists OR the path is a known
      // query-paginated listing root.
      if (u.searchParams.has("page") ||
          /\/(posts?|index\.php)\/?$/i.test(u.pathname) ||
          /[?&]/.test(u.search)) {
        u.searchParams.set("page", String(pageNum));
        return u.toString();
      }

      // Path-style pagination (Shimmie2 /post/list/N): replace or append /N.
      if (/\/\d+\/?$/.test(u.pathname)) {
        u.pathname = u.pathname.replace(/\/\d+\/?$/, "/" + pageNum);
      } else if (/\/post\/list\/?$/i.test(u.pathname) || /\/post\/list\//i.test(u.pathname)) {
        u.pathname = u.pathname.replace(/\/?$/, "/" + pageNum);
      } else {
        // Unknown shape - safest is query param, which most engines accept.
        u.searchParams.set("page", String(pageNum));
      }
      return u.toString();
    } catch (_) {
      return baseUrl;
    }
  }

  // Fetch an index page and return true if the target post ID appears on it.
  async function pageContainsPost(pageUrl, postId) {
    const info = await fetchPageInfo(pageUrl);
    return info.ids.includes(postId);
  }

  // Extract post-ID info from a document (fetched or live).
  //
  // METRICS COME FROM PERMALINKS ONLY. The numeric min/max and the per-page
  // count drive every direction decision in the search, so they must be
  // derived exclusively from post-permalink anchors (/posts/N, /post/view/N,
  // s=view&id=N, ...). Only real posts have permalinks. Deriving metrics from
  // wrapper elements is NOT safe: engine layouts render sitewide widgets that
  // carry small numeric data-id values on every page (verified in the engine
  // source: a news banner div with data-id equal to the news item's id ships
  // in the global layout). One such element drags minNum down to a tiny
  // number, which makes every page's ID range appear to contain any target,
  // and the search then falsely concludes a present post is deleted.
  //
  // Wrapper-derived IDs are still collected, but for MEMBERSHIP only, and only
  // from wrappers that contain an image (thumbnails always do; layout widgets
  // do not). They never influence count or the numeric range.
  function extractPageInfo(root) {
    const seen = new Set();
    const ids = [];
    const nums = [];

    // Primary pass: post-permalink anchors. Metrics come only from here.
    for (const a of root.querySelectorAll("a[href]")) {
      const key = postIdFromAnchorHref(a);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      ids.push(key);
      nums.push(parseInt(key.slice(4), 10));
    }
    const count  = ids.length;
    const maxNum = nums.length ? Math.max(...nums) : null;
    const minNum = nums.length ? Math.min(...nums) : null;

    // Supplemental pass, membership only: wrapper-declared IDs for markup where
    // a thumbnail exposes its ID without a matching permalink. Requiring an
    // image inside the wrapper keeps sitewide widgets (news banners, notices)
    // out even here.
    for (const el of root.querySelectorAll(
      "article, [data-post-id], [data-id], span.thumb, li.thumb, li.shm-thumb"
    )) {
      if (!isSinglePostWrapper(el)) continue;      // skip page-level containers
      if (!el.querySelector?.("img")) continue;    // widgets carry no thumbnail
      const key = getPostId(el);
      if (key && !seen.has(key)) { seen.add(key); ids.push(key); }
    }
    // Bare-image thumbnails (engines with no wrapper element).
    for (const img of root.querySelectorAll("img")) {
      if (img.closest("article, [data-post-id], [data-id], span.thumb, li.thumb")) continue;
      const key = getPostId(img);
      if (key && !seen.has(key)) { seen.add(key); ids.push(key); }
    }

    return { ids, maxNum, minNum, count };
  }

  // Fetch an index page once and extract: the set of post-ID keys on it, plus
  // ── Polite fetch layer ────────────────────────────────────────────────────
  // Some boorus run aggressive rate limiters that reject bursts of requests
  // with HTTP 429 (or an interstitial). The page search can issue several
  // fetches, so all index fetching goes through here, which does two things:
  //   1. Serializes requests and spaces them by a minimum interval, so we never
  //      fire a burst of parallel connections at one host.
  //   2. On a 429 / 503 / 403, backs off and retries with exponential delay,
  //      honoring a Retry-After header when present.
  // This keeps a wide sweep slower-but-reliable rather than fast-but-blocked.
  // Spacing starts low so boorus that do not rate-limit stay fast, and rises
  // permanently for the page once a host actually pushes back. That way the
  // slow, cautious pace is paid only where it is needed.
  const FETCH_SPACING_NORMAL_MS = 120;
  const FETCH_SPACING_LIMITED_MS = 700;
  let _fetchSpacingMs = FETCH_SPACING_NORMAL_MS;
  const MAX_FETCH_RETRIES    = 4;
  let _fetchChain = Promise.resolve(); // serializes fetches
  let _lastFetchAt = 0;

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  // Schedule a paced fetch. Returns the Response, or null on give-up/error.
  function politeFetch(url) {
    const run = async () => {
      // Space requests: wait until the current spacing has elapsed since the
      // previous one started.
      const wait = _lastFetchAt + _fetchSpacingMs - Date.now();
      if (wait > 0) await sleep(wait);

      for (let attempt = 0; attempt <= MAX_FETCH_RETRIES; attempt++) {
        _lastFetchAt = Date.now();
        let resp;
        try {
          resp = await fetch(url, { credentials: "include" });
        } catch (_) {
          // Network error: brief backoff then retry.
          if (attempt < MAX_FETCH_RETRIES) { await sleep(600 * (attempt + 1)); continue; }
          return null;
        }

        // Rate-limited or temporarily blocked: back off and retry.
        if (resp.status === 429 || resp.status === 503 || resp.status === 403) {
          // This host rate-limits. Slow every subsequent request for the rest of
          // the page's life, not just this retry, so the sweep stops tripping it.
          _fetchSpacingMs = FETCH_SPACING_LIMITED_MS;
          if (attempt >= MAX_FETCH_RETRIES) return resp;
          let delay = 800 * Math.pow(2, attempt); // 0.8s, 1.6s, 3.2s, 6.4s
          const ra = resp.headers.get("retry-after");
          if (ra) {
            const secs = parseInt(ra, 10);
            if (Number.isFinite(secs) && secs > 0) delay = Math.max(delay, secs * 1000);
          }
          // Surface a gentle notice so a slow, backing-off search isn't silent.
          try { showToast("Site is rate-limiting, slowing down...", "info"); } catch (_) {}
          await sleep(delay);
          continue;
        }
        return resp;
      }
      return null;
    };

    // Chain so only one request is in flight at a time.
    const scheduled = _fetchChain.then(run, run);
    // Keep the chain alive regardless of this call's outcome.
    _fetchChain = scheduled.then(() => {}, () => {});
    return scheduled;
  }

  // Fetch an index page once and extract: the set of post-ID keys on it, plus
  // the numeric min/max of those IDs. The numeric range powers a binary search:
  // boorus order the default index by post ID DESCENDING, so a target ID higher
  // than a page's max means the post is on an EARLIER page, lower than its min
  // means a LATER page, and within range means it's on this page.
  // Returns { ids:[...], maxNum, minNum, count, ok } - empty page => count 0.
  // ok is false when the request itself failed (network error, rate-limit
  // give-up, non-OK status). This MUST be distinguished from a genuinely empty
  // page: an empty page means we have run past the end of the listing and a
  // sweep should stop, whereas a failed fetch means we simply learned nothing
  // and stopping would report a present bookmark as missing.
  // Some sites answer rate limiting with HTTP 200 and a plain HTML notice
  // rather than a 429 status. Such a page parses fine and simply contains no
  // posts, so without this it is indistinguishable from running past the last
  // page of a listing, which would abort a search and report a present
  // bookmark as deleted. Only applied to pages that yielded no posts, so a
  // normal listing can never be misread as a block.
  function looksRateLimited(html) {
    return /too many requests|rate[ -]?limit|slow down|throttl|temporarily blocked|try again (in|later)|flood protection/i
      .test(html);
  }

  async function fetchPageInfo(pageUrl) {
    for (let attempt = 0; attempt <= 2; attempt++) {
      try {
        const resp = await politeFetch(pageUrl);
        if (!resp || !resp.ok) return { ids: [], maxNum: null, minNum: null, count: 0, ok: false };
        const html = await resp.text();
        const doc  = new DOMParser().parseFromString(html, "text/html");
        const info = extractPageInfo(doc);

        if (info.count === 0 && looksRateLimited(html)) {
          // Soft block. Slow down for the rest of this page's life and retry,
          // rather than mistaking it for the end of the listing.
          _fetchSpacingMs = FETCH_SPACING_LIMITED_MS;
          if (attempt < 2) {
            try { showToast("Site is rate-limiting, slowing down...", "info"); } catch (_) {}
            await sleep(1500 * (attempt + 1));
            continue;
          }
          return { ids: [], maxNum: null, minNum: null, count: 0, ok: false };
        }

        info.ok = true;
        return info;
      } catch (_) {
        return { ids: [], maxNum: null, minNum: null, count: 0, ok: false };
      }
    }
    return { ids: [], maxNum: null, minNum: null, count: 0, ok: false };
  }

  // ── Direct post status lookup ─────────────────────────────────────────────
  // Asking the site whether a post still exists is vastly cheaper than
  // inferring it from an exhaustive index sweep. Two facts make this work:
  //
  //   1. Every engine has post permalinks, so we can learn the URL shape from
  //      any post link already on the page and substitute our target's ID. No
  //      per-engine table is needed, so this also works on self-hosted
  //      instances with unusual paths.
  //   2. Danbooru-family engines soft-delete: the post keeps its permalink and
  //      JSON record but leaves the default index listings. That is exactly the
  //      case that used to cause an endless sweep, since the post genuinely is
  //      on no index page. Their JSON reports it explicitly via is_deleted.
  //
  // This is strictly an optimization: only a DEFINITIVE answer short-circuits
  // the search. Anything ambiguous falls through to the existing behavior, so a
  // site that responds unusually can never cause a false "deleted" verdict.

  // Build the permalink for a numeric post ID by copying the shape of a post
  // link on the current page. Returns null if no sample link is available.
  function buildPostPermalink(num) {
    for (const a of document.querySelectorAll("a[href]")) {
      const key = postIdFromAnchorHref(a);
      if (!key) continue;
      const sampleId = key.slice(4);
      if (sampleId === String(num)) return new URL(a.getAttribute("href"), location.origin).href;
      const href = a.getAttribute("href");
      // Replace the id where it appears as a whole number, preserving the rest.
      const rebuilt = href.replace(
        new RegExp("(^|[/=])" + sampleId + "(?![0-9])"), "$1" + num
      );
      if (rebuilt !== href) {
        try { return new URL(rebuilt, location.origin).href; } catch (_) { return null; }
      }
    }
    return null;
  }

  // Resolve a post's status. Returns one of:
  //   "gone"    - the post does not exist (permalink 404). Stop searching.
  //   "unlisted"- the post exists but is flagged deleted, so it is on no index
  //               page. Stop searching.
  //   "unknown" - no definitive answer. Caller must fall back to searching.
  async function checkPostStatus(postId) {
    const m = /^num:(\d+)$/.exec(postId || "");
    if (!m) return "unknown";
    const num = m[1];

    const permalink = buildPostPermalink(num);
    if (!permalink) return "unknown";

    // Danbooru-family exposes structured JSON at <permalink>.json, which states
    // soft deletion outright. Only attempt it when the permalink has that
    // shape, so other engines are not sent a request that cannot succeed.
    if (/\/posts\/\d+(?:$|[?#])/i.test(permalink)) {
      try {
        const jsonUrl = permalink.replace(/(\/posts\/\d+)(?=$|[?#])/i, "$1.json");
        const r = await politeFetch(jsonUrl);
        if (r && r.status === 404) return "gone";
        if (r && r.ok) {
          const data = await r.json();
          if (data && typeof data === "object") {
            if (data.is_deleted === true) return "unlisted";
            if (data.id) return "unknown"; // exists and listable: keep searching
          }
        }
      } catch (_) { /* fall through to the plain permalink check */ }
    }

    // Universal fallback: a 404 on the post's own page means it is genuinely
    // gone on every engine. A 200 tells us it exists but not whether it is
    // listable, which is not definitive, so we report unknown and search on.
    try {
      const r = await politeFetch(permalink);
      if (r && r.status === 404) {
        // Before trusting that, confirm the URL shape itself is right. If a
        // post we can currently SEE also 404s at the same shape, then we built
        // a bad URL rather than finding a deleted post, and reporting "deleted"
        // would be a false negative. Falling back to searching is the safe
        // outcome, and this costs one request only on the deletion path.
        const controlKey = livePageInfo().ids.find(k => /^num:/.test(k) && k.slice(4) !== num);
        if (controlKey) {
          const controlUrl = buildPostPermalink(controlKey.slice(4));
          if (controlUrl) {
            const cr = await politeFetch(controlUrl);
            if (!cr || cr.status === 404) return "unknown"; // shape is wrong
          }
        }
        return "gone";
      }
    } catch (_) { /* ignore */ }
    return "unknown";
  }

  // navigating to the first page found to contain the post. Returns true if it
  // navigated, false if the post wasn't found in the swept range. Used as a
  // safety net after binary search (whose ID-monotonic assumption can be
  // violated by custom sort orders, lazy-loaded fetched markup, or ID gaps).
  async function linearSweep(postId, bookmarkPageUrl, fromPage, toPage) {
    const lo = Math.max(1, Math.min(fromPage, toPage));
    const hi = Math.max(fromPage, toPage);
    // Requests are paced and serialized by politeFetch, so we scan sequentially
    // and stop at the first hit.
    //
    // END-OF-LISTING DETECTION is essential here. Without it a sweep bounded at
    // page 300 keeps fetching long after the listing has ended, which on a
    // paced connection is minutes of pointless requests and looks like an
    // endless scan. We stop when either:
    //   - a successfully fetched page contains no posts (past the end), or
    //   - a page repeats the previous page's contents, which is how some sites
    //     respond to an out-of-range page number instead of returning nothing.
    // A FAILED fetch is never treated as the end, since that would abandon the
    // search and report a present bookmark as missing.
    let prevSignature = null;
    let consecutiveFailures = 0;
    let consecutiveEmpty = 0;

    for (let p = lo; p <= hi; p++) {
      // Progress feedback every few pages so a paced search isn't silent.
      if (p > lo && (p - lo) % 4 === 0) {
        showToast("Still searching... page " + p, "info");
      }
      const info = await fetchPageInfo(buildIndexPageUrl(bookmarkPageUrl, p));

      if (!info.ok) {
        // Request failed rather than the listing ending. Tolerate a few, then
        // give up rather than hammering a host that is refusing us.
        if (++consecutiveFailures >= 3) return false;
        continue;
      }
      consecutiveFailures = 0;

      if (info.count === 0) {
        // An empty page usually means we are past the last page, but a single
        // anomalous page (a soft block, a transient render, a bad URL guess)
        // must NOT abandon the search and report a present bookmark as gone.
        // Require two in a row before believing the listing has ended.
        if (++consecutiveEmpty >= 2) return false;
        continue;
      }
      consecutiveEmpty = 0;

      const signature = info.count + ":" + info.maxNum + ":" + info.minNum;
      if (prevSignature !== null && signature === prevSignature) {
        return false;                              // site clamped: past the end
      }
      prevSignature = signature;

      if (info.ids.includes(postId)) {
        sessionStorage.setItem("booru_bm_autojump", "1");
        sessionStorage.setItem("booru_bm_walked", "1");
        const dest = buildIndexPageUrl(bookmarkPageUrl, p);
        // Same-URL destinations must hard-reload; see goToPage for rationale.
        try {
          const t = new URL(dest, location.origin);
          const h = new URL(location.href);
          if (t.origin === h.origin && t.pathname === h.pathname && t.search === h.search) {
            location.reload();
            return true;
          }
        } catch (_) { /* fall through */ }
        navigateTo(dest);
        return true;
      }
    }
    return false;
  }

  // Read post-ID info from the LIVE current page's DOM, using the same
  // extraction as fetchPageInfo. When the user is already on a listing page,
  // this lets the search seed its estimate without re-fetching a page we're
  // already viewing, removing a full network round-trip (on heavy index pages
  // that round-trip is most of the perceived delay).
  function livePageInfo() {
    return extractPageInfo(document);
  }

  // Walk index pages (up to a sane limit) to find the target post, then
  // navigate the user to the index page it's on. Searches outward from the
  // page it was bookmarked on, since drift is usually toward later pages.
  async function findPostPageAndGo(postId, bookmarkPageUrl, label) {
    if (!bookmarkPageUrl) {
      showToast("Bookmarked post not found on this page", "info");
      return;
    }

    showToast(label || "Locating bookmark across pages...", "info");

    // Determine the page number to start searching from. Prefer the page the
    // user is currently on (if it's a valid index page of this listing), since
    // that's the best guess for proximity; otherwise use the bookmarked page.
    function pageNumOf(urlStr) {
      try {
        const u = new URL(urlStr, location.origin);
        const qp = u.searchParams.get("page");
        if (qp) return parseInt(qp, 10) || 1;
        const m = u.pathname.match(/\/(\d+)\/?$/);
        if (m) return parseInt(m[1], 10) || 1;
      } catch (_) {}
      return 1;
    }

    let startPage = pageNumOf(bookmarkPageUrl);

    const MAX_PAGES = 5000; // generous ceiling; binary search makes this cheap

    // The target's numeric post ID drives a binary search. Boorus order the
    // index by post ID descending, so page position is monotonic in ID.
    const targetNum = (() => {
      const m = String(postId).match(/^num:(\d+)$/);
      return m ? parseInt(m[1], 10) : null;
    })();

    const goToPage = (pageNum) => {
      sessionStorage.setItem("booru_bm_autojump", "1");
      sessionStorage.setItem("booru_bm_walked", "1");
      const dest = buildIndexPageUrl(bookmarkPageUrl, pageNum);
      // If the destination is the page the user is already viewing, a normal
      // navigation can no-op or restore the same cached (stale) DOM snapshot,
      // leaving the page visibly unchanged. Force a real reload instead so the
      // fresh DOM renders, restore borders the post, and autojump scrolls to it.
      try {
        const t = new URL(dest, location.origin);
        const h = new URL(location.href);
        if (t.origin === h.origin && t.pathname === h.pathname && t.search === h.search) {
          location.reload();
          return;
        }
      } catch (_) { /* URL parse failure: fall through to normal navigation */ }
      navigateTo(dest);
    };

    const notFound = (reason) => {
      // When the site gave a definitive answer we can say so plainly instead of
      // guessing. "unlisted" means the post still exists at its own URL but has
      // been removed from index listings, which is worth distinguishing.
      const message =
        reason === "gone"     ? "Bookmarked post no longer exists" :
        reason === "unlisted" ? "Bookmarked post was deleted and is no longer listed" :
                                "Bookmark Not found! Deleted?";
      sessionStorage.setItem("booru_bm_deleted_notice", "1");
      if (sameIndexPage(bookmarkPageUrl)) {
        sessionStorage.removeItem("booru_bm_deleted_notice");
        showErrorToast(message);
      } else {
        navigateTo(buildIndexPageUrl(bookmarkPageUrl, startPage));
      }
    };

    // ---- Fast path: interpolation search by post ID -------------------------
    // Boorus order the index by post ID descending, and IDs are roughly
    // sequential, so a post's page is predictable by arithmetic rather than
    // blind search. We read page 1's highest ID (H) and posts-per-page (P),
    // then ESTIMATE the target's page directly:
    //     postsAhead ~= H - targetNum     (IDs ahead of the target)
    //     estPage     = floor(postsAhead / P) + 1
    // ID gaps make this approximate, so we then home in: each fetched page's
    // ID range tells us exactly how many pages to step, converging in 1-2 more
    // fetches. Typically 2-3 fetches total whether the post is 5 or 500 pages
    // deep, versus ~log2(pages) for binary search.
    if (targetNum !== null) {
      // Anchor the estimate from page 1's highest ID and posts-per-page. If the
      // user is currently ON a listing page of this same search, read that from
      // the LIVE DOM instead of fetching, saving a network round-trip (often the
      // bulk of the perceived delay on heavy index pages).
      let page1 = null;
      const currentPageNum = pageNumOf(location.href);
      const liveInfo = livePageInfo();
      let onListingNow = sameListing(bookmarkPageUrl) && liveInfo.count > 0 && liveInfo.maxNum !== null;

      // STALENESS GUARD: a long-lived tab holds a DOM snapshot from load time.
      // A bookmark that just synced in from another device can reference a post
      // NEWER than anything in that snapshot (its ID exceeds the snapshot's
      // maximum). Anchoring or bracket-seeding the search from that stale DOM
      // poisons it: the fast path disqualifies itself and the search collapses
      // into the slow exhaustive sweep. If the target is newer than everything
      // the live page shows, the live DOM cannot be trusted; fall through to
      // fresh network fetches instead.
      if (onListingNow && targetNum > liveInfo.maxNum) {
        onListingNow = false;
      }

      if (currentPageNum === 1 && onListingNow) {
        // We're already viewing page 1 of the right listing; use it directly.
        page1 = liveInfo;
        if (page1.ids.includes(postId)) { goToPage(1); return; }
      } else {
        page1 = await fetchPageInfo(buildIndexPageUrl(bookmarkPageUrl, 1));
        if (page1.ids.includes(postId)) { goToPage(1); return; }
      }

      if (page1.count > 0 && page1.maxNum !== null && targetNum <= page1.maxNum) {
        const perPage = page1.count;
        const highest = page1.maxNum;

        // If we're currently on a listing page (any page number) of this search,
        // seed the bracket using the live page's ID range too -- this can bracket
        // the target immediately without any fetch when the post is nearby.
        let lo = 1, hi = null;
        let loMax = highest;

        if (onListingNow && currentPageNum >= 1) {
          if (liveInfo.ids.includes(postId)) { goToPage(currentPageNum); return; }
          if (liveInfo.minNum !== null) {
            if (targetNum > liveInfo.maxNum)      hi = currentPageNum; // target earlier
            else if (targetNum < liveInfo.minNum) lo = currentPageNum; // target later
          }
        }

        // Estimate the target's page using page 1's OBSERVED ID span rather
        // than assuming one post per ID. Page 1 holds perPage posts spanning
        // (highest - minNum) IDs. On the default index that span is about
        // perPage (dense IDs), so this reduces to the plain arithmetic. On a
        // tag-filtered listing the same page spans a huge ID range, and using
        // the observed span keeps the estimate on target instead of
        // overshooting by thousands of pages. Note: the paginator's visible
        // page numbers must NOT be used to bound this, because paginators show
        // a window of nearby pages, not the listing's true end.
        const pageIdSpan = Math.max(
          perPage,
          page1.minNum !== null ? (highest - page1.minNum) + 1 : perPage
        );
        let seed = Math.max(1, Math.floor((highest - targetNum) / pageIdSpan) + 1);

        let probe = (hi !== null && seed >= hi) ? Math.max(lo + 1, hi - 1) : Math.max(seed, lo + 1 || 1);
        if (probe < 1) probe = 1;
        let expandStep = Math.max(1, Math.floor(seed / 2));
        let bounded = (hi !== null && lo < hi);

        // Seed probe: always try our best-guess page first, even when the
        // paginator already bounded the bracket. The seed is usually exact on
        // dense listings, so this resolves most jumps in this single fetch;
        // its ID range also tightens the bracket for the binary phase.
        if (probe > lo && (hi === null || probe < hi)) {
          const info = await fetchPageInfo(buildIndexPageUrl(bookmarkPageUrl, probe));
          // A failed fetch tells us nothing; only a successfully fetched empty
          // page means we are past the end of the listing. Treating a failure
          // as the end would mis-bracket the search and miss a present post.
          if (!info.ok) {
            // Learn nothing from this probe; fall through to the expand phase.
          } else if (info.count === 0) {
            hi = Math.min(hi ?? probe, probe);
            bounded = true;
          } else {
            if (info.ids.includes(postId)) { goToPage(probe); return; }
            if (info.minNum === null) { lo = 1; hi = null; bounded = false; }
            else if (targetNum <= info.maxNum && targetNum >= info.minNum) {
              lo = probe; hi = probe; bounded = true;
            } else if (targetNum > info.maxNum) {
              hi = Math.min(hi ?? probe, probe);
              bounded = (lo < hi);
              probe = Math.max(1, probe - expandStep);
            } else {
              lo = Math.max(lo, probe); loMax = info.maxNum;
              bounded = (hi !== null && lo < hi);
              probe = probe + expandStep;
            }
          }
        }

        // Phase A: if still not bracketed, expand outward until we are.
        for (let i = 0; i < 24 && !bounded; i++) {
          const info = await fetchPageInfo(buildIndexPageUrl(bookmarkPageUrl, probe));

          if (!info.ok) break;  // request failed: stop probing, use the sweep
          if (info.count === 0) {
            // Past the end -> this is an upper bound on the page number.
            hi = probe;
            bounded = true;
            break;
          }
          if (info.ids.includes(postId)) { goToPage(probe); return; }
          if (info.minNum === null) { lo = 1; hi = null; break; } // fallback

          if (targetNum <= info.maxNum && targetNum >= info.minNum) {
            // In this page's ID range but exact post absent -> deleted; the
            // sweep below verifies before reporting.
            lo = probe; hi = probe; bounded = true; break;
          }
          if (targetNum > info.maxNum) {
            // Target newer -> earlier page. This page is an upper bound.
            hi = probe;
            // lo stays; if we have a lo below, we're bracketed.
            if (lo < hi) { bounded = true; break; }
            probe = Math.max(1, probe - expandStep);
            expandStep *= 2;
          } else {
            // Target older -> later page. This page is a lower bound.
            lo = probe; loMax = info.maxNum;
            probe = probe + expandStep;
            expandStep *= 2;
          }
        }

        // Phase B: binary search the bracket [lo, hi].
        if (bounded && hi !== null) {
          let inRangePage = null; // page whose ID range contains target
          while (lo + 1 < hi) {
            const mid  = Math.floor((lo + hi) / 2);
            const info = await fetchPageInfo(buildIndexPageUrl(bookmarkPageUrl, mid));
            if (!info.ok) break;                       // failed fetch: bail to sweep
            if (info.count === 0) { hi = mid; continue; }
            if (info.ids.includes(postId)) { goToPage(mid); return; }
            if (info.minNum === null) break;
            if (targetNum > info.maxNum)      hi = mid;
            else if (targetNum < info.minNum) lo = mid;
            else { inRangePage = mid; break; } // in range, exact id absent
          }
          // Check the two boundary pages directly.
          for (const p of [lo, hi]) {
            if (p < 1) continue;
            const info = await fetchPageInfo(buildIndexPageUrl(bookmarkPageUrl, p));
            if (info.ids.includes(postId)) { goToPage(p); return; }
            if (info.minNum !== null && targetNum <= info.maxNum && targetNum >= info.minNum)
              inRangePage = p;
          }
          // If the target's ID falls within a page's range but the exact post
          // isn't there, it is PROBABLY deleted. Check the immediate
          // neighborhood first (fast), but do NOT conclude deletion from that
          // alone: fall through to the exhaustive sweep below. Poisoned or
          // unusual ID ranges must never turn a present bookmark into a false
          // "deleted" verdict. The full sweep only costs time when the post is
          // genuinely gone.
          if (inRangePage !== null) {
            if (await linearSweep(postId, bookmarkPageUrl, inRangePage - 2, inRangePage + 2)) return;
          }
        }
      }

      // Before paying for an exhaustive sweep, ask the site directly whether
      // the post still exists and is still listable. A definitive answer here
      // replaces dozens of index fetches with one small request. Anything
      // inconclusive falls through to the sweep exactly as before.
      const status = await checkPostStatus(postId);
      if (status === "gone" || status === "unlisted") { notFound(status); return; }

      // Nothing conclusive from interpolation or binary search. Verify with a
      // bounded exhaustive sweep before declaring deletion, so a post that
      // exists is never falsely reported gone regardless of markup or ordering.
      if (await linearSweep(postId, bookmarkPageUrl, 1, 300)) return;
      notFound();
      return;
    }

    // ---- Fallback: sequential outward linear scan (odd engines / non-numeric IDs)
    const onStartPage = sameIndexPage(buildIndexPageUrl(bookmarkPageUrl, startPage));
    const firstProbe  = onStartPage ? startPage + 1 : startPage;
    const LINEAR_MAX  = 300;

    // Build an outward-spiraling page order from the best guess, then scan it
    // one page at a time. Requests are paced by politeFetch, so this never
    // bursts connections at a rate-limited host. Once a page beyond the end of
    // the listing is seen, every higher page number is pruned, so the scan does
    // not keep requesting pages that cannot exist.
    const order = [firstProbe];
    for (let d = 1; d < LINEAR_MAX; d++) {
      if (firstProbe + d <= LINEAR_MAX) order.push(firstProbe + d);
      if (firstProbe - d >= 1)          order.push(firstProbe - d);
    }

    let scanned = 0;
    let knownEndPage = Infinity;   // first page number known to be past the end
    let consecutiveFailures = 0;

    for (const pageNum of order) {
      if (pageNum >= knownEndPage) continue;      // pruned: beyond the listing
      scanned++;
      if (scanned > 1 && scanned % 4 === 0) {
        showToast("Still searching...", "info");
      }
      const info = await fetchPageInfo(buildIndexPageUrl(bookmarkPageUrl, pageNum));

      if (!info.ok) {
        if (++consecutiveFailures >= 3) break;    // host refusing: stop trying
        continue;
      }
      consecutiveFailures = 0;

      if (info.count === 0) {
        // Past the end of the listing. Remember it so higher pages are skipped.
        knownEndPage = Math.min(knownEndPage, pageNum);
        continue;
      }
      if (info.ids.includes(postId)) { goToPage(pageNum); return; }
    }

    notFound();
  }

  // Navigate using the booru's SPA router if present, else a hard navigation.
  function navigateTo(url) {
    if (window.Turbo?.visit)           window.Turbo.visit(url);
    else if (window.Turbolinks?.visit) window.Turbolinks.visit(url);
    else                               location.href = url;
  }

  // True if the given URL is the same listing/search as the current page,
  // ignoring only the page number. Used to decide whether the current page is a
  // safe origin to walk from (same tags, just a different page).
  function sameListing(pageUrl) {
    try {
      const target  = new URL(pageUrl, location.origin);
      const current = new URL(location.href);
      if (target.origin !== current.origin) return false;

      // Strip the page marker from both, then compare what remains.
      const strip = (u) => {
        const c = new URL(u.href);
        c.searchParams.delete("page");
        c.searchParams.delete("pid"); // Gelbooru-family uses pid offset
        // Drop params with EMPTY values (e.g. a bare tags= from an empty search
        // box). "/posts?tags=" and "/posts" are the same listing, and treating
        // them as different disables the live-page fast path.
        for (const [k, v] of [...c.searchParams.entries()]) {
          if (v === "") c.searchParams.delete(k);
        }
        // Path-based page number (/list/N)
        c.pathname = c.pathname.replace(/\/\d+\/?$/, "/");
        // Normalise param order for stable comparison
        c.searchParams.sort();
        return c.pathname + "?" + c.searchParams.toString();
      };
      return strip(target) === strip(current);
    } catch (_) {
      return false;
    }
  }

  // True if the given index-page URL refers to the same page we're viewing,
  // accounting for both ?page=N query style and /list/N path style.
  function sameIndexPage(pageUrl) {
    try {
      const target  = new URL(pageUrl, location.origin);
      const current = new URL(location.href);
      if (target.origin !== current.origin) return false;

      const marker = (u) => {
        const qp = u.searchParams.get("page");
        if (qp !== null) return { value: qp, path: u.pathname };
        const m = u.pathname.match(/\/(\d+)\/?$/);
        if (m) return { value: m[1], path: u.pathname.slice(0, u.pathname.length - m[0].length) || "/" };
        return { value: "1", path: u.pathname };
      };
      const a = marker(target), b = marker(current);
      return a.path === b.path && a.value === b.value;
    } catch (_) {
      return false;
    }
  }

  // ── Initialise ────────────────────────────────────────────────────────────

  // If we just navigated to a bookmark's last known page because the post was
  // determined to be deleted, show the persistent red notice now.
  function maybeShowDeletedNotice() {
    if (sessionStorage.getItem("booru_bm_deleted_notice")) {
      sessionStorage.removeItem("booru_bm_deleted_notice");
      showErrorToast("Bookmark Not found! Deleted?");
    }
  }

  // Run the one-time key migration before anything reads bookmarks, so the
  // canonical num: keys are in place for restore, jump, and the toast count.
  (async () => {
    const stored = await loadBookmarks();
    const { migrated, changed } = migrateBookmarkKeys(stored);

    // Promotion of legacy local-only data to sync must be done CAREFULLY, or it
    // races with sync propagation on a freshly-synced device and resurrects or
    // duplicates bookmarks. We only promote when we are confident this is a
    // genuine pre-sync local dataset, not a device still waiting for sync:
    //   - _loadedFromLocal means sync had no key and the local mirror had data.
    //   - Before writing that up, re-check sync one more time after a short
    //     delay. If sync has since delivered a value for this key (propagation
    //     arrived), we DEFER to sync and do not push our local copy, so a fresh
    //     device never uploads stale/duplicate entries over incoming data.
    if (changed || _loadedFromLocal) {
      let shouldPromote = true;
      if (_loadedFromLocal) {
        shouldPromote = await new Promise((resolve) => {
          if (!isExtensionAlive()) { resolve(false); return; }
          // Give sync a moment to propagate, then re-check.
          setTimeout(() => {
            try {
              chrome.storage.sync.get(STORAGE_KEY, (d) => {
                if (!chrome.runtime.lastError && d && (STORAGE_KEY in d)) {
                  // Sync now has authoritative data; do not overwrite it.
                  resolve(false);
                } else {
                  resolve(true); // still nothing in sync: safe to promote
                }
              });
            } catch (_) { resolve(false); }
          }, 1200);
        });
      }
      if (shouldPromote) {
        await saveBookmarks(migrated);
      } else {
        // Sync won: adopt its value locally and refresh the UI to match.
        await loadBookmarks();
        refreshJumpToast();
        scheduleRestore();
      }
    }

    runRestore().then(() => {
      refreshJumpToast();
      maybeAutoJump();
      maybeShowDeletedNotice();
    });
  })();

  // Live cross-device updates: when the same key changes in sync (a bookmark
  // added or removed on another device), the SYNC value is authoritative. Mirror
  // it locally verbatim (no merging, which is what caused duplicate/resurrected
  // entries), then re-apply borders and refresh the jump toast so the change
  // shows up here without a manual reload.
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "sync") return;
      if (!changes[STORAGE_KEY]) return;
      try {
        const next = changes[STORAGE_KEY].newValue;
        // Overwrite the mirror to exactly match sync (including an empty object
        // from a deliberate clear). Only skip when sync's key was removed
        // entirely (newValue undefined), leaving the mirror as the backup.
        if (next !== undefined) {
          chrome.storage.local.set({ [STORAGE_KEY]: next }, () => {
            void chrome.runtime.lastError;
          });
        }
      } catch (_) { /* mirror update is best-effort */ }
      scheduleRestore();
      refreshJumpToast();
    });
  } catch (_) { /* storage.onChanged unavailable: non-fatal */ }

  // MutationObserver: re-apply bookmarks when new thumbnails appear.
  // When a bookmarked node is removed (booru replaces it), detect it
  // immediately and trigger a fast restore without waiting for debounce.
  new MutationObserver((mutations) => {
    if (_mutingObs) return;
    let urgentRestore = false;
    for (const m of mutations) {
      for (const node of m.removedNodes) {
        if (node.nodeType === 1 && (
          node.classList?.contains(BOOKMARK_CLASS) ||
          node.querySelector?.("." + BOOKMARK_CLASS)
        )) {
          urgentRestore = true;
          break;
        }
      }
      if (urgentRestore) break;
    }
    if (urgentRestore) {
      clearTimeout(_restoreTimer);
      // Wait one microtask tick so the replacement node (e.g. from
      // DeferredPostLoader's replaceWith) is in the DOM before we scan
      Promise.resolve().then(runRestore);
    } else {
      scheduleRestore();
    }
  }).observe(document.body, { childList: true, subtree: true });

  document.addEventListener("turbo:load", () => {
    runRestore().then(() => { signalBooru(); refreshJumpToast(); maybeAutoJump(); });
  });
  document.addEventListener("turbolinks:load", () => {
    runRestore().then(() => { signalBooru(); refreshJumpToast(); maybeAutoJump(); });
  });

  setInterval(() => { signalBooru(); scheduleRestore(); refreshJumpToast(); }, 10_000);

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") { signalBooru(); scheduleRestore(); }
  });
  window.addEventListener("focus", () => { signalBooru(); scheduleRestore(); });
  window.addEventListener("popstate", () => {
    runRestore().then(() => { signalBooru(); refreshJumpToast(); maybeAutoJump(); });
  });

  // ── Context-menu capture ───────────────────────────────────────────────────

  document.addEventListener("contextmenu", (e) => {
    try {
      const r = resolveFromElement(e.target);
      _lastTarget = r.id ? { postId: r.id, srcUrl: r.srcUrl } : null;
    } catch (_) { _lastTarget = null; }
  }, true);

  // ── Regular toast ─────────────────────────────────────────────────────────

  function showToast(msg, type = "info") {
    let el = document.getElementById("booru-bookmark-toast");
    if (!el) {
      el = document.createElement("div");
      el.id = "booru-bookmark-toast";
      document.documentElement.appendChild(el);
    }
    el.textContent = msg;
    el.className   = "";
    void el.offsetWidth;
    el.className   = "booru-bookmark-toast-show " + type;
    clearTimeout(el._timer);
    el.onclick = null;
    el._timer  = setTimeout(() => { el.className = ""; }, 2400);
  }

  // ── Message listener ───────────────────────────────────────────────────────

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {

    if (msg.type === "GET_TARGET") {
      sendResponse(_lastTarget);
      return;
    }

    if (msg.type === "JUMP_TO_BOOKMARK") {
      jumpToBookmark();
      sendResponse({ ok: true });
      return;
    }

    if (msg.type === "CLEAR_ALL") {
      document.querySelectorAll("." + BOOKMARK_CLASS).forEach(removeBookmark);
      saveBookmarks({}).then(() => refreshJumpToast());
      showToast("All bookmarks cleared", "warn");
      sendResponse({ ok: true });
      return;
    }

    let resolved = null;
    if (isSinglePostPage() && msg.type === "BOOKMARK") {
      // Bookmarks are placed on index thumbnails. On a post's own page the
      // right-clicked element resolves to full-size images or UI widgets whose
      // IDs would create junk storage entries, so decline with guidance.
      showToast("Bookmark thumbnails from the index page, not the post page", "info");
      sendResponse({ ok: false });
      return;
    }
    if (msg.postId) resolved = findContainerByPostId(msg.postId);
    if (!resolved && msg.srcUrl) resolved = findContainerBySrc(msg.srcUrl);

    if (!resolved) {
      showToast("Could not identify image -- try again", "warn");
      sendResponse({ ok: false });
      return;
    }

    const { container, id } = resolved;

    if (msg.type === "BOOKMARK") {
      applyBookmark(container, id);
      const postLink = getPostLink(container);
      loadBookmarks().then(stored => {
        // Store both the index page URL (for jumping back to the grid) and
        // the post's permalink (stable fallback when the post has moved pages).
        stored[id] = { page: getTruePageUrl(), post: postLink };
        return saveBookmarks(stored);
      }).then(() => {
        refreshJumpToast();
        showToast("Bookmarked!", "success");
        sendResponse({ ok: true });
      });
      return true;

    } else if (msg.type === "UNBOOKMARK") {
      removeBookmark(container);
      loadBookmarks().then(stored => {
        delete stored[id];
        return saveBookmarks(stored);
      }).then(() => {
        refreshJumpToast();
        showToast("Bookmark removed", "info");
        sendResponse({ ok: true });
      });
      return true;
    }
  });

})();
