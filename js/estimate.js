import {
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
import { roadSnapRoute } from "./routing.js";

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
 * Pick a spaced sample of upstream stop occurrences (excluding boarding).
 */
export function sampleUpstreamStops(routeStops, boardingIndex, maxSamples) {
  if (boardingIndex <= 0 || maxSamples <= 0) return [];

  const upstream = routeStops.slice(0, boardingIndex);
  if (upstream.length <= maxSamples) {
    return upstream;
  }

  if (maxSamples === 1) return [upstream[upstream.length - 1]];

  const sampled = [];
  const step = (upstream.length - 1) / (maxSamples - 1);
  for (let i = 0; i < maxSamples; i++) {
    const idx = Math.round(i * step);
    const stop = upstream[idx];
    if (!sampled.some((s) => Number(s.seq) === Number(stop.seq))) {
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

/**
 * Pick the boarding-stop ETA still ahead of the tracking clock.
 * If `first` is past and `second` is upcoming, hand off to the next bus.
 */
export function resolveActiveBoardingEta(boardingEta) {
  const nowMs = trackingNowMs(boardingEta);
  const first = boardingEta?.first ?? null;
  const second = boardingEta?.second ?? null;

  if (first?.eta && minutesUntil(first.eta, nowMs) != null) {
    return { active: first, handedOff: false, nowMs };
  }
  if (second?.eta && minutesUntil(second.eta, nowMs) != null) {
    return { active: second, handedOff: true, nowMs };
  }
  return {
    active: null,
    handedOff: Boolean(first?.eta || second?.eta),
    nowMs,
  };
}

/**
 * True when covering `distM` between two ETAs does not imply speed above
 * MAX_BUS_SPEED (following-bus / schedule noise). Idle/slow legs are allowed.
 */
function isPlausibleLeg(distM, fromMs, toMs) {
  const dtMin = (toMs - fromMs) / 60_000;
  if (dtMin <= 0) return false;
  if (!(distM > 0)) return true;
  return distM / dtMin <= MAX_BUS_SPEED_M_PER_MIN;
}

/**
 * Correlate an upstream stop ETA to the boarding bus.
 * Prefers the earliest plausible ETA before boarding (furthest along the
 * route). Latest-before-boarding wrongly matches the following bus on
 * multi-bus routes and parks the marker far upstream.
 *
 * @param {number|null} [distToBoardM] - meters from this stop to boarding;
 *   when set, rejects candidates that imply speed above MAX_BUS_SPEED.
 */
function matchBusEta(etaResult, reference, distToBoardM = null) {
  if (!reference?.eta) return null;

  const boardTime = new Date(reference.eta).getTime();
  const candidates = [etaResult?.first, etaResult?.second]
    .filter((e) => e?.eta)
    .filter((e) => {
      if (reference.dest_en && e.dest_en && e.dest_en !== reference.dest_en) {
        return false;
      }
      const etaMs = new Date(e.eta).getTime();
      if (etaMs >= boardTime) return false;
      if (distToBoardM == null) return true;
      return isPlausibleLeg(distToBoardM, etaMs, boardTime);
    })
    .sort(
      (a, b) => new Date(a.eta).getTime() - new Date(b.eta).getTime()
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
 * Keep the longest physically plausible chain ending at the downstream anchor.
 * Input is in route order, with boarding last. Every retained leg must advance
 * in distance and time without exceeding MAX_BUS_SPEED_M_PER_MIN. Slow legs
 * remain valid. Ties prefer downstream evidence over terminus schedule noise.
 */
export function sanitizeEtaChain(chain) {
  const points = (chain ?? []).filter(
    (point) =>
      point &&
      Number.isFinite(point.cumDist) &&
      point.cumDist >= 0 &&
      Number.isFinite(point.etaMs)
  );
  if (!points.length) return [];

  const lengths = points.map(() => 1);
  const previous = points.map(() => -1);
  for (let j = 1; j < points.length; j++) {
    for (let i = j - 1; i >= 0; i--) {
      const distance = points[j].cumDist - points[i].cumDist;
      if (
        distance > 0 &&
        isPlausibleLeg(distance, points[i].etaMs, points[j].etaMs) &&
        lengths[i] + 1 > lengths[j]
      ) {
        lengths[j] = lengths[i] + 1;
        previous[j] = i;
      }
    }
  }

  const result = [];
  for (let i = points.length - 1; i !== -1; i = previous[i]) {
    result.push(points[i]);
  }
  return result.reverse();
}

/**
 * Learn ETA-to-route numbering only from independent, unambiguous stop IDs.
 * Citybus endpoints can use different sequence origins. Missing or conflicting
 * evidence must not turn an API sequence into a guessed loop occurrence.
 */
export function inferEtaSequenceOffset(observations) {
  const sequence = (value) => {
    if (typeof value !== "number" && typeof value !== "string") return null;
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
  };
  const anchors = new Map();
  let offset = null;
  for (const item of observations ?? []) {
    const canonical = sequence(item?.seq);
    if (!item?.stopId || canonical == null) continue;
    const prior = anchors.get(item.stopId);
    if (prior && prior.seq !== canonical) return null;
    for (const arrival of [item.eta?.first, item.eta?.second]) {
      const apiSeq = sequence(arrival?.seq);
      if (apiSeq == null) continue;
      const candidate = apiSeq - canonical;
      if (offset != null && candidate !== offset) return null;
      offset = candidate;
      anchors.set(item.stopId, { seq: canonical });
    }
  }
  return anchors.size >= 2 ? offset : null;
}

function buildEtaChain({ stops, upstreamEtas, first, boardingStop }) {
  const bySeq = new Map(
    (upstreamEtas ?? []).filter(Boolean).map((item) => [Number(item.seq), item])
  );
  const boardingCum = boardingStop.cumDist;
  const boardEtaMs = new Date(first.eta).getTime();
  const upstream = [];

  // Distances already belong to ordered OSRM legs. Repeated IDs or coordinates
  // must retain their own route occurrence instead of finding a nearest copy.
  for (const stop of stops.slice(0, -1)) {
    const item = bySeq.get(Number(stop.seq));
    if (!item || stop.cumDist < 0 || stop.cumDist >= boardingCum) continue;
    const matched = matchBusEta(item.eta, first, boardingCum - stop.cumDist);
    if (!matched?.eta) continue;
    const etaMs = new Date(matched.eta).getTime();
    if (!Number.isFinite(etaMs)) continue;
    upstream.push({ stopId: stop.stopId, seq: stop.seq, etaMs, cumDist: stop.cumDist });
  }

  return sanitizeEtaChain([
    ...upstream,
    {
      stopId: boardingStop.stopId,
      seq: boardingStop.seq,
      etaMs: boardEtaMs,
      cumDist: boardingCum,
    },
  ]);
}

/**
 * Place bus along polyline using a validated chain and current time.
 * Validation happens when observations change, outside the animation loop.
 * @param {number} [minCum=0] - explicit lower route bound
 */
export function positionFromEtaChain(
  chain,
  polyline,
  trackingNowMs,
  boardingCum,
  minCum = 0
) {
  if (!chain?.length || !polyline?.length) return null;
  const floor = Math.max(0, Math.min(minCum, boardingCum));

  if (chain.length === 1) {
    const only = chain[0];
    if (trackingNowMs >= only.etaMs) {
      return latLngFromCum(
        polyline,
        Math.min(Math.max(floor, only.cumDist), boardingCum)
      );
    }
    const minsUntil = (only.etaMs - trackingNowMs) / 60_000;
    return latLngFromCum(
      polyline,
      Math.min(
        only.cumDist,
        Math.max(
          floor,
          only.cumDist - DEFAULT_BUS_SPEED_M_PER_MIN * Math.max(0, minsUntil)
        )
      )
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
        b.cumDist,
        Math.max(floor, a.cumDist + progress * (b.cumDist - a.cumDist))
      );
      return latLngFromCum(polyline, busCumDist);
    }
  }

  const first = chain[0];
  if (trackingNowMs < first.etaMs) {
    const next = chain[1];
    // Extrapolate upstream using the first credible leg, including slow traffic.
    const rawSpeed = segmentSpeedMPerMin(first, next);
    const speed =
      rawSpeed != null &&
      isPlausibleLeg(next.cumDist - first.cumDist, first.etaMs, next.etaMs)
        ? rawSpeed
        : DEFAULT_BUS_SPEED_M_PER_MIN;
    const minsUntilFirst = (first.etaMs - trackingNowMs) / 60_000;
    const fromFirst = first.cumDist - speed * minsUntilFirst;
    const busCumDist = Math.min(
      boardingCum,
      first.cumDist,
      Math.max(floor, fromFirst)
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

/**
 * Active stop-to-stop leg for segment pulse visualization.
 * @returns {{ fromCum: number, toCum: number, progress: number, stopA: object|null, stopB: object|null, dotLatLng: { lat: number, lng: number }|null }|null}
 */
export function resolveActiveSegment(
  chain,
  polyline,
  trackingNowMs,
  boardingCum,
  minCum = 0
) {
  if (!chain?.length || !polyline?.length) return null;
  const floor = Math.max(0, minCum);

  const placed = positionFromEtaChain(
    chain,
    polyline,
    trackingNowMs,
    boardingCum,
    floor
  );
  if (!placed) return null;
  const busCum = placed.cumDist;

  function make(fromCum, toCum, progress, stopA = null, stopB = null) {
    const lo = Math.min(fromCum, toCum);
    const hi = Math.max(fromCum, toCum);
    if (hi - lo < 1) return null;
    const p = Math.max(0, Math.min(1, progress));
    const dotCum = lo + p * (hi - lo);
    const pt = pointAtCumDist(polyline, dotCum);
    return {
      fromCum: lo,
      toCum: hi,
      progress: p,
      stopA,
      stopB,
      dotLatLng: pt
        ? { lat: pt.lat, lng: pt.lng }
        : { lat: placed.lat, lng: placed.lng },
    };
  }

  if (chain.length === 1) {
    const only = chain[0];
    if (only.cumDist >= boardingCum - 1) {
      return make(floor, boardingCum, 1, only, null);
    }
    if (trackingNowMs < only.etaMs) {
      const span = only.cumDist - floor;
      const progress = span > 0 ? (busCum - floor) / span : 0;
      return make(floor, only.cumDist, progress, null, only);
    }
    const fromCum = Math.max(floor, only.cumDist);
    const span = boardingCum - fromCum;
    const progress = span > 0 ? (busCum - fromCum) / span : 1;
    return make(fromCum, boardingCum, progress, only, null);
  }

  for (let i = 0; i < chain.length - 1; i++) {
    const a = chain[i];
    const b = chain[i + 1];
    if (trackingNowMs >= a.etaMs && trackingNowMs < b.etaMs) {
      const spanMs = b.etaMs - a.etaMs;
      const progress = spanMs > 0 ? (trackingNowMs - a.etaMs) / spanMs : 0;
      return make(
        Math.max(floor, a.cumDist),
        Math.min(boardingCum, b.cumDist),
        progress,
        a,
        b
      );
    }
  }

  const first = chain[0];
  if (trackingNowMs < first.etaMs) {
    const toCum = Math.max(first.cumDist, floor + 1);
    const span = toCum - floor;
    const progress = span > 0 ? (busCum - floor) / span : 0;
    return make(floor, toCum, progress, null, first);
  }

  const last = chain[chain.length - 1];
  if (trackingNowMs >= last.etaMs) {
    const prev = chain.length >= 2 ? chain[chain.length - 2] : null;
    const fromCum = prev ? Math.max(floor, prev.cumDist) : floor;
    return make(fromCum, boardingCum, 1, prev, last);
  }

  for (let i = chain.length - 2; i >= 0; i--) {
    if (trackingNowMs >= chain[i].etaMs) {
      const next = chain[i + 1];
      return make(
        Math.max(floor, chain[i].cumDist),
        next.cumDist,
        0,
        chain[i],
        next
      );
    }
  }

  return make(floor, boardingCum, 0, null, null);
}

/**
 * Speed-fallback active segment when upstream ETA chain is unavailable.
 */
export function resolveSpeedFallbackSegment(
  polyline,
  boardingCum,
  floor,
  speedMPerMin,
  boardEtaMs,
  trackingNowMs
) {
  if (!polyline?.length || boardingCum == null || !speedMPerMin || !boardEtaMs) {
    return null;
  }
  const minsLeft = (boardEtaMs - trackingNowMs) / 60_000;
  if (minsLeft <= 0) return null;

  const fromCum = Math.max(0, floor);
  const toCum = boardingCum;
  const span = toCum - fromCum;
  if (span < 1) return null;

  const estimatedCum = Math.max(
    fromCum,
    Math.min(toCum, toCum - speedMPerMin * minsLeft)
  );
  const progress = (estimatedCum - fromCum) / span;
  const pt = pointAtCumDist(polyline, estimatedCum);

  return {
    fromCum,
    toCum,
    progress: Math.max(0, Math.min(1, progress)),
    stopA: null,
    stopB: null,
    dotLatLng: pt ? { lat: pt.lat, lng: pt.lng } : null,
  };
}

/**
 * Extract polyline lat/lngs between two cumulative distances (low → high).
 */
export function slicePolylineBetween(polyline, fromCum, toCum) {
  if (!polyline?.length || fromCum >= toCum) return [];

  const start = pointAtCumDist(polyline, fromCum);
  const end = pointAtCumDist(polyline, toCum);
  if (!start || !end) return [];

  const points = [[start.lat, start.lng]];
  for (const p of polyline) {
    if (p.cumDist > fromCum && p.cumDist < toCum) {
      points.push([p.lat, p.lng]);
    }
  }
  points.push([end.lat, end.lng]);
  return points;
}

/** One cumulative-distance model for the marker and its approach pulse. */
function busCumForEstimate(estimate, nowMs) {
  if (
    !estimate?.polyline?.length ||
    !Number.isFinite(estimate.boardEtaMs) ||
    !Number.isFinite(nowMs)
  ) return null;
  if (estimate.reason === "seq-1" || estimate.reason === "no-eta") return null;

  const boardingCum =
    estimate.boardingCumDist ??
    estimate.boardingStop?.cumDist ??
    estimate.polyline[estimate.polyline.length - 1]?.cumDist;
  if (!Number.isFinite(boardingCum) || boardingCum <= 0) return null;

  const floor = Math.max(0, Math.min(estimate.minCumDist ?? 0, boardingCum));

  // A validated ETA chain is authoritative. Do not let a second countdown
  // calculation move the marker beyond a stop whose arrival is still ahead.
  if (estimate.etaChain?.length >= 2) {
    return positionFromEtaChain(
      estimate.etaChain,
      estimate.polyline,
      nowMs,
      boardingCum,
      floor
    )?.cumDist ?? null;
  }

  const speed = Number.isFinite(estimate.speedMPerMin) && estimate.speedMPerMin > 0
    ? clampSpeed(estimate.speedMPerMin)
    : DEFAULT_BUS_SPEED_M_PER_MIN;
  const minsLeft = Math.max(0, (estimate.boardEtaMs - nowMs) / 60_000);
  return Math.max(floor, Math.min(boardingCum, boardingCum - speed * minsLeft));
}

/**
 * Predicted bus lat/lng along the full approach polyline.
 */
export function resolveBusPlacement(estimate, nowMs) {
  if (!estimate?.polyline?.length) return null;
  if (estimate.reason === "seq-1" || estimate.reason === "no-eta") return null;

  const cumDist = busCumForEstimate(estimate, nowMs);
  if (cumDist == null) return null;

  const pt = pointAtCumDist(estimate.polyline, cumDist);
  if (!pt) return null;

  return { lat: pt.lat, lng: pt.lng, cumDist: pt.cumDist };
}

/**
 * Current physical stop-to-stop leg containing the shared bus placement.
 */
function resolveLegBetweenStops(stops, busCum, floor, boardingCum) {
  if (!stops?.length) {
    return { fromCum: floor, toCum: boardingCum };
  }

  const boundaries = [floor];
  const sorted = [...stops]
    .filter((s) => Number.isFinite(s.cumDist))
    .sort((a, b) => a.cumDist - b.cumDist);

  for (const stop of sorted) {
    const cum = stop.cumDist;
    if (cum > floor + 0.5 && cum < boardingCum - 0.5) {
      if (boundaries[boundaries.length - 1] < cum - 0.5) {
        boundaries.push(cum);
      }
    }
  }

  if (boardingCum > boundaries[boundaries.length - 1] + 0.5) {
    boundaries.push(boardingCum);
  }

  if (boundaries.length < 2) {
    return { fromCum: floor, toCum: boardingCum };
  }

  for (let i = 0; i < boundaries.length - 1; i++) {
    const lo = boundaries[i];
    const hi = boundaries[i + 1];
    if (busCum >= lo && busCum < hi) {
      return { fromCum: lo, toCum: hi };
    }
  }

  return {
    fromCum: boundaries[boundaries.length - 2],
    toCum: boardingCum,
  };
}

/**
 * Nerve-pulse bounds from the same placement used to paint the bus marker.
 * All physical stops bound the current leg, even when their ETAs are missing.
 */
export function resolveApproachPulse(
  estimate,
  nowMs,
  placement = resolveBusPlacement(estimate, nowMs)
) {
  if (!placement || !estimate?.polyline?.length) return null;

  const boardingCum =
    estimate.boardingCumDist ??
    estimate.boardingStop?.cumDist ??
    estimate.polyline[estimate.polyline.length - 1]?.cumDist;
  if (!Number.isFinite(boardingCum)) return null;
  // Placement bounds do not change physical leg geometry. A conflicting bound
  // must not put the pulse ahead of its bus.
  const floor = Math.max(0, estimate.polyline[0].cumDist ?? 0);
  const busCum = placement.cumDist;
  if (!Number.isFinite(busCum)) return null;

  const { fromCum, toCum } = resolveLegBetweenStops(
    estimate.stops?.length ? estimate.stops : estimate.etaChain,
    busCum,
    floor,
    boardingCum
  );
  const span = toCum - fromCum;
  if (span < 1) return null;

  const stops = estimate.stops;
  const boardingStop =
    estimate.boardingStop ?? (stops?.length ? stops[stops.length - 1] : null);
  return {
    fromCum,
    toCum,
    progress: Math.max(0, Math.min(1, (busCum - fromCum) / span)),
    busCum,
    boardingStop,
  };
}

/** @deprecated Use resolveApproachPulse */
export function resolveFinalLegPulse(estimate, nowMs) {
  return resolveApproachPulse(estimate, nowMs);
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
  // Clamp to the route bounds, without inferring passage from missing ETAs.
  const busCumDist = Math.max(
    minCum,
    Math.min(boardingCum, boardingCum - remainingDist)
  );
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
  const { active, handedOff, nowMs } = resolveActiveBoardingEta(boardingEta);
  if (!active?.eta) {
    return emptyEstimate({ reason: "no-eta", busChanged: handedOff });
  }

  const first = active;
  const minutesToBoard = minutesUntil(first.eta, nowMs);
  if (minutesToBoard == null) {
    return emptyEstimate({ reason: "no-eta", busChanged: handedOff });
  }

  const routeStops = await fetchRouteStops(entry.route, entry.direction);
  const etaSeq = first.seq == null ? null : Number(first.seq);
  const hasEtaSeq = Number.isInteger(etaSeq) && etaSeq > 0;
  const boardingMatches = routeStops
    .map((stop, index) => ({ stop, index }))
    .filter(({ stop }) => stop.stopId === entry.stopId);

  if (!boardingMatches.length) {
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
        busChanged: handedOff,
      },
      boardingEta
    );
  }

  const allCoords = await resolveRouteStopCoords(routeStops);
  if (!allCoords.length) {
    return emptyEstimate({ reason: "no-coords", busChanged: handedOff });
  }

  const counts = new Map();
  for (const stop of routeStops) {
    counts.set(stop.stopId, (counts.get(stop.stopId) ?? 0) + 1);
  }
  const repeatedBoarding = boardingMatches.length > 1;
  const poolIndex = boardingMatches[boardingMatches.length - 1].index;
  const pool = denseUpstream || repeatedBoarding
    ? routeStops.slice(0, poolIndex)
    : sampleUpstreamStops(routeStops, poolIndex, UPSTREAM_ETA_SAMPLE_SIZE);
  const needsSequence = repeatedBoarding || pool.some((stop) => counts.get(stop.stopId) > 1);
  const uniqueRequests = new Map(
    pool.filter((stop) => counts.get(stop.stopId) === 1).map((stop) => [stop.stopId, stop])
  );
  // A unique boarding stop is itself an anchor. Add at most two unique route
  // stops when sampled evidence alone cannot establish the sequence offset.
  if (needsSequence) {
    const target = repeatedBoarding ? 2 : 1;
    for (const stop of routeStops) {
      if (uniqueRequests.size >= target) break;
      if (counts.get(stop.stopId) === 1 && stop.stopId !== entry.stopId) {
        uniqueRequests.set(stop.stopId, stop);
      }
    }
  }

  const loadUpstream = async (stop, stopSeq = null) => {
    try {
      const eta = await fetchEta(entry.route, stop.stopId, entry.direction, {
        useCache: !refreshUpstream,
        cacheTtlMs: UPSTREAM_ETA_CACHE_TTL_MS,
        stopSeq,
      });
      return { stopId: stop.stopId, seq: stop.seq, eta };
    } catch {
      return null;
    }
  };
  const [road, uniqueEtas] = await Promise.all([
    roadSnapRoute(allCoords),
    Promise.all([...uniqueRequests.values()].map((stop) => loadUpstream(stop))),
  ]);
  const anchors = uniqueEtas.filter(Boolean);
  if (!repeatedBoarding) {
    anchors.push({ stopId: entry.stopId, seq: boardingMatches[0].stop.seq, eta: boardingEta });
  }
  const sequenceOffset = needsSequence ? inferEtaSequenceOffset(anchors) : null;
  const selected = repeatedBoarding
    ? hasEtaSeq && sequenceOffset != null
      ? boardingMatches.find(({ stop }) => Number(stop.seq) === etaSeq - sequenceOffset)
      : null
    : boardingMatches[0];

  if (!selected) {
    // Keep physical stop/full-route context, but never choose a visit by ranking
    // incomplete ETA groups or assuming both endpoints number stops alike.
    const physical = allCoords.find((stop) => stop.stopId === entry.stopId);
    return attachTrackingMeta({
      ...emptyEstimate({ reason: "ambiguous-stop", busChanged: handedOff }),
      routePolyline: buildPolyline(road.points),
      boardingStop: physical ? {
        stopId: physical.stopId, lat: physical.lat, lng: physical.lng, nameEn: physical.nameEn,
      } : null,
    }, boardingEta);
  }

  const boardingIndex = selected.index;
  const boardingSeq = Number(selected.stop.seq);
  const boardingCoordIndex = allCoords.findIndex(
    (stop) => stop.stopId === entry.stopId && Number(stop.seq) === boardingSeq
  );
  if (boardingCoordIndex < 0) {
    return emptyEstimate({ reason: "no-coords", busChanged: handedOff });
  }
  const upstreamStops = denseUpstream
    ? routeStops.slice(0, boardingIndex)
    : sampleUpstreamStops(routeStops, boardingIndex, UPSTREAM_ETA_SAMPLE_SIZE);
  const uniqueById = new Map(anchors.map((item) => [item.stopId, item]));
  const upstreamEtas = await Promise.all(upstreamStops.map((stop) => {
    if (counts.get(stop.stopId) === 1) return uniqueById.get(stop.stopId) ?? null;
    const apiSeq = sequenceOffset == null ? null : Number(stop.seq) + sequenceOffset;
    if (!Number.isInteger(apiSeq) || apiSeq <= 0) return null;
    return loadUpstream(stop, apiSeq);
  }));

  // Build one full path. Both drawing and estimation use these same ordered
  // boundaries, including every waypoint on long routes and repeated roads.
  const routePolyline = buildPolyline(road.points);
  const boardingPointIndex = road.stopIndices[boardingCoordIndex];
  if (!routePolyline[boardingPointIndex]) {
    return emptyEstimate({ reason: "no-geometry", busChanged: handedOff });
  }
  const polyline = routePolyline.slice(0, boardingPointIndex + 1);
  const boardingCum = routePolyline[boardingPointIndex].cumDist;
  const boardingStop = {
    ...allCoords[boardingCoordIndex], cumDist: boardingCum, apiSeq: hasEtaSeq ? etaSeq : null,
  };
  const stops = allCoords.slice(0, boardingCoordIndex + 1).map((stop, i) => ({
    ...stop,
    cumDist: routePolyline[road.stopIndices[i]].cumDist,
    isBoarding: i === boardingCoordIndex,
  }));
  const stopsBySeq = new Map(stops.map((stop) => [Number(stop.seq), stop]));

  const base = {
    polyline,
    routePolyline,
    boardingStop,
    boardingCumDist: boardingCum,
    stops,
    minutesToBoard,
    boardEtaMs: new Date(first.eta).getTime(),
    busChanged: handedOff,
  };

  if (boardingIndex === 0 || boardingCum <= 0) {
    return attachTrackingMeta(
      {
        ...base,
        busLatLng: null,
        busCumDist: null,
        reason: boardingIndex === 0 ? "seq-1" : "no-geometry",
      },
      boardingEta
    );
  }

  const etaChain = buildEtaChain({
    stops,
    upstreamEtas,
    first,
    boardingStop,
  });

  // An absent match (including empty/failed responses) is unknown, not proof
  // that this bus passed a stop. Only retained ETA observations constrain its
  // progress; fallback placement keeps the route origin as its lower bound.
  const minCum = polyline[0]?.cumDist ?? 0;

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

    const stop = stopsBySeq.get(Number(item.seq));
    if (!stop) continue;

    const upCum = stop.cumDist;
    const dist = boardingCum - upCum;
    if (dist <= 0) continue;

    const matched = matchBusEta(item.eta, first, dist);
    if (!matched?.eta) continue;

    const upstreamTime = new Date(matched.eta).getTime();
    const timeDeltaMin = (boardTime - upstreamTime) / 60_000;
    if (timeDeltaMin <= 0.25) continue;

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
