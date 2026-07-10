import {
  ARRIVING_THRESHOLD_MIN,
  UPSTREAM_ETA_SAMPLE_SIZE,
  UPSTREAM_ETA_CACHE_TTL_MS,
  MIN_BUS_SPEED_M_PER_MIN,
  MAX_BUS_SPEED_M_PER_MIN,
  DEFAULT_BUS_SPEED_M_PER_MIN,
} from "./config.js";
import {
  fetchEta,
  fetchRouteStops,
  resolveRouteStopCoords,
  trackingNowMs,
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

function minutesUntil(isoEta, nowMs = Date.now()) {
  if (!isoEta) return null;
  const ms = new Date(isoEta).getTime() - nowMs;
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

function latLngFromCum(polyline, cumDist) {
  const point = pointAtCumDist(polyline, cumDist);
  return point ? { lat: point.lat, lng: point.lng, cumDist: point.cumDist } : null;
}

function segmentSpeedMPerMin(a, b) {
  const spanMs = b.etaMs - a.etaMs;
  if (spanMs <= 0) return null;
  const dist = b.cumDist - a.cumDist;
  if (dist <= 0) return null;
  return dist / (spanMs / 60_000);
}

/**
 * Drop upstream points whose ETA is later than a downstream stop.
 * Prefer mid-route evidence over terminus schedule noise so the marker
 * is not pinned at cumDist 0 until a future origin departure.
 * Chain must already be sorted by cumDist ascending.
 */
export function sanitizeEtaChain(chain) {
  if (!chain?.length) return chain ?? [];
  const out = [];
  for (const point of chain) {
    while (out.length && point.etaMs < out[out.length - 1].etaMs) {
      out.pop();
    }
    out.push(point);
  }
  return out;
}

/**
 * Furthest approach stop the boarding bus has already passed (no matching
 * upstream ETA before boarding). Floors placement so default-speed cannot
 * snap the marker back to the terminus after mid-route ETAs disappear.
 */
function passedStopFloor({
  routeStops,
  boardingIndex,
  upstreamEtas,
  first,
  polyline,
  stopCoordsById,
}) {
  const byStopId = new Map(
    (upstreamEtas ?? []).filter(Boolean).map((item) => [item.stopId, item])
  );
  let minCum = 0;

  for (const rs of routeStops.slice(0, boardingIndex)) {
    const item = byStopId.get(rs.stopId);
    if (!item) continue;

    if (matchBusEta(item.eta, first)?.eta) break;

    const stopCoord = stopCoordsById.get(rs.stopId);
    if (!stopCoord) continue;
    minCum = Math.max(minCum, nearestCumDist(polyline, stopCoord));
  }

  return minCum;
}

function buildEtaChain({
  routeStops,
  boardingIndex,
  boardingStopId,
  upstreamEtas,
  first,
  polyline,
  stopCoordsById,
  boardingCum,
}) {
  const byStopId = new Map(
    (upstreamEtas ?? []).filter(Boolean).map((item) => [item.stopId, item])
  );
  const chain = [];

  for (const rs of routeStops.slice(0, boardingIndex + 1)) {
    const stopCoord = stopCoordsById.get(rs.stopId);
    if (!stopCoord) continue;

    let etaMs = null;
    if (rs.stopId === boardingStopId) {
      etaMs = new Date(first.eta).getTime();
    } else {
      const item = byStopId.get(rs.stopId);
      if (!item) continue;
      const matched = matchBusEta(item.eta, first);
      if (!matched?.eta) continue;
      etaMs = new Date(matched.eta).getTime();
    }

    if (!Number.isFinite(etaMs)) continue;

    chain.push({
      stopId: rs.stopId,
      seq: rs.seq,
      etaMs,
      cumDist: nearestCumDist(polyline, stopCoord),
    });
  }

  chain.sort((a, b) => a.cumDist - b.cumDist);

  const deduped = [];
  for (const point of chain) {
    const prev = deduped[deduped.length - 1];
    if (prev && prev.stopId === point.stopId) continue;
    deduped.push(point);
  }

  const boardingPoint = deduped.find((p) => p.stopId === boardingStopId);
  if (boardingPoint) {
    boardingPoint.cumDist = boardingCum;
  }

  return sanitizeEtaChain(deduped);
}

/**
 * Place bus along polyline using matched per-stop ETAs and synced tracking time.
 * @param {number} [minCum=0] - floor from passed upstream stops
 */
export function positionFromEtaChain(
  chain,
  polyline,
  trackingNowMs,
  boardingCum,
  minCum = 0
) {
  if (!chain?.length || !polyline?.length) return null;
  const floor = Math.max(0, minCum);

  if (chain.length === 1) {
    const only = chain[0];
    if (trackingNowMs >= only.etaMs) {
      return latLngFromCum(
        polyline,
        Math.min(Math.max(floor, only.cumDist), boardingCum)
      );
    }
    return latLngFromCum(
      polyline,
      Math.max(floor, only.cumDist - DEFAULT_BUS_SPEED_M_PER_MIN)
    );
  }

  for (let i = 0; i < chain.length - 1; i++) {
    const a = chain[i];
    const b = chain[i + 1];
    if (trackingNowMs >= a.etaMs && trackingNowMs < b.etaMs) {
      const span = b.etaMs - a.etaMs;
      const progress = span > 0 ? (trackingNowMs - a.etaMs) / span : 0;
      const busCumDist = Math.min(
        boardingCum,
        Math.max(floor, a.cumDist + progress * (b.cumDist - a.cumDist))
      );
      return latLngFromCum(polyline, busCumDist);
    }
  }

  const first = chain[0];
  if (trackingNowMs < first.etaMs) {
    const next = chain[1];
    const speed =
      segmentSpeedMPerMin(first, next) ?? DEFAULT_BUS_SPEED_M_PER_MIN;
    const minsUntilFirst = (first.etaMs - trackingNowMs) / 60_000;
    const busCumDist = Math.max(
      floor,
      first.cumDist - speed * minsUntilFirst
    );
    return latLngFromCum(polyline, busCumDist);
  }

  const last = chain[chain.length - 1];
  if (trackingNowMs >= last.etaMs) {
    return latLngFromCum(
      polyline,
      Math.min(Math.max(floor, last.cumDist), boardingCum)
    );
  }

  // Between segment windows (e.g. non-monotonic ETAs): hold at last passed stop.
  for (let i = chain.length - 2; i >= 0; i--) {
    if (trackingNowMs >= chain[i].etaMs) {
      return latLngFromCum(
        polyline,
        Math.min(Math.max(floor, chain[i].cumDist), boardingCum)
      );
    }
  }

  return latLngFromCum(polyline, floor);
}

function placeFromEtaChain(chain, polyline, trackingNowMs, boardingCum, minCum = 0) {
  const placed = positionFromEtaChain(
    chain,
    polyline,
    trackingNowMs,
    boardingCum,
    minCum
  );
  if (!placed) return null;

  let speedMPerMin = null;
  for (let i = 0; i < chain.length - 1; i++) {
    const a = chain[i];
    const b = chain[i + 1];
    if (trackingNowMs >= a.etaMs && trackingNowMs < b.etaMs) {
      speedMPerMin = segmentSpeedMPerMin(a, b);
      break;
    }
  }

  return {
    reason: "segment",
    busCumDist: placed.cumDist,
    busLatLng: { lat: placed.lat, lng: placed.lng },
    speedMPerMin: speedMPerMin ? clampSpeed(speedMPerMin) : null,
    etaChain: chain,
  };
}

function placeWithDefaultSpeed(polyline, boardingCum, minutesToBoard, minCum = 0) {
  const speedMPerMin = DEFAULT_BUS_SPEED_M_PER_MIN;
  const remainingDist = speedMPerMin * minutesToBoard;
  const busCumDist = Math.max(
    minCum,
    Math.min(boardingCum, boardingCum - remainingDist)
  );
  const busLatLng = pointAtCumDist(polyline, busCumDist);

  return {
    reason: "default-speed",
    busCumDist,
    busLatLng: busLatLng
      ? { lat: busLatLng.lat, lng: busLatLng.lng }
      : null,
    speedMPerMin,
  };
}

function placeFromSegments(
  segments,
  polyline,
  boardingCum,
  minutesToBoard,
  minCum = 0
) {
  segments.sort((a, b) => a.dist - b.dist);
  const near = segments.slice(0, Math.min(3, segments.length));
  const totalWeight = near.reduce((sum, s) => sum + s.weight, 0);
  const rawSpeed =
    near.reduce((sum, s) => sum + s.speed * s.weight, 0) / totalWeight;

  if (!Number.isFinite(rawSpeed) || rawSpeed <= 0) {
    return placeWithDefaultSpeed(
      polyline,
      boardingCum,
      minutesToBoard,
      minCum
    );
  }

  const speedMPerMin = clampSpeed(rawSpeed);
  const remainingDist = speedMPerMin * minutesToBoard;
  let busCumDist = boardingCum - remainingDist;

  if (busCumDist <= 0) {
    busCumDist = Math.max(minCum, near[0].upCum);
  } else {
    busCumDist = Math.max(minCum, busCumDist);
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

function attachTrackingMeta(result, boardingEta) {
  return {
    ...result,
    snapshotMs: boardingEta?.snapshotMs ?? null,
    receivedAtMs: boardingEta?.receivedAtMs ?? null,
  };
}

/**
 * Derive bus position from live multi-stop ETAs on a road-snapped path.
 * OSRM road-snap and upstream ETA fetches run in parallel.
 *
 * @param {object} entry - watchlist entry
 * @param {object} boardingEta - fetchEta result for boarding stop
 * @param {{ denseUpstream?: boolean, refreshUpstream?: boolean }} [options]
 */
export async function estimateBusPosition(
  entry,
  boardingEta,
  { denseUpstream = false, refreshUpstream = false } = {}
) {
  const first = boardingEta?.first;
  if (!first?.eta) {
    return emptyEstimate({ reason: "no-eta" });
  }

  const nowMs = trackingNowMs(boardingEta);
  const minutesToBoard = minutesUntil(first.eta, nowMs);
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
    return attachTrackingMeta(
      {
        polyline: poly,
        routePolyline: poly,
        boardingStop: boardingOnly[0] ?? null,
        busLatLng: null,
        busCumDist: null,
        stops: boardingOnly,
        reason: "stop-not-on-route",
      },
      boardingEta
    );
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

  const upstreamStops = needUpstream
    ? denseUpstream
      ? routeStops.slice(0, boardingIndex)
      : sampleUpstreamStops(routeStops, boardingIndex, UPSTREAM_ETA_SAMPLE_SIZE)
    : [];

  const [approachRoad, fullRoad, upstreamEtas] = await Promise.all([
    roadSnapStops(coords),
    roadSnapStopsChunked(allCoords),
    needUpstream
      ? Promise.all(
          upstreamStops.map(async (rs) => {
            try {
              const eta = await fetchEta(
                entry.route,
                rs.stopId,
                entry.direction,
                {
                  useCache: !refreshUpstream,
                  cacheTtlMs: UPSTREAM_ETA_CACHE_TTL_MS,
                }
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

  const base = {
    polyline,
    routePolyline,
    boardingStop,
    boardingCumDist: boardingCum,
    stops,
    minutesToBoard,
    boardEtaMs: new Date(first.eta).getTime(),
  };

  if (boardingIndex === 0) {
    return attachTrackingMeta(
      {
        ...base,
        busLatLng: null,
        busCumDist: null,
        reason: "seq-1",
      },
      boardingEta
    );
  }

  if (minutesToBoard <= ARRIVING_THRESHOLD_MIN) {
    return attachTrackingMeta(
      {
        ...base,
        busLatLng: { lat: boardingStop.lat, lng: boardingStop.lng },
        busCumDist: boardingCum,
        reason: "arriving",
        speedMPerMin: null,
      },
      boardingEta
    );
  }

  const etaChain = buildEtaChain({
    routeStops,
    boardingIndex,
    boardingStopId: entry.stopId,
    upstreamEtas,
    first,
    polyline,
    stopCoordsById,
    boardingCum,
  });

  const minCum = passedStopFloor({
    routeStops,
    boardingIndex,
    upstreamEtas,
    first,
    polyline,
    stopCoordsById,
  });

  if (denseUpstream && etaChain.length >= 2) {
    const segmentPlaced = placeFromEtaChain(
      etaChain,
      polyline,
      nowMs,
      boardingCum,
      minCum
    );
    if (segmentPlaced?.busLatLng) {
      return attachTrackingMeta(
        {
          ...base,
          busLatLng: segmentPlaced.busLatLng,
          busCumDist: segmentPlaced.busCumDist,
          minCumDist: minCum,
          reason: segmentPlaced.reason,
          speedMPerMin: segmentPlaced.speedMPerMin,
          etaChain: segmentPlaced.etaChain,
        },
        boardingEta
      );
    }
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

  const placed =
    segments.length === 0
      ? placeWithDefaultSpeed(polyline, boardingCum, minutesToBoard, minCum)
      : placeFromSegments(
          segments,
          polyline,
          boardingCum,
          minutesToBoard,
          minCum
        );

  return attachTrackingMeta(
    {
      ...base,
      busLatLng: placed.busLatLng,
      busCumDist: placed.busCumDist,
      minCumDist: minCum,
      reason: placed.reason,
      speedMPerMin: placed.speedMPerMin,
      etaChain: etaChain.length >= 2 ? etaChain : null,
    },
    boardingEta
  );
}
