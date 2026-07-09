import { readCache, writeCache } from "./cache.js";

const OSRM_BASE = "https://router.project-osrm.org/route/v1/driving";
const MAX_WAYPOINTS = 25;
const OSRM_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const routeCache = new Map();
const inflight = new Map();

function cacheKey(stops) {
  return stops.map((s) => `${s.lng.toFixed(5)},${s.lat.toFixed(5)}`).join(";");
}

/**
 * Thin out waypoints if there are too many for a single OSRM request,
 * always keeping the first and last stop.
 */
function thinWaypoints(stops, max = MAX_WAYPOINTS) {
  if (stops.length <= max) return stops;
  const result = [stops[0]];
  const inner = max - 2;
  const step = (stops.length - 1) / (inner + 1);
  for (let i = 1; i <= inner; i++) {
    const idx = Math.round(i * step);
    const stop = stops[idx];
    if (stop !== result[result.length - 1]) {
      result.push(stop);
    }
  }
  const last = stops[stops.length - 1];
  if (result[result.length - 1] !== last) {
    result.push(last);
  }
  return result;
}

async function fetchOsrmRoute(stops) {
  const waypoints = thinWaypoints(stops);
  const coords = waypoints.map((s) => `${s.lng},${s.lat}`).join(";");
  const url = `${OSRM_BASE}/${coords}?overview=full&geometries=geojson&steps=false`;

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`OSRM HTTP ${response.status}`);
  }

  const payload = await response.json();
  if (payload.code !== "Ok" || !payload.routes?.[0]?.geometry?.coordinates) {
    throw new Error(payload.message || "OSRM route failed");
  }

  // GeoJSON is [lng, lat]
  return payload.routes[0].geometry.coordinates.map(([lng, lat]) => ({
    lat,
    lng,
  }));
}

/**
 * Snap an ordered list of stop coords to a road-following polyline via OSRM.
 * Falls back to the input stops (straight segments) on failure.
 * Results are cached in memory and localStorage.
 */
export async function roadSnapStops(stops) {
  if (!stops?.length) return [];
  if (stops.length === 1) {
    return [{ lat: stops[0].lat, lng: stops[0].lng }];
  }

  const key = cacheKey(stops);
  if (routeCache.has(key)) {
    return routeCache.get(key);
  }

  const storageKey = `bus:osrm:v2:${key}`;
  const stored = readCache(storageKey, OSRM_TTL_MS);
  if (stored?.length >= 2) {
    routeCache.set(key, stored);
    return stored;
  }

  if (inflight.has(key)) {
    return inflight.get(key);
  }

  const promise = (async () => {
    try {
      const road = await fetchOsrmRoute(stops);
      if (road.length < 2) {
        throw new Error("OSRM returned too few points");
      }
      routeCache.set(key, road);
      writeCache(storageKey, road);
      return road;
    } catch (err) {
      console.warn("Road snap failed, using stop-to-stop path:", err.message);
      const fallback = stops.map((s) => ({ lat: s.lat, lng: s.lng }));
      return fallback;
    } finally {
      inflight.delete(key);
    }
  })();

  inflight.set(key, promise);
  return promise;
}

/**
 * Snap a long stop list by overlapping windows of ≤ MAX_WAYPOINTS so every
 * stop stays a waypoint (no thinning). Chunks share one stop at the join.
 */
export async function roadSnapStopsChunked(stops) {
  if (!stops?.length) return [];
  if (stops.length <= MAX_WAYPOINTS) {
    return roadSnapStops(stops);
  }

  const chunks = [];
  let start = 0;
  while (start < stops.length) {
    const end = Math.min(start + MAX_WAYPOINTS, stops.length);
    chunks.push(stops.slice(start, end));
    if (end >= stops.length) break;
    // Overlap one stop so the next chunk continues from the join
    start = end - 1;
  }

  const parts = await Promise.all(chunks.map((chunk) => roadSnapStops(chunk)));
  const merged = [];
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (!part.length) continue;
    if (i === 0) {
      merged.push(...part);
    } else {
      // Drop duplicate join point from the start of this chunk
      merged.push(...part.slice(1));
    }
  }
  return merged;
}
