import {
  ARRIVING_THRESHOLD_MIN,
  UPSTREAM_ETA_SAMPLE_SIZE,
  MIN_BUS_SPEED_M_PER_MIN,
  MAX_BUS_SPEED_M_PER_MIN,
} from "./config.js";
import {
  fetchEta,
  fetchRouteStops,
  resolveRouteStopCoords,
} from "./api.js";
import { roadSnapStops, roadSnapStopsChunked } from "./routing.js";

const EARTH_RADIUS_M = 6_371_000;

function toRad(deg) {
  return (deg * Math.PI) / 180;
}

export function haversineMeters(a, b) {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
}

/**
 * Build cumulative distances along a polyline.
 * Each point gets `cumDist` meters from the first point.
 */
export function buildPolyline(stops) {
  if (stops.length === 0) return [];

  const points = stops.map((s) => ({
    ...s,
    cumDist: 0,
  }));

  for (let i = 1; i < points.length; i++) {
    points[i].cumDist =
      points[i - 1].cumDist + haversineMeters(points[i - 1], points[i]);
  }

  return points;
}

/**
 * Interpolate a point at a given cumulative distance along the polyline.
 */
export function pointAtCumDist(points, cumDist) {
  if (!points.length) return null;

  const target = Math.max(0, Math.min(cumDist, points[points.length - 1].cumDist));

  if (target <= 0) {
    return { lat: points[0].lat, lng: points[0].lng, cumDist: 0 };
  }

  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    if (target >= a.cumDist && target <= b.cumDist) {
      const segLen = b.cumDist - a.cumDist;
      if (segLen <= 0) {
        return { lat: b.lat, lng: b.lng, cumDist: b.cumDist };
      }
      const t = (target - a.cumDist) / segLen;
      return {
        lat: a.lat + (b.lat - a.lat) * t,
        lng: a.lng + (b.lng - a.lng) * t,
        cumDist: target,
      };
    }
  }

  const end = points[points.length - 1];
  return { lat: end.lat, lng: end.lng, cumDist: end.cumDist };
}

/**
 * Walk backward `distanceM` meters from the end of the polyline.
 */
export function walkBackAlongPolyline(points, distanceM) {
  if (!points.length || distanceM < 0) return null;
  const end = points[points.length - 1];
  const targetCum = Math.max(0, end.cumDist - distanceM);
  return pointAtCumDist(points, targetCum);
}

/**
 * Nearest polyline cumDist to a lat/lng (for mapping stop coords onto road path).
 */
export function nearestCumDist(points, target) {
  if (!points.length) return 0;
  let best = points[0];
  let bestDist = haversineMeters(points[0], target);
  for (let i = 1; i < points.length; i++) {
    const d = haversineMeters(points[i], target);
    if (d < bestDist) {
      bestDist = d;
      best = points[i];
    }
  }
  return best.cumDist;
}

/**
 * Pick a spaced sample of upstream stop IDs (excluding boarding).
 */
export function sampleUpstreamStops(routeStops, boardingIndex, maxSamples) {
  if (boardingIndex <= 0 || maxSamples <= 0) return [];

  const upstream = routeStops.slice(0, boardingIndex);
  if (upstream.length <= maxSamples) {
    return upstream;
  }

  const sampled = [];
  const step = (upstream.length - 1) / (maxSamples - 1);
  for (let i = 0; i < maxSamples; i++) {
    const idx = Math.round(i * step);
    const stop = upstream[idx];
    if (!sampled.some((s) => s.stopId === stop.stopId)) {
      sampled.push(stop);
    }
  }
  return sampled;
}

function minutesUntil(isoEta) {
  if (!isoEta) return null;
  const ms = new Date(isoEta).getTime() - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return null;
  return ms / 60_000;
}

function matchBusEta(etaResult, reference) {
  if (!reference?.eta) return null;

  const boardTime = new Date(reference.eta).getTime();
  const candidates = [etaResult?.first, etaResult?.second]
    .filter((e) => e?.eta)
    .filter((e) => {
      if (reference.dest_en && e.dest_en && e.dest_en !== reference.dest_en) {
        return false;
      }
      return new Date(e.eta).getTime() < boardTime;
    })
    .sort(
      (a, b) => new Date(b.eta).getTime() - new Date(a.eta).getTime()
    );

  return candidates[0] ?? null;
}

function clampSpeed(speed) {
  return Math.min(
    MAX_BUS_SPEED_M_PER_MIN,
    Math.max(MIN_BUS_SPEED_M_PER_MIN, speed)
  );
}

function emptyEstimate(extra = {}) {
  return {
    polyline: [],
    routePolyline: [],
    boardingStop: null,
    busLatLng: null,
    busCumDist: null,
    stops: [],
    reason: "no-eta",
    ...extra,
  };
}

function placeFromSegments(segments, polyline, boardingCum, minutesToBoard) {
  segments.sort((a, b) => a.dist - b.dist);
  const near = segments.slice(0, Math.min(3, segments.length));
  const totalWeight = near.reduce((sum, s) => sum + s.weight, 0);
  const rawSpeed =
    near.reduce((sum, s) => sum + s.speed * s.weight, 0) / totalWeight;

  if (!Number.isFinite(rawSpeed) || rawSpeed <= 0) {
    return { reason: "invalid-speed", busCumDist: null, busLatLng: null, speedMPerMin: null };
  }

  const speedMPerMin = clampSpeed(rawSpeed);
  const remainingDist = speedMPerMin * minutesToBoard;
  let busCumDist = boardingCum - remainingDist;

  if (busCumDist <= 0) {
    busCumDist = Math.max(0, near[0].upCum);
  } else {
    busCumDist = Math.max(0, busCumDist);
  }

  busCumDist = Math.min(busCumDist, boardingCum);
  const busLatLng = pointAtCumDist(polyline, busCumDist);

  return {
    reason: "ok",
    busCumDist,
    busLatLng: busLatLng
      ? { lat: busLatLng.lat, lng: busLatLng.lng }
      : null,
    speedMPerMin,
  };
}

/**
 * Derive bus position from live multi-stop ETAs on a road-snapped path.
 * OSRM road-snap and upstream ETA fetches run in parallel.
 */
export async function estimateBusPosition(entry, boardingEta) {
  const first = boardingEta?.first;
  if (!first?.eta) {
    return emptyEstimate({ reason: "no-eta" });
  }

  const minutesToBoard = minutesUntil(first.eta);
  if (minutesToBoard == null) {
    return emptyEstimate({ reason: "no-eta" });
  }

  const routeStops = await fetchRouteStops(entry.route, entry.direction);
  const boardingIndex = routeStops.findIndex((s) => s.stopId === entry.stopId);

  if (boardingIndex < 0) {
    const boardingOnly = await resolveRouteStopCoords([
      { seq: 0, stopId: entry.stopId },
    ]);
    const poly = buildPolyline(boardingOnly);
    return {
      polyline: poly,
      routePolyline: poly,
      boardingStop: boardingOnly[0] ?? null,
      busLatLng: null,
      busCumDist: null,
      stops: boardingOnly,
      reason: "stop-not-on-route",
    };
  }

  const approachStops = routeStops.slice(0, boardingIndex + 1);
  const allCoords = await resolveRouteStopCoords(routeStops);
  if (!allCoords.length) {
    return emptyEstimate({ reason: "no-coords" });
  }

  const stopCoordsById = new Map(allCoords.map((c) => [c.stopId, c]));
  const boardingStopCoord = stopCoordsById.get(entry.stopId);
  if (!boardingStopCoord) {
    return emptyEstimate({ reason: "no-coords" });
  }

  const coords = [];
  for (const rs of approachStops) {
    const c = stopCoordsById.get(rs.stopId);
    if (c) coords.push(c);
  }
  if (!coords.length) {
    return emptyEstimate({ reason: "no-coords" });
  }

  const needUpstream =
    boardingIndex > 0 && minutesToBoard > ARRIVING_THRESHOLD_MIN;

  const upstreamSample = needUpstream
    ? sampleUpstreamStops(routeStops, boardingIndex, UPSTREAM_ETA_SAMPLE_SIZE)
    : [];

  const [approachRoad, fullRoad, upstreamEtas] = await Promise.all([
    roadSnapStops(coords),
    roadSnapStopsChunked(allCoords),
    needUpstream
      ? Promise.all(
          upstreamSample.map(async (rs) => {
            try {
              const eta = await fetchEta(
                entry.route,
                rs.stopId,
                entry.direction,
                { useCache: true }
              );
              return { stopId: rs.stopId, seq: rs.seq, eta };
            } catch {
              return null;
            }
          })
        )
      : Promise.resolve([]),
  ]);

  const polyline = buildPolyline(approachRoad);
  const routePolyline = buildPolyline(fullRoad);
  const boardingCum = nearestCumDist(polyline, boardingStopCoord);
  const boardingStop = {
    ...boardingStopCoord,
    cumDist: boardingCum,
  };
  const stops = coords.map((c) => ({
    ...c,
    cumDist: nearestCumDist(polyline, c),
    isBoarding: c.stopId === entry.stopId,
  }));

  if (boardingIndex === 0) {
    return {
      polyline,
      routePolyline,
      boardingStop,
      busLatLng: null,
      busCumDist: null,
      boardingCumDist: boardingCum,
      stops,
      reason: "seq-1",
    };
  }

  if (minutesToBoard <= ARRIVING_THRESHOLD_MIN) {
    return {
      polyline,
      routePolyline,
      boardingStop,
      busLatLng: { lat: boardingStop.lat, lng: boardingStop.lng },
      busCumDist: boardingCum,
      boardingCumDist: boardingCum,
      stops,
      reason: "arriving",
      speedMPerMin: null,
      minutesToBoard,
    };
  }

  const boardTime = new Date(first.eta).getTime();
  const segments = [];

  for (const item of upstreamEtas) {
    if (!item) continue;
    const matched = matchBusEta(item.eta, first);
    if (!matched?.eta) continue;

    const upstreamTime = new Date(matched.eta).getTime();
    const timeDeltaMin = (boardTime - upstreamTime) / 60_000;
    if (timeDeltaMin <= 0.25) continue;

    const stopCoord = stopCoordsById.get(item.stopId);
    if (!stopCoord) continue;

    const upCum = nearestCumDist(polyline, stopCoord);
    const dist = boardingCum - upCum;
    if (dist <= 0) continue;

    const speed = dist / timeDeltaMin;
    if (!Number.isFinite(speed) || speed <= 0) continue;

    segments.push({
      stopId: item.stopId,
      upCum,
      dist,
      timeDeltaMin,
      speed,
      weight: dist,
    });
  }

  if (segments.length === 0) {
    return {
      polyline,
      routePolyline,
      boardingStop,
      busLatLng: null,
      busCumDist: null,
      boardingCumDist: boardingCum,
      stops,
      reason: "no-upstream-match",
    };
  }

  const placed = placeFromSegments(
    segments,
    polyline,
    boardingCum,
    minutesToBoard
  );

  return {
    polyline,
    routePolyline,
    boardingStop,
    busLatLng: placed.busLatLng,
    busCumDist: placed.busCumDist,
    boardingCumDist: boardingCum,
    stops,
    reason: placed.reason,
    speedMPerMin: placed.speedMPerMin,
    minutesToBoard,
  };
}
