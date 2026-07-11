import { readCache, writeCache } from "./cache.js";

const BASE_URL = "https://rt.data.gov.hk/v2/transport/citybus";

const stopCache = new Map();
const routeStopCache = new Map();
const routeListCache = new Map();
const routeMetaCache = new Map();
const etaCache = new Map();
const stopInflight = new Map();
const routeStopInflight = new Map();
const routeListInflight = new Map();
const routeMetaInflight = new Map();
const stopRouteCache = new Map();
const stopRouteInflight = new Map();
let stopsIndexCache = null;
let stopsIndexInflight = null;

const ETA_CACHE_TTL_MS = 15_000;
const STOP_TTL_MS = 24 * 60 * 60 * 1000;
const ROUTE_STOP_TTL_MS = 24 * 60 * 60 * 1000;
const ROUTE_LIST_TTL_MS = 24 * 60 * 60 * 1000;
const ROUTE_META_TTL_MS = 24 * 60 * 60 * 1000;
const STOP_ROUTE_TTL_MS = 24 * 60 * 60 * 1000;
const STOPS_INDEX_TTL_MS = 24 * 60 * 60 * 1000;
const STOPS_INDEX_STORAGE_KEY = "bus:stops-index:CTB";
const STOPS_INDEX_BATCH = 20;

function parseIsoMs(iso) {
  if (!iso) return null;
  const ms = new Date(iso).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function snapshotMsFromPayload(payload, first, second) {
  const fromEntries = [first, second]
    .map((e) => parseIsoMs(e?.data_timestamp))
    .filter((ms) => ms != null);
  if (fromEntries.length) {
    return Math.min(...fromEntries);
  }
  return parseIsoMs(payload.generated_timestamp);
}

/** Advance API snapshot time using local clock since fetch. */
export function trackingNowMs(etaBundle) {
  if (etaBundle?.snapshotMs == null || etaBundle?.receivedAtMs == null) {
    return Date.now();
  }
  return etaBundle.snapshotMs + (Date.now() - etaBundle.receivedAtMs);
}

function pickArrivals(entries, direction) {
  let filtered = entries;

  if (direction) {
    filtered = entries.filter((e) => e.dir === direction);
  }

  const upcoming = filtered
    .filter((e) => e.eta && new Date(e.eta).getTime() > Date.now())
    .sort((a, b) => new Date(a.eta).getTime() - new Date(b.eta).getTime());

  if (upcoming.length > 0) {
    return {
      first: upcoming[0],
      second: upcoming[1] ?? null,
    };
  }

  const remarkOnly = filtered.find((e) => !e.eta && e.rmk_en);
  if (remarkOnly) {
    return { first: remarkOnly, second: null };
  }

  return { first: null, second: null };
}

export function formatArrivalDisplay(entry) {
  if (!entry) {
    return { text: "—", variant: "none" };
  }

  if (entry.rmk_en && !entry.eta) {
    return { text: entry.rmk_en, variant: "remark" };
  }

  if (!entry.eta) {
    return { text: "—", variant: "none" };
  }

  return { text: formatTime(entry.eta), variant: "default" };
}

async function fetchJson(url) {
  const response = await fetch(url);

  if (!response.ok) {
    let message = `HTTP ${response.status}`;
    try {
      const body = await response.json();
      if (body.message) message = body.message;
    } catch {
      // ignore parse errors
    }
    throw new Error(message);
  }

  return response.json();
}

export async function fetchEta(
  route,
  stopId,
  direction,
  { useCache = false, cacheTtlMs = ETA_CACHE_TTL_MS } = {}
) {
  const cacheKey = `${route}|${stopId}|${direction ?? ""}`;

  if (useCache) {
    const cached = etaCache.get(cacheKey);
    if (cached && Date.now() - cached.at < cacheTtlMs) {
      return cached.value;
    }
  }

  const url = `${BASE_URL}/eta/CTB/${stopId}/${route}`;
  const payload = await fetchJson(url);
  const entries = payload.data ?? [];
  const { first, second } = pickArrivals(entries, direction);

  const receivedAtMs = Date.now();
  const value = {
    first,
    second,
    generatedAt: payload.generated_timestamp ?? null,
    snapshotMs: snapshotMsFromPayload(payload, first, second),
    receivedAtMs,
  };

  etaCache.set(cacheKey, { at: receivedAtMs, value });
  return value;
}

export async function fetchStop(stopId) {
  if (stopCache.has(stopId)) {
    return stopCache.get(stopId);
  }

  const storageKey = `bus:stop:${stopId}`;
  const stored = readCache(storageKey, STOP_TTL_MS);
  if (stored) {
    stopCache.set(stopId, stored);
    return stored;
  }

  if (stopInflight.has(stopId)) {
    return stopInflight.get(stopId);
  }

  const promise = (async () => {
    const payload = await fetchJson(`${BASE_URL}/stop/${stopId}`);
    const data = payload.data;
    if (!data) {
      throw new Error(`Stop ${stopId} not found`);
    }

    const stop = {
      id: data.stop,
      nameEn: data.name_en,
      lat: Number(data.lat),
      lng: Number(data.long),
    };

    stopCache.set(stopId, stop);
    writeCache(storageKey, stop);
    return stop;
  })().finally(() => {
    stopInflight.delete(stopId);
  });

  stopInflight.set(stopId, promise);
  return promise;
}

function normalizeRouteMeta(data) {
  return {
    route: data.route,
    origEn: data.orig_en,
    origTc: data.orig_tc,
    destEn: data.dest_en,
    destTc: data.dest_tc,
  };
}

export async function fetchRoutes() {
  const cacheKey = "all";
  if (routeListCache.has(cacheKey)) {
    return routeListCache.get(cacheKey);
  }

  const storageKey = "bus:routes:all";
  const stored = readCache(storageKey, ROUTE_LIST_TTL_MS);
  if (stored) {
    routeListCache.set(cacheKey, stored);
    return stored;
  }

  if (routeListInflight.has(cacheKey)) {
    return routeListInflight.get(cacheKey);
  }

  const promise = (async () => {
    const payload = await fetchJson(`${BASE_URL}/route/CTB`);
    const routes = (payload.data ?? [])
      .map((item) => ({
        route: item.route,
        origEn: item.orig_en,
        destEn: item.dest_en,
      }))
      .sort((a, b) =>
        a.route.localeCompare(b.route, undefined, { numeric: true })
      );

    routeListCache.set(cacheKey, routes);
    writeCache(storageKey, routes);
    return routes;
  })().finally(() => {
    routeListInflight.delete(cacheKey);
  });

  routeListInflight.set(cacheKey, promise);
  return promise;
}

export async function fetchRouteMeta(route) {
  const cacheKey = route.toUpperCase();
  if (routeMetaCache.has(cacheKey)) {
    return routeMetaCache.get(cacheKey);
  }

  const storageKey = `bus:route-meta:${cacheKey}`;
  const stored = readCache(storageKey, ROUTE_META_TTL_MS);
  if (stored) {
    routeMetaCache.set(cacheKey, stored);
    return stored;
  }

  if (routeMetaInflight.has(cacheKey)) {
    return routeMetaInflight.get(cacheKey);
  }

  const promise = (async () => {
    const payload = await fetchJson(`${BASE_URL}/route/CTB/${encodeURIComponent(route)}`);
    const data = payload.data;
    if (!data) {
      throw new Error(`Route ${route} not found`);
    }

    const meta = normalizeRouteMeta(data);
    routeMetaCache.set(cacheKey, meta);
    writeCache(storageKey, meta);
    return meta;
  })().finally(() => {
    routeMetaInflight.delete(cacheKey);
  });

  routeMetaInflight.set(cacheKey, promise);
  return promise;
}

export async function fetchRouteStops(route, direction) {
  const dirPath = direction === "I" ? "inbound" : "outbound";
  const cacheKey = `${route}|${dirPath}`;

  if (routeStopCache.has(cacheKey)) {
    return routeStopCache.get(cacheKey);
  }

  const storageKey = `bus:route-stop:${cacheKey}`;
  const stored = readCache(storageKey, ROUTE_STOP_TTL_MS);
  if (stored) {
    routeStopCache.set(cacheKey, stored);
    return stored;
  }

  if (routeStopInflight.has(cacheKey)) {
    return routeStopInflight.get(cacheKey);
  }

  const promise = (async () => {
    const payload = await fetchJson(
      `${BASE_URL}/route-stop/CTB/${route}/${dirPath}`
    );
    const stops = (payload.data ?? [])
      .slice()
      .sort((a, b) => a.seq - b.seq)
      .map((item) => ({
        seq: item.seq,
        stopId: item.stop,
        dir: item.dir,
      }));

    routeStopCache.set(cacheKey, stops);
    writeCache(storageKey, stops);
    return stops;
  })().finally(() => {
    routeStopInflight.delete(cacheKey);
  });

  routeStopInflight.set(cacheKey, promise);
  return promise;
}

/**
 * Resolve lat/lng for an ordered list of route-stop entries.
 * Returns only stops that successfully resolved.
 */
export async function resolveRouteStopCoords(routeStops) {
  const results = await Promise.all(
    routeStops.map(async (rs) => {
      try {
        const stop = await fetchStop(rs.stopId);
        return {
          seq: rs.seq,
          stopId: rs.stopId,
          lat: stop.lat,
          lng: stop.lng,
          nameEn: stop.nameEn,
        };
      } catch {
        return null;
      }
    })
  );
  return results.filter(Boolean);
}

/**
 * Prefetch route-stop list + stop coords for a watchlist entry (warm caches).
 */
export async function prefetchRouteGeometry(entry) {
  const routeStops = await fetchRouteStops(entry.route, entry.direction);
  return resolveRouteStopCoords(routeStops);
}

export async function fetchStopRoutes(stopId) {
  const cacheKey = stopId;
  if (stopRouteCache.has(cacheKey)) {
    return stopRouteCache.get(cacheKey);
  }

  const storageKey = `bus:stop-route:${stopId}`;
  const stored = readCache(storageKey, STOP_ROUTE_TTL_MS);
  if (stored) {
    stopRouteCache.set(cacheKey, stored);
    return stored;
  }

  if (stopRouteInflight.has(cacheKey)) {
    return stopRouteInflight.get(cacheKey);
  }

  const promise = (async () => {
    const payload = await fetchJson(
      `https://rt.data.gov.hk/v1.1/transport/batch/stop-route/CTB/${stopId}`
    );
    const routes = (payload.data ?? [])
      .filter((item) => item.co === "CTB" && item.route && item.dir)
      .map((item) => ({
        route: item.route,
        direction: item.dir,
        seq: item.seq,
      }))
      .sort((a, b) =>
        a.route.localeCompare(b.route, undefined, { numeric: true })
      );

    stopRouteCache.set(cacheKey, routes);
    writeCache(storageKey, routes);
    return routes;
  })().finally(() => {
    stopRouteInflight.delete(cacheKey);
  });

  stopRouteInflight.set(cacheKey, promise);
  return promise;
}

async function buildStopsIndex() {
  const routes = await fetchRoutes();
  const stopIds = new Set();

  for (let i = 0; i < routes.length; i += STOPS_INDEX_BATCH) {
    const batch = routes.slice(i, i + STOPS_INDEX_BATCH);
    await Promise.all(
      batch.map(async (item) => {
        for (const direction of ["O", "I"]) {
          try {
            const routeStops = await fetchRouteStops(item.route, direction);
            for (const rs of routeStops) {
              stopIds.add(rs.stopId);
            }
          } catch {
            // ignore per-route failures
          }
        }
      })
    );
  }

  const ids = [...stopIds];
  const stops = [];

  for (let i = 0; i < ids.length; i += STOPS_INDEX_BATCH) {
    const batch = ids.slice(i, i + STOPS_INDEX_BATCH);
    const resolved = await Promise.all(
      batch.map(async (id) => {
        try {
          const stop = await fetchStop(id);
          return {
            stopId: stop.id,
            nameEn: stop.nameEn,
            lat: stop.lat,
            lng: stop.lng,
          };
        } catch {
          return null;
        }
      })
    );
    stops.push(...resolved.filter(Boolean));
  }

  return stops;
}

/**
 * CTB stop catalog with coords — built from route-stop lists, cached 24h.
 */
export async function ensureStopsIndex() {
  if (stopsIndexCache) {
    return stopsIndexCache;
  }

  const stored = readCache(STOPS_INDEX_STORAGE_KEY, STOPS_INDEX_TTL_MS);
  if (stored?.length) {
    stopsIndexCache = stored;
    return stored;
  }

  if (stopsIndexInflight) {
    return stopsIndexInflight;
  }

  stopsIndexInflight = buildStopsIndex()
    .then((index) => {
      stopsIndexCache = index;
      writeCache(STOPS_INDEX_STORAGE_KEY, index);
      stopsIndexInflight = null;
      return index;
    })
    .catch((err) => {
      stopsIndexInflight = null;
      throw err;
    });

  return stopsIndexInflight;
}

export function formatTime(isoString) {
  if (!isoString) return "";
  return new Date(isoString).toLocaleTimeString("en-HK", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}
