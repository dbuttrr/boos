import { readCache, writeCache } from "./cache.js";

const BASE_URL = "https://rt.data.gov.hk/v2/transport/citybus";

const stopCache = new Map();
const routeStopCache = new Map();
const etaCache = new Map();
const stopInflight = new Map();
const routeStopInflight = new Map();

const ETA_CACHE_TTL_MS = 15_000;
const STOP_TTL_MS = 24 * 60 * 60 * 1000;
const ROUTE_STOP_TTL_MS = 24 * 60 * 60 * 1000;

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

export async function fetchEta(route, stopId, direction, { useCache = false } = {}) {
  const cacheKey = `${route}|${stopId}|${direction ?? ""}`;

  if (useCache) {
    const cached = etaCache.get(cacheKey);
    if (cached && Date.now() - cached.at < ETA_CACHE_TTL_MS) {
      return cached.value;
    }
  }

  const url = `${BASE_URL}/eta/CTB/${stopId}/${route}`;
  const payload = await fetchJson(url);
  const entries = payload.data ?? [];
  const { first, second } = pickArrivals(entries, direction);

  const value = {
    first,
    second,
    generatedAt: payload.generated_timestamp ?? null,
  };

  etaCache.set(cacheKey, { at: Date.now(), value });
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

export function formatTime(isoString) {
  if (!isoString) return "";
  return new Date(isoString).toLocaleTimeString("en-HK", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}
