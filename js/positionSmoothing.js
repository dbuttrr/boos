import {
  BUS_POSITION_BLEND_MS,
  BUS_POSITION_MAX_ETA_SHIFT_MS,
} from "./config.js";
import { pointAtCumDist, resolveBusPlacement } from "./estimate.js";

function sequence(value) {
  if (typeof value !== "number" && typeof value !== "string") return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function sameArray(a, b, equal) {
  return a.length === b.length && a.every((item, i) => equal(item, b[i]));
}

function samePath(a, b) {
  const boardingA = a.boardingStop;
  const boardingB = b.boardingStop;
  return (
    boardingA?.stopId === boardingB?.stopId &&
    sequence(boardingA?.seq) === sequence(boardingB?.seq) &&
    sequence(boardingA?.apiSeq) === sequence(boardingB?.apiSeq) &&
    a.boardingCumDist === b.boardingCumDist &&
    boardingA?.cumDist === boardingB?.cumDist &&
    sameArray(a.polyline ?? [], b.polyline ?? [], (p, q) =>
      p.lat === q.lat && p.lng === q.lng && p.cumDist === q.cumDist
    ) &&
    sameArray(a.stops ?? [], b.stops ?? [], (p, q) =>
      p.stopId === q.stopId && sequence(p.seq) === sequence(q.seq) && p.cumDist === q.cumDist
    )
  );
}

function sameModel(a, b) {
  return (
    a.boardEtaMs === b.boardEtaMs &&
    a.minCumDist === b.minCumDist &&
    a.speedMPerMin === b.speedMPerMin &&
    a.reason === b.reason &&
    sameArray(a.etaChain ?? [], b.etaChain ?? [], (p, q) =>
      p.etaMs === q.etaMs && p.cumDist === q.cumDist
    )
  );
}

function validClocks(wallNowMs, motionNowMs) {
  return Number.isFinite(wallNowMs) && Number.isFinite(motionNowMs);
}

function rawPosition(estimate, wallNowMs) {
  if (!Number.isFinite(estimate?.boardEtaMs) || estimate.boardEtaMs <= wallNowMs) return null;
  const position = resolveBusPlacement(estimate, wallNowMs);
  return Number.isFinite(position?.cumDist) ? position : null;
}

/**
 * Presentation continuity for accepted ETA models, never evidence of passage.
 * Call setEstimate only on revisions, with immutable estimate objects. Ordinary
 * frames sample the moving raw model plus a correction that expires exactly.
 */
export function createPositionSmoother({
  blendMs = BUS_POSITION_BLEND_MS,
  maxEtaShiftMs = BUS_POSITION_MAX_ETA_SHIFT_MS,
} = {}) {
  const states = new Map();

  function getPosition(id, wallNowMs, motionNowMs) {
    const state = states.get(id);
    if (!state) return null;
    if (!validClocks(wallNowMs, motionNowMs)) {
      states.delete(id);
      return null;
    }
    const raw = rawPosition(state.estimate, wallNowMs);
    if (!raw) {
      states.delete(id);
      return null;
    }
    // rAF/performance time is monotonic; never replay a correction on a reset.
    if (motionNowMs < state.lastMotionMs) state.offset = 0;
    state.lastMotionMs = motionNowMs;
    if (!state.offset || !(blendMs > 0)) return raw;

    const progress = Math.max(0, Math.min(1, (motionNowMs - state.startedAtMs) / blendMs));
    if (progress === 1) {
      state.offset = 0;
      return raw;
    }
    const remaining = 1 - progress * progress * (3 - 2 * progress);
    const estimate = state.estimate;
    const boardingCum = estimate.boardingCumDist ?? estimate.boardingStop?.cumDist ?? estimate.polyline.at(-1).cumDist;
    const floor = Math.max(0, Math.min(estimate.minCumDist ?? 0, boardingCum));
    const cumDist = Math.max(floor, Math.min(boardingCum, raw.cumDist + state.offset * remaining));
    return pointAtCumDist(estimate.polyline, cumDist);
  }

  function setEstimate(id, estimate, wallNowMs, motionNowMs, { reset = false } = {}) {
    if (!validClocks(wallNowMs, motionNowMs)) {
      states.delete(id);
      return null;
    }
    const raw = rawPosition(estimate, wallNowMs);
    if (!raw) {
      states.delete(id);
      return null;
    }
    const previous = states.get(id);
    const displayed = previous ? getPosition(id, wallNowMs, motionNowMs) : null;
    const compatible = !reset && displayed && samePath(previous.estimate, estimate) &&
      !(estimate.busChanged && estimate.boardEtaMs !== previous.estimate.boardEtaMs) &&
      Math.abs(estimate.boardEtaMs - previous.estimate.boardEtaMs) < maxEtaShiftMs;

    // New freshness metadata alone must not extend an existing correction.
    if (compatible && sameModel(previous.estimate, estimate)) {
      previous.estimate = estimate;
      return getPosition(id, wallNowMs, motionNowMs);
    }

    states.set(id, {
      estimate,
      offset: compatible && blendMs > 0 ? displayed.cumDist - raw.cumDist : 0,
      startedAtMs: motionNowMs,
      lastMotionMs: motionNowMs,
    });
    return getPosition(id, wallNowMs, motionNowMs);
  }

  return {
    setEstimate,
    getPosition,
    clear: (id) => states.delete(id),
    clearAll: () => states.clear(),
  };
}
