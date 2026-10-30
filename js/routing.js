import { readCache, writeCache } from "./cache.js";

const OSRM_BASE = "https://router.project-osrm.org/route/v1/driving";
const MAX_WAYPOINTS = 25;
const OSRM_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const OSRM_ENDPOINT_TOLERANCE_M = 2;

const routeCache = new Map();
const inflight = new Map();

function cacheKey(stops) {
  return stops.map((s) => `${s.lng},${s.lat}`).join(";");
}

function isCoordinate(coord) {
  return (
    Array.isArray(coord) &&
    coord.length >= 2 &&
    Number.isFinite(coord[0]) &&
    Number.isFinite(coord[1]) &&
    Math.abs(coord[0]) <= 180 &&
    Math.abs(coord[1]) <= 90
  );
}

function samePoint(a, b) {
  return a?.lat === b?.lat && a?.lng === b?.lng;
}

function matchesWaypoint(point, waypoint) {
  if (!point || !waypoint) return false;
  if (samePoint(point, waypoint)) return true;
  const radians = Math.PI / 180;
  const dLat = (point.lat - waypoint.lat) * radians;
  const dLng = (point.lng - waypoint.lng) * radians;
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(point.lat * radians) * Math.cos(waypoint.lat * radians) *
    Math.sin(dLng / 2) ** 2;
  const distance = 2 * 6_371_000 * Math.asin(Math.min(1, Math.sqrt(h)));
  return distance <= OSRM_ENDPOINT_TOLERANCE_M;
}

/** Only adjacent duplicates are redundant; a later loop revisit is distinct. */
function appendPoint(points, point) {
  if (!samePoint(points[points.length - 1], point)) points.push(point);
  return points.length - 1;
}

function straightRoute(stops) {
  const points = [];
  const stopIndices = stops.map(({ lat, lng }) =>
    appendPoint(points, { lat, lng })
  );
  return { points, stopIndices };
}

function validRoute(route, stopCount) {
  if (
    !Array.isArray(route?.points) ||
    !route.points.length ||
    !route.points.every((point) => isCoordinate([point?.lng, point?.lat])) ||
    !Array.isArray(route.stopIndices) ||
    route.stopIndices.length !== stopCount ||
    route.stopIndices[0] !== 0 ||
    route.stopIndices[stopCount - 1] !== route.points.length - 1
  ) return false;

  return route.stopIndices.every((index, i) =>
    Number.isInteger(index) &&
    index >= 0 &&
    index < route.points.length &&
    (i === 0 || index >= route.stopIndices[i - 1])
  );
}

/**
 * OSRM legs are between input waypoints, in their original order. Step
 * geometries are unsimplified with geometries=geojson; retain their boundaries
 * rather than searching the complete route for a nearest coordinate.
 */
async function fetchOsrmRoute(stops) {
  const coords = cacheKey(stops);
  const url = `${OSRM_BASE}/${coords}?overview=false&geometries=geojson&steps=true`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`OSRM HTTP ${response.status}`);

  const payload = await response.json();
  const legs = payload.routes?.[0]?.legs;
  if (
    payload.code !== "Ok" ||
    !Array.isArray(legs) ||
    legs.length !== stops.length - 1 ||
    !Array.isArray(payload.waypoints) ||
    payload.waypoints.length !== stops.length ||
    !payload.waypoints.every((waypoint) => isCoordinate(waypoint?.location))
  ) throw new Error(payload.message || "OSRM route has invalid waypoint legs");

  const snappedStops = payload.waypoints.map(({ location: [lng, lat] }) => ({
    lat,
    lng,
  }));
  const points = [{ ...snappedStops[0] }];
  const stopIndices = [0];

  for (let i = 0; i < legs.length; i++) {
    const leg = legs[i];
    const legPoints = [];
    if (!Array.isArray(leg?.steps)) {
      throw new Error("OSRM leg has no step geometry");
    }
    for (const step of leg.steps) {
      const geometry = step?.geometry;
      if (
        (geometry?.type != null && geometry.type !== "LineString") ||
        !Array.isArray(geometry?.coordinates) ||
        !geometry.coordinates.length ||
        !geometry.coordinates.every(isCoordinate)
      ) throw new Error("OSRM step has invalid geometry");

      const stepPoints = geometry.coordinates.map(([lng, lat]) => ({ lat, lng }));
      if (legPoints.length && !samePoint(legPoints[legPoints.length - 1], stepPoints[0])) {
        throw new Error("OSRM step geometry is discontinuous");
      }
      for (const point of stepPoints) appendPoint(legPoints, point);
    }

    // Repeated adjacent waypoints can legitimately have a zero-distance leg.
    if (!legPoints.length && leg.distance === 0 && samePoint(snappedStops[i], snappedStops[i + 1])) {
      legPoints.push(snappedStops[i]);
    }
    // Real OSRM step endpoints can differ slightly from snapped waypoints.
    // Leg order still owns each stop boundary; accept only a bounded 2 m gap
    // and retain the actual step geometry, without searching another leg.
    if (
      !matchesWaypoint(legPoints[0], snappedStops[i]) ||
      !matchesWaypoint(legPoints[legPoints.length - 1], snappedStops[i + 1])
    ) throw new Error("OSRM leg does not match its waypoint endpoints");

    for (const point of legPoints) appendPoint(points, point);
    stopIndices.push(points.length - 1);
  }

  return { points, stopIndices };
}

async function roadSnapChunk(stops) {
  const key = cacheKey(stops);
  if (routeCache.has(key)) return routeCache.get(key);

  // v2 stored only points and cannot identify later occurrences on a loop.
  const storageKey = `bus:osrm:v3:${key}`;
  const stored = readCache(storageKey, OSRM_TTL_MS);
  if (validRoute(stored, stops.length)) {
    routeCache.set(key, stored);
    return stored;
  }
  if (inflight.has(key)) return inflight.get(key);

  const promise = fetchOsrmRoute(stops)
    .then((route) => {
      routeCache.set(key, route);
      writeCache(storageKey, route);
      return route;
    })
    .catch((err) => {
      console.warn("Road snap failed, using stop-to-stop path:", err.message);
      // Fallbacks retain occurrence order but are retried, never cached.
      return straightRoute(stops);
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, promise);
  return promise;
}

/**
 * Road geometry with a boundary index for every input stop occurrence.
 * All waypoints are retained, using overlapping chunks of at most 25 stops.
 */
export async function roadSnapRoute(stops) {
  if (!stops?.length) return { points: [], stopIndices: [] };
  if (!stops.every((stop) => isCoordinate([stop?.lng, stop?.lat]))) {
    throw new Error("Cannot route invalid stop coordinates");
  }
  if (stops.length === 1) return straightRoute(stops);

  const chunks = [];
  for (let start = 0; start < stops.length - 1; start += MAX_WAYPOINTS - 1) {
    chunks.push(stops.slice(start, start + MAX_WAYPOINTS));
  }
  const parts = await Promise.all(chunks.map(roadSnapChunk));
  if (parts.length === 1) return parts[0];

  const points = [];
  const stopIndices = [];
  for (const part of parts) {
    if (!points.length) {
      points.push(...part.points);
      stopIndices.push(...part.stopIndices);
      continue;
    }

    // Different chunks can snap their shared stop onto slightly different
    // road coordinates. Keep that connector and the existing stop boundary.
    const duplicateJoin = samePoint(points[points.length - 1], part.points[0]);
    const offset = points.length - (duplicateJoin ? 1 : 0);
    points.push(...part.points.slice(duplicateJoin ? 1 : 0));
    stopIndices.push(...part.stopIndices.slice(1).map((index) => index + offset));
  }
  return { points, stopIndices };
}

/** Points-only compatibility API; both wrappers retain every waypoint. */
export async function roadSnapStops(stops) {
  return (await roadSnapRoute(stops)).points;
}

export async function roadSnapStopsChunked(stops) {
  return (await roadSnapRoute(stops)).points;
}
