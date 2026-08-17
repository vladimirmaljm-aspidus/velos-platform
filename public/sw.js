/**
 * VELOS Service Worker — offline-first PWA support.
 *
 * Cache strategy routing:
 *   - Static assets (images, CSS, JS, fonts, svg, woff2):  cache-first
 *   - API requests (same-origin /api/...):                  stale-while-revalidate
 *   - Navigation requests (HTML documents):                 network-first, offline fallback
 *
 * Additional capabilities:
 *   - Precache on install (app shell + critical assets).
 *   - Cleanup of old caches on activate (velos-v* prefix; current = velos-v1).
 *   - Background sync: replay failed POST/PUT/DELETE/PATCH requests.
 *   - Push notifications: render incoming push payloads as system notifications.
 *   - Notification click: focus an existing VELOS tab or open a new one.
 *
 * Versioning: bump CACHE_VERSION (and thus CACHE_NAME) to invalidate all
 * previous caches on the next activate. Old `velos-v<N>` caches are wiped.
 */

const CACHE_VERSION = "v1";
const CACHE_NAME = `velos-${CACHE_VERSION}`;
const STATIC_CACHE = `${CACHE_NAME}-static`;
const API_CACHE = `${CACHE_NAME}-api`;
const OFFLINE_URL = "/offline";

/** App-shell + critical assets precached on install. */
const PRECACHE_URLS = [
  "/",
  "/manifest.json",
  "/favicon.svg",
  "/logo.svg",
  "/icon",
  "/apple-icon",
  "/offline",
];

/** Regex matching static-asset requests (cache-first strategy). */
const STATIC_ASSET_PATTERN =
  /\.(?:js|css|woff2?|ttf|otf|eot|png|jpg|jpeg|gif|webp|avif|svg|ico)$/i;

/** Regex matching same-origin API requests (stale-while-revalidate). */
const API_PATH_PATTERN = /^\/api\//;

/** In-flight failed mutations awaiting background-sync replay. */
const FAILED_MUTATIONS_STORE = "velos-failed-mutations";
const SYNC_TAG = "velos-replay-mutations";

// ─────────────────────────────────────────────────────────────────────────────
// Install — precache the app shell.
// ─────────────────────────────────────────────────────────────────────────────
self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(STATIC_CACHE);
      // Use `addAll` with per-URL error tolerance — a single precache URL
      // failing (e.g. /icon not yet built in dev) must not abort the SW.
      await Promise.all(
        PRECACHE_URLS.map(async (url) => {
          try {
            // `reload: true` ensures we precache a fresh copy, not a stale
            // intermediate-cache version (relevant behind CDNs).
            const res = await fetch(url, { cache: "reload" });
            if (res && (res.ok || res.type === "opaque")) {
              await cache.put(url, res.clone());
            }
          } catch (_err) {
            // Swallow — install still succeeds; asset will be cached on-demand
            // by the fetch handler when the browser requests it.
          }
        })
      );
      // Activate immediately — don't wait for existing clients to close.
      await self.skipWaiting();
    })()
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Activate — purge old caches and claim existing clients.
// ─────────────────────────────────────────────────────────────────────────────
self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      // Wipe any cache that doesn't belong to the current `velos-v1` family
      // (including older `velos-v0`, `velos-v1-beta`, etc.).
      await Promise.all(
        keys
          .filter(
            (key) =>
              key.startsWith("velos-") &&
              key !== STATIC_CACHE &&
              key !== API_CACHE
          )
          .map((key) => caches.delete(key))
      );
      // Take control of all open tabs (so the new SW applies immediately).
      await self.clients.claim();
    })()
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Fetch — route to the appropriate cache strategy.
// ─────────────────────────────────────────────────────────────────────────────
self.addEventListener("fetch", (event) => {
  const { request } = event;

  // Only handle GET via the cache strategies; mutations go through the
  // background-sync path below (POST/PUT/PATCH/DELETE).
  if (request.method !== "GET") {
    // Intercept failed mutations for background-sync replay.
    if (
      "sync" in self.registration &&
      (request.method === "POST" ||
        request.method === "PUT" ||
        request.method === "PATCH" ||
        request.method === "DELETE")
    ) {
      event.respondWith(handleMutation(request));
    }
    return;
  }

  const url = new URL(request.url);

  // Cross-origin requests: pass through (don't cache opaque responses by
  // default — they'd consume cache quota without serving range requests).
  if (url.origin !== self.location.origin) {
    return;
  }

  // Navigation requests (HTML pages) → network-first with offline fallback.
  if (request.mode === "navigate") {
    event.respondWith(networkFirst(request));
    return;
  }

  // API requests → stale-while-revalidate.
  if (API_PATH_PATTERN.test(url.pathname)) {
    event.respondWith(staleWhileRevalidate(request));
    return;
  }

  // Static assets → cache-first.
  if (
    STATIC_ASSET_PATTERN.test(url.pathname) ||
    request.destination === "style" ||
    request.destination === "script" ||
    request.destination === "font" ||
    request.destination === "image"
  ) {
    event.respondWith(cacheFirst(request));
    return;
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Cache strategies.
// ─────────────────────────────────────────────────────────────────────────────

/** Cache-first: serve from cache, fall back to network, cache the response. */
async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  try {
    const res = await fetch(request);
    if (res && (res.ok || res.type === "opaque")) {
      const cache = await caches.open(STATIC_CACHE);
      cache.put(request, res.clone());
    }
    return res;
  } catch (_err) {
    // No cache, no network — return a generic offline placeholder for images.
    return new Response("", { status: 504, statusText: "Offline" });
  }
}

/** Stale-while-revalidate: serve cache, refresh in background. */
async function staleWhileRevalidate(request) {
  const cache = await caches.open(API_CACHE);
  const cached = await cache.match(request);
  const networkPromise = fetch(request)
    .then((res) => {
      // Only cache successful, non-error JSON/GET responses.
      if (res && res.ok) {
        cache.put(request, res.clone());
      }
      return res;
    })
    .catch(() => null);
  // Return cached immediately if available; otherwise wait for the network.
  return cached || (await networkPromise) || new Response("Offline", {
    status: 503,
    headers: { "Content-Type": "application/json" },
  });
}

/** Network-first: try network, fall back to cache, then offline page. */
async function networkFirst(request) {
  try {
    const res = await fetch(request);
    // Cache successful navigations for offline use.
    if (res && res.ok) {
      const cache = await caches.open(STATIC_CACHE);
      cache.put(request, res.clone());
    }
    return res;
  } catch (_err) {
    const cached = await caches.match(request);
    if (cached) return cached;
    const offline = await caches.match(OFFLINE_URL);
    return (
      offline ||
      new Response("You are offline.", {
        status: 503,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      })
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Background sync — replay failed mutations.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Intercept mutation requests. If the network fails, stash the request in
 * IndexedDB and register a background-sync task for later replay.
 */
async function handleMutation(request) {
  try {
    const res = await fetch(request.clone());
    if (!res.ok && res.status >= 500) {
      // 5xx — server-side transient failure, queue for retry.
      await queueFailedMutation(request);
    }
    return res;
  } catch (_err) {
    // Network failure — queue for retry.
    await queueFailedMutation(request);
    return new Response(
      JSON.stringify({ error: "offline", queued: true }),
      {
        status: 503,
        headers: { "Content-Type": "application/json" },
      }
    );
  }
}

async function queueFailedMutation(request) {
  try {
    const body = await request.clone().text();
    const entry = {
      url: request.url,
      method: request.method,
      headers: Object.fromEntries(request.headers.entries()),
      body: body || null,
      timestamp: Date.now(),
    };
    const db = await openMutationDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(FAILED_MUTATIONS_STORE, "readwrite");
      tx.objectStore(FAILED_MUTATIONS_STORE).add(entry);
      tx.oncomplete = () => resolve(undefined);
      tx.onerror = () => reject(tx.error);
    });
    await self.registration.sync.register(SYNC_TAG);
  } catch (_err) {
    // IndexedDB unavailable (e.g. private mode) — silently give up; the
    // mutation is lost. The user-facing UI will still show an error toast.
  }
}

async function replayFailedMutations() {
  const db = await openMutationDB();
  const all = await new Promise((resolve, reject) => {
    const tx = db.transaction(FAILED_MUTATIONS_STORE, "readonly");
    const req = tx.objectStore(FAILED_MUTATIONS_STORE).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
  for (const entry of all) {
    try {
      const init = {
        method: entry.method,
        headers: entry.headers,
      };
      if (entry.body && entry.method !== "GET" && entry.method !== "HEAD") {
        init.body = entry.body;
      }
      const res = await fetch(entry.url, init);
      if (res.ok) {
        await new Promise((resolve) => {
          const tx = db.transaction(FAILED_MUTATIONS_STORE, "readwrite");
          tx.objectStore(FAILED_MUTATIONS_STORE).delete(entry.id);
          tx.oncomplete = () => resolve(undefined);
          tx.onerror = () => resolve(undefined);
        });
      }
      // Non-ok responses stay queued for the next sync event.
    } catch (_err) {
      // Network still down — leave in queue; sync will fire again.
    }
  }
}

function openMutationDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("velos-sw-db", 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(FAILED_MUTATIONS_STORE)) {
        db.createObjectStore(FAILED_MUTATIONS_STORE, {
          keyPath: "id",
          autoIncrement: true,
        });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

self.addEventListener("sync", (event) => {
  if (event.tag === SYNC_TAG) {
    event.waitUntil(replayFailedMutations());
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Push notifications.
// ─────────────────────────────────────────────────────────────────────────────

self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch (_err) {
    payload = { title: "VELOS", body: event.data ? event.data.text() : "" };
  }
  const title = payload.title || "VELOS";
  const options = {
    body: payload.body || "",
    icon: payload.icon || "/icon",
    badge: payload.badge || "/icon",
    data: payload.data || { url: "/" },
    tag: payload.tag || "velos-notification",
    renotify: Boolean(payload.renotify),
    requireInteraction: Boolean(payload.requireInteraction),
    silent: Boolean(payload.silent),
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl =
    (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil(
    (async () => {
      const allClients = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      // Focus an existing VELOS tab if one is open.
      for (const client of allClients) {
        const clientUrl = new URL(client.url);
        if (clientUrl.origin === self.location.origin) {
          if ("focus" in client) {
            await client.focus();
            // Navigate the existing tab to the target URL if requested.
            if (targetUrl && clientUrl.pathname !== targetUrl) {
              client.postMessage({ type: "velos-navigate", url: targetUrl });
            }
            return;
          }
        }
      }
      // Otherwise open a new tab.
      if (self.clients.openWindow) {
        await self.clients.openWindow(targetUrl);
      }
    })()
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Message channel — allow the page to trigger skipWaiting (for "update
// available" UX) and force a cache refresh.
// ─────────────────────────────────────────────────────────────────────────────

self.addEventListener("message", (event) => {
  const data = event.data || {};
  if (data.type === "SKIP_WAITING") {
    self.skipWaiting();
  } else if (data.type === "CLEAR_CACHES") {
    event.waitUntil(
      Promise.all([caches.delete(STATIC_CACHE), caches.delete(API_CACHE)])
    );
  }
});
