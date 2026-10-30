import test from "node:test";
import assert from "node:assert/strict";
import {
  positionFromEtaChain,
  resolveApproachPulse,
  resolveBusPlacement,
  sanitizeEtaChain,
} from "../js/estimate.js";
import { MAX_BUS_SPEED_M_PER_MIN } from "../js/config.js";

const NOW = Date.UTC(2026, 9, 30, 4);
const MINUTE = 60_000;

function point(stopId, cumDist, minutes) {
  return { stopId, cumDist, etaMs: NOW + minutes * MINUTE };
}

function polyline(length) {
  return [
    { lat: 22.3, lng: 114.1, cumDist: 0 },
    { lat: 22.3, lng: 114.12, cumDist: length },
  ];
}

function estimate(chain, distances, overrides = {}) {
  const boardingCum = distances.at(-1);
  return {
    reason: "segment",
    polyline: polyline(boardingCum),
    boardingCumDist: boardingCum,
    boardEtaMs: chain.at(-1).etaMs,
    etaChain: chain,
    minCumDist: 0,
    speedMPerMin: 80,
    stops: distances.map((cumDist, i) => ({ stopId: `stop-${i}`, cumDist })),
    ...overrides,
  };
}

function assertValidChain(chain) {
  for (const p of chain) {
    assert.ok(Number.isFinite(p.cumDist));
    assert.ok(Number.isFinite(p.etaMs));
    assert.ok(p.cumDist >= 0);
  }
  for (let i = 1; i < chain.length; i++) {
    const distance = chain[i].cumDist - chain[i - 1].cumDist;
    const minutes = (chain[i].etaMs - chain[i - 1].etaMs) / MINUTE;
    assert.ok(distance > 0, "stop distances must strictly increase");
    assert.ok(minutes > 0, "stop arrival times must strictly increase");
    assert.ok(distance / minutes <= MAX_BUS_SPEED_M_PER_MIN,
      "every adjacent leg must obey the maximum speed");
  }
}

test("valid ETA chain is retained without mutating its input", () => {
  const chain = [point("A", 0, 0), point("B", 400, 5), point("board", 2000, 10)];
  const original = structuredClone(chain);
  const result = sanitizeEtaChain(chain);
  assert.deepEqual(result, chain);
  assert.deepEqual(chain, original);
  assertValidChain(result);
});

test("credible slow traffic is retained without imposing the fallback minimum speed", () => {
  const chain = [point("A", 0, 0), point("B", 100, 10), point("board", 200, 20)];
  assert.deepEqual(sanitizeEtaChain(chain), chain);
  const model = estimate(chain, [0, 100, 200]);
  assert.equal(resolveBusPlacement(model, NOW + 5 * MINUTE).cumDist, 50);
});

test("extrapolation before the first ETA also honors a credible slow leg", () => {
  const chain = [point("A", 100, 5), point("B", 200, 15), point("board", 300, 25)];
  const model = estimate(sanitizeEtaChain(chain), [0, 100, 200, 300]);
  assert.equal(resolveBusPlacement(model, NOW).cumDist, 50);
  assert.equal(resolveBusPlacement(model, NOW + 5 * MINUTE).cumDist, 100);
});

test("a fast adjacent leg is rejected even when both points fit boarding ETA", () => {
  const chain = [point("A", 1000, 2), point("B", 2000, 2.1), point("board", 3000, 10)];
  const result = sanitizeEtaChain(chain);
  assertValidChain(result);
  assert.equal(result.at(-1), chain.at(-1), "boarding remains the downstream anchor");
  assert.ok(result.length < chain.length);
});

test("equal arrival times at different distances cannot create an instantaneous leg", () => {
  const chain = [point("A", 0, 0), point("B", 1000, 0), point("board", 2000, 10)];
  const result = sanitizeEtaChain(chain);
  assertValidChain(result);
  assert.equal(result.at(-1), chain.at(-1));
});

test("an upstream point sharing the boarding timestamp cannot displace boarding", () => {
  const chain = [point("A", 0, 5), point("board", 1000, 5)];
  assert.deepEqual(sanitizeEtaChain(chain), [chain[1]]);
});

test("duplicate distances do not create zero-length interpolation legs", () => {
  const chain = [point("A", 0, 0), point("A-again", 0, 1), point("board", 1000, 5)];
  const result = sanitizeEtaChain(chain);
  assertValidChain(result);
  assert.equal(result.at(-1), chain.at(-1));
});

test("invalid coordinates and timestamps are excluded without changing valid observations", () => {
  const board = point("board", 1000, 10);
  const chain = [
    point("negative-distance", -100, 0),
    point("A", 0, 1),
    point("infinite-distance", Infinity, 2),
    { ...point("invalid-time", 300, 3), etaMs: NaN },
    { ...point("infinite-time", 400, 4), etaMs: Infinity },
    board,
  ];
  const result = sanitizeEtaChain(chain);
  assertValidChain(result);
  assert.deepEqual(result.map(p => p.stopId), ["A", "board"]);
});

test("validation keeps the longest credible chain instead of a single late outlier", () => {
  const chain = [
    point("A", 0, 0),
    point("B", 100, 1),
    point("C", 200, 2),
    point("outlier", 300, 0.5),
    point("board", 400, 4),
  ];
  const result = sanitizeEtaChain(chain);
  assert.deepEqual(result.map(p => p.stopId), ["A", "B", "C", "board"]);
  assertValidChain(result);
});

test("equally supported chains prefer downstream evidence over conflicting origin evidence", () => {
  const chain = [point("origin", 0, 3), point("mid-route", 100, 2), point("board", 500, 5)];
  const result = sanitizeEtaChain(chain);
  assert.deepEqual(result.map(p => p.stopId), ["mid-route", "board"]);
  assertValidChain(result);
});

test("empty and missing chains are safe", () => {
  assert.deepEqual(sanitizeEtaChain([]), []);
  assert.deepEqual(sanitizeEtaChain(null), []);
  assert.equal(positionFromEtaChain([], polyline(1000), NOW, 1000), null);
});

test("a chain containing only invalid observations becomes empty", () => {
  assert.deepEqual(sanitizeEtaChain([
    point("negative-distance", -1, 0),
    { ...point("invalid-time", 100, 1), etaMs: NaN },
    point("invalid-distance", Infinity, 2),
  ]), []);
});

test("the speed limit is inclusive and rejects a leg immediately over the limit", () => {
  const board = point("board", MAX_BUS_SPEED_M_PER_MIN, 1);
  const atLimit = [point("A", 0, 0), board];
  assert.deepEqual(sanitizeEtaChain(atLimit), atLimit);
  const overLimit = [point("A", 0, 0.001), board];
  assert.deepEqual(sanitizeEtaChain(overLimit), [board]);
});

test("sanitization finds maximal supported chains across varied contradictory samples", () => {
  // An exhaustive subset oracle checks the intended mathematical constraint
  // independently of the production selection algorithm.
  let randomState = 17;
  function random() {
    randomState = (randomState * 48271) % 2147483647;
    return randomState / 2147483647;
  }
  function compatible(candidate) {
    return candidate.every((p, i) => i === 0 || (
      p.cumDist > candidate[i - 1].cumDist &&
      p.etaMs > candidate[i - 1].etaMs &&
      (p.cumDist - candidate[i - 1].cumDist) /
        ((p.etaMs - candidate[i - 1].etaMs) / MINUTE) <= MAX_BUS_SPEED_M_PER_MIN
    ));
  }
  for (let sample = 0; sample < 40; sample++) {
    const chain = Array.from({ length: 6 }, (_, i) =>
      point(`sample-${i}`, i * 300, Math.round(random() * 60) / 10));
    chain.push(point("board", 1800, 8));
    let maximalLength = 1;
    for (let mask = 0; mask < 1 << 6; mask++) {
      const candidate = chain.filter((p, i) => i === 6 || (mask & (1 << i)));
      if (compatible(candidate)) maximalLength = Math.max(maximalLength, candidate.length);
    }
    const result = sanitizeEtaChain(chain);
    assertValidChain(result);
    assert.deepEqual(sanitizeEtaChain(result), result, "validation is idempotent");
    assert.equal(result.at(-1), chain.at(-1));
    assert.equal(result.length, maximalLength, `sample ${sample} retains maximal support`);
    const retainedIndices = result.map(p => chain.indexOf(p));
    assert.ok(retainedIndices.every((index, i) => index >= 0 &&
      (i === 0 || index > retainedIndices[i - 1])));
  }
});

test("boarding countdown cannot push the marker beyond its credible ETA segment", () => {
  const chain = [point("A", 0, 0), point("B", 400, 5), point("board", 2000, 10)];
  const model = estimate(chain, [0, 400, 2000]);
  resolveBusPlacement(model, NOW);
  const time = NOW + 3 * MINUTE;
  const placement = resolveBusPlacement(model, time);
  const pulse = resolveApproachPulse(model, time);
  assert.equal(placement.cumDist, 240);
  assert.equal(pulse.busCum, placement.cumDist);
  assert.equal(pulse.fromCum, 0);
  assert.equal(pulse.toCum, 400);
  assert.equal(pulse.progress, 0.6);
});

test("before the first future observation, placement stays upstream and is continuous", () => {
  const chain = [point("A", 1000, 2), point("B", 1200, 4), point("board", 3000, 10)];
  const route = polyline(3000);
  const initial = positionFromEtaChain(chain, route, NOW, 3000);
  const before = positionFromEtaChain(chain, route, NOW + 2 * MINUTE - 1, 3000);
  const at = positionFromEtaChain(chain, route, NOW + 2 * MINUTE, 3000);
  assert.ok(initial.cumDist >= 0 && initial.cumDist < 1000);
  assert.ok(before.cumDist <= 1000);
  assert.equal(at.cumDist, 1000);
  assert.ok(at.cumDist >= before.cumDist);
  assert.ok(at.cumDist - before.cumDist < 1, "no jump at the first ETA");
});

test("a contradictory lower bound cannot separate marker and physical pulse leg", () => {
  const chain = [point("A", 1000, 2), point("B", 1200, 4), point("board", 3000, 10)];
  const model = estimate(chain, [0, 1000, 1200, 2000, 3000], { minCumDist: 2000 });
  const placement = resolveBusPlacement(model, NOW);
  const pulse = resolveApproachPulse(model, NOW);
  assert.equal(placement.cumDist, 1000, "credible future stop caps the lower bound");
  assert.equal(pulse.busCum, placement.cumDist);
  assert.equal(pulse.fromCum, 1000);
  assert.equal(pulse.toCum, 1200);
  assert.equal(pulse.progress, 0);
});

test("pulse uses the physical current leg when the ETA chain skips stops", () => {
  const chain = [point("A", 0, 0), point("board", 1000, 10)];
  const model = estimate(chain, [0, 250, 500, 750, 1000]);
  const time = NOW + 4 * MINUTE;
  const placement = resolveBusPlacement(model, time);
  const pulse = resolveApproachPulse(model, time);
  assert.equal(placement.cumDist, 400);
  assert.equal(pulse.busCum, placement.cumDist);
  assert.equal(pulse.fromCum, 250);
  assert.equal(pulse.toCum, 500);
  assert.equal(pulse.progress, 0.6);
});

test("at an intermediate stop the shared model hands the pulse to the next leg", () => {
  const chain = [point("A", 0, 0), point("board", 1000, 10)];
  const model = estimate(chain, [0, 250, 500, 750, 1000]);
  const time = NOW + 5 * MINUTE;
  const placement = resolveBusPlacement(model, time);
  const pulse = resolveApproachPulse(model, time);
  assert.equal(placement.cumDist, 500);
  assert.equal(pulse.busCum, placement.cumDist);
  assert.equal(pulse.fromCum, 500);
  assert.equal(pulse.toCum, 750);
  assert.equal(pulse.progress, 0);
});

test("speed fallback remains finite and shares position with the pulse", () => {
  const chain = [point("board", 2000, 5)];
  const model = estimate(chain, [0, 500, 1000, 1500, 2000], {
    etaChain: null,
    reason: "default-speed",
    speedMPerMin: 250,
  });
  for (const minutes of [0, 1, 3, 4.5]) {
    const time = NOW + minutes * MINUTE;
    const placement = resolveBusPlacement(model, time);
    const pulse = resolveApproachPulse(model, time);
    assert.ok(Number.isFinite(placement.cumDist));
    assert.ok(placement.cumDist >= 0 && placement.cumDist <= 2000);
    assert.equal(pulse.busCum, placement.cumDist);
    assert.ok(pulse.fromCum <= placement.cumDist);
    assert.ok(pulse.toCum >= placement.cumDist);
  }
});

test("valid interpolation is monotonic and within stop bounds over a complete approach", () => {
  const chain = [point("A", 0, 0), point("B", 400, 5), point("board", 2000, 10)];
  const model = estimate(chain, [0, 200, 400, 1000, 1500, 2000]);
  let previous = -Infinity;
  for (let seconds = 0; seconds < 600; seconds += 5) {
    const time = NOW + seconds * 1000;
    const placement = resolveBusPlacement(model, time);
    const pulse = resolveApproachPulse(model, time);
    assert.ok(placement.cumDist >= previous);
    if (Number.isFinite(previous)) {
      assert.ok((placement.cumDist - previous) / (5 / 60) <= MAX_BUS_SPEED_M_PER_MIN,
        "movement stays within the speed cap through leg transitions");
    }
    assert.ok(placement.cumDist >= 0 && placement.cumDist <= 2000);
    assert.equal(pulse.busCum, placement.cumDist);
    assert.ok(pulse.fromCum <= placement.cumDist && placement.cumDist <= pulse.toCum);
    previous = placement.cumDist;
  }
});

test("chain interpolation continues through the last minute without snapping to boarding", () => {
  const model = estimate([point("A", 0, -1), point("board", 1000, 1)], [0, 500, 750, 1000]);
  const at60Seconds = resolveBusPlacement(model, NOW);
  const at30Seconds = resolveBusPlacement(model, NOW + 30_000);
  const beforeArrival = resolveBusPlacement(model, NOW + MINUTE - 1);
  const atArrival = resolveBusPlacement(model, NOW + MINUTE);
  assert.equal(at60Seconds.cumDist, 500);
  assert.equal(at30Seconds.cumDist, 750);
  assert.ok(beforeArrival.cumDist < 1000);
  assert.ok(1000 - beforeArrival.cumDist < 1);
  assert.equal(atArrival.cumDist, 1000);
  for (const time of [NOW, NOW + 30_000, NOW + MINUTE - 1]) {
    const placement = resolveBusPlacement(model, time);
    const pulse = resolveApproachPulse(model, time, placement);
    assert.equal(pulse.busCum, placement.cumDist);
    assert.ok(pulse.fromCum <= placement.cumDist && placement.cumDist <= pulse.toCum);
  }
});

test("speed fallback continues through the last minute without snapping to boarding", () => {
  const model = estimate([point("board", 1000, 1)], [0, 500, 750, 1000], {
    reason: "default-speed",
    etaChain: null,
    speedMPerMin: 250,
  });
  assert.equal(resolveBusPlacement(model, NOW).cumDist, 750);
  assert.equal(resolveBusPlacement(model, NOW + 30_000).cumDist, 875);
  assert.ok(resolveBusPlacement(model, NOW + MINUTE - 1).cumDist < 1000);
  assert.equal(resolveBusPlacement(model, NOW + MINUTE).cumDist, 1000);
});
