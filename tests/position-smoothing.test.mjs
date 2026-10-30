import assert from "node:assert/strict";
import test from "node:test";
import { createPositionSmoother } from "../js/positionSmoothing.js";
import {
  pointAtCumDist,
  resolveApproachPulse,
  resolveBusPlacement,
} from "../js/estimate.js";

const NOW = Date.UTC(2026, 9, 30, 5);
const MINUTE = 60_000;
const BLEND_MS = 5_000;

function model(overrides = {}) {
  return {
    reason: "default-speed",
    polyline: [
      { lat: 22.3, lng: 114.1, cumDist: 0 },
      { lat: 22.31, lng: 114.1, cumDist: 1_000 },
      { lat: 22.31, lng: 114.11, cumDist: 2_000 },
    ],
    stops: [
      { stopId: "origin", seq: 1, cumDist: 0 },
      { stopId: "middle", seq: 2, cumDist: 1_000 },
      { stopId: "boarding", seq: 3, cumDist: 2_000 },
    ],
    boardingStop: { stopId: "boarding", seq: 3, apiSeq: 18, cumDist: 2_000 },
    boardingCumDist: 2_000,
    minCumDist: 0,
    speedMPerMin: 250,
    boardEtaMs: NOW + 4 * MINUTE,
    etaChain: [],
    busChanged: false,
    snapshotMs: NOW - MINUTE,
    receivedAtMs: NOW,
    ...overrides,
  };
}

function approximately(actual, expected, message = "") {
  assert.ok(Math.abs(actual - expected) < 1e-7,
    `${message} expected ${expected}, received ${actual}`);
}

function assertOnPath(position, estimate) {
  assert.ok(position);
  assert.ok(Number.isFinite(position.lat) && Number.isFinite(position.lng));
  assert.ok(position.cumDist >= estimate.polyline[0].cumDist);
  assert.ok(position.cumDist <= estimate.boardingCumDist);
  assert.deepEqual(position, pointAtCumDist(estimate.polyline, position.cumDist));
}

function beginRevision(oldModel = model(), nextModel = model({ boardEtaMs: NOW + 5 * MINUTE })) {
  const smoother = createPositionSmoother();
  const before = smoother.setEstimate("route", oldModel, NOW, 0);
  const atRevision = smoother.setEstimate("route", nextModel, NOW, 0);
  return { smoother, before, atRevision, oldModel, nextModel };
}

test("first placement is immediately available without introducing initial tracking lag", () => {
  const smoother = createPositionSmoother();
  const estimate = model();
  const raw = resolveBusPlacement(estimate, NOW);
  assert.deepEqual(smoother.setEstimate("route", estimate, NOW, 0), raw);
  assert.deepEqual(smoother.getPosition("route", NOW + 1_000, 1_000),
    resolveBusPlacement(estimate, NOW + 1_000));
});

for (const etaMinutes of [3, 5]) {
  test(`a ${etaMinutes < 4 ? "forward" : "backward"} correction begins at the displayed position and settles exactly`, () => {
    const next = model({ boardEtaMs: NOW + etaMinutes * MINUTE });
    const { smoother, before, atRevision } = beginRevision(model(), next);
    assert.deepEqual(atRevision, before, "accepting a revision must not move the marker");
    const halfway = smoother.getPosition("route", NOW + BLEND_MS / 2, BLEND_MS / 2);
    const rawHalfway = resolveBusPlacement(next, NOW + BLEND_MS / 2);
    const oldAtRevision = resolveBusPlacement(model(), NOW);
    const newAtRevision = resolveBusPlacement(next, NOW);
    approximately(halfway.cumDist,
      rawHalfway.cumDist + (oldAtRevision.cumDist - newAtRevision.cumDist) / 2);
    assertOnPath(halfway, next);
    assert.deepEqual(smoother.getPosition("route", NOW + BLEND_MS, BLEND_MS),
      resolveBusPlacement(next, NOW + BLEND_MS));
    assert.deepEqual(smoother.getPosition("route", NOW + 2 * BLEND_MS, 2 * BLEND_MS),
      resolveBusPlacement(next, NOW + 2 * BLEND_MS), "there is no permanent low-pass lag");
  });
}

test("a revision during an active correction rebases from its current displayed position", () => {
  const { smoother } = beginRevision();
  const time = NOW + 1_500;
  const beforeRetarget = smoother.getPosition("route", time, 1_500);
  const thirdModel = model({ boardEtaMs: NOW + 3.5 * MINUTE });
  const afterRetarget = smoother.setEstimate("route", thirdModel, time, 1_500);
  assert.deepEqual(afterRetarget, beforeRetarget);
  assert.deepEqual(smoother.getPosition("route", time + BLEND_MS, 1_500 + BLEND_MS),
    resolveBusPlacement(thirdModel, time + BLEND_MS));
});

test("identical estimates and freshness-only metadata updates do not restart a correction", () => {
  const { smoother, nextModel } = beginRevision();
  const wallNow = NOW + 2_000;
  const before = smoother.getPosition("route", wallNow, 2_000);
  const cachedAgain = structuredClone(nextModel);
  cachedAgain.snapshotMs += MINUTE;
  cachedAgain.receivedAtMs += 2_000;
  cachedAgain.minutesToBoard = 4.9;
  assert.deepEqual(smoother.setEstimate("route", cachedAgain, wallNow, 2_000), before);
  assert.deepEqual(smoother.getPosition("route", NOW + BLEND_MS, BLEND_MS),
    resolveBusPlacement(nextModel, NOW + BLEND_MS), "the original correction deadline is preserved");
});

test("speed-only revisions are smoothed even when the boarding ETA did not change", () => {
  const next = model({ speedMPerMin: 300 });
  const { smoother, before, atRevision } = beginRevision(model(), next);
  assert.deepEqual(atRevision, before);
  assert.notEqual(atRevision.cumDist, resolveBusPlacement(next, NOW).cumDist);
  assert.deepEqual(smoother.getPosition("route", NOW + BLEND_MS, BLEND_MS),
    resolveBusPlacement(next, NOW + BLEND_MS));
});

test("changed upstream ETA evidence is blended while the new chain continues advancing", () => {
  const oldModel = model({
    reason: "segment",
    etaChain: [
      { stopId: "origin", seq: 1, cumDist: 0, etaMs: NOW - MINUTE },
      { stopId: "boarding", seq: 3, cumDist: 2_000, etaMs: NOW + 4 * MINUTE },
    ],
  });
  const next = structuredClone(oldModel);
  next.etaChain[0].etaMs = NOW - 2 * MINUTE;
  const { smoother, before, atRevision } = beginRevision(oldModel, next);
  assert.deepEqual(atRevision, before);
  assert.notEqual(atRevision.cumDist, resolveBusPlacement(next, NOW).cumDist);
  const final = smoother.getPosition("route", NOW + BLEND_MS, BLEND_MS);
  assert.deepEqual(final, resolveBusPlacement(next, NOW + BLEND_MS));
});

test("blending stays on the ordered return section of a route that revisits its origin", () => {
  const loop = model({
    boardEtaMs: NOW + 132_000,
    polyline: [
      { lat: 22.3, lng: 114.1, cumDist: 0 },
      { lat: 22.3, lng: 114.11, cumDist: 1_000 },
      { lat: 22.3, lng: 114.1, cumDist: 2_000 },
    ],
  });
  const next = { ...loop, boardEtaMs: NOW + 180_000 };
  const { smoother } = beginRevision(loop, next);
  for (let elapsed = 0; elapsed <= BLEND_MS; elapsed += 250) {
    const placement = smoother.getPosition("route", NOW + elapsed, elapsed);
    assertOnPath(placement, next);
    assert.ok(placement.cumDist > 1_000, "the return visit cannot be remapped to the outbound copy");
  }
});

test("the pulse uses the smoothed position and changes physical legs with the marker", () => {
  const oldModel = model({ boardEtaMs: NOW + 3 * MINUTE });
  const next = model({ boardEtaMs: NOW + 5 * MINUTE });
  const { smoother } = beginRevision(oldModel, next);
  const visitedLegs = new Set();
  for (let elapsed = 0; elapsed <= BLEND_MS; elapsed += 100) {
    const placement = smoother.getPosition("route", NOW + elapsed, elapsed);
    const pulse = resolveApproachPulse(next, NOW + elapsed, placement);
    assert.ok(pulse);
    approximately(pulse.busCum, placement.cumDist);
    assert.ok(placement.cumDist >= pulse.fromCum && placement.cumDist <= pulse.toCum);
    visitedLegs.add(`${pulse.fromCum}:${pulse.toCum}`);
  }
  assert.equal(visitedLegs.size, 2, "the physical-leg boundary follows the displayed bus during correction");
});

test("independent focused routes cannot inherit each other's correction", () => {
  const { smoother, nextModel } = beginRevision();
  const independent = model({ boardEtaMs: NOW + 2 * MINUTE });
  const otherInitial = smoother.setEstimate("other", independent, NOW, 0);
  assert.deepEqual(otherInitial, resolveBusPlacement(independent, NOW));
  smoother.clear("route");
  assert.equal(smoother.getPosition("route", NOW + 1_000, 1_000), null);
  assert.deepEqual(smoother.getPosition("other", NOW + 1_000, 1_000),
    resolveBusPlacement(independent, NOW + 1_000));
  assert.deepEqual(smoother.setEstimate("route", nextModel, NOW + 1_000, 1_000),
    resolveBusPlacement(nextModel, NOW + 1_000), "reselection starts from fresh evidence");
  smoother.clearAll();
  assert.equal(smoother.getPosition("route", NOW + 2_000, 2_000), null);
  assert.equal(smoother.getPosition("other", NOW + 2_000, 2_000), null);
});

test("unknown placement immediately removes prior correction and cannot leave a ghost bus", () => {
  const { smoother } = beginRevision();
  assert.equal(smoother.setEstimate("route", model({ reason: "no-eta" }), NOW + 1_000, 1_000), null);
  assert.equal(smoother.getPosition("route", NOW + 2_000, 2_000), null);
  const recovered = model();
  assert.deepEqual(smoother.setEstimate("route", recovered, NOW + 2_000, 2_000),
    resolveBusPlacement(recovered, NOW + 2_000));
});

test("ETA expiry is authoritative even in the middle of a visual correction", () => {
  const oldModel = model({ boardEtaMs: NOW + 3_000 });
  const next = model({ boardEtaMs: NOW + 2_000 });
  const { smoother } = beginRevision(oldModel, next);
  assert.ok(smoother.getPosition("route", NOW + 1_999, 1_999));
  assert.equal(smoother.getPosition("route", NOW + 2_000, 2_000), null);
  assert.equal(smoother.getPosition("route", NOW + 4_000, 4_000), null);
});

test("an expired previous bus cannot be blended into the next upcoming bus", () => {
  const { smoother } = beginRevision();
  const next = model({ boardEtaMs: NOW + 9 * MINUTE });
  const wallNow = NOW + 5 * MINUTE;
  assert.deepEqual(smoother.setEstimate("route", next, wallNow, 6_000),
    resolveBusPlacement(next, wallNow));
});

for (const [label, revise] of [
  ["explicit reset", (next) => ({ next, options: { reset: true } })],
  ["detected handoff", (next) => ({ next: { ...next, busChanged: true } })],
  ["canonical boarding occurrence", (next) => ({ next: { ...next, boardingStop: { ...next.boardingStop, seq: 6 } } })],
  ["API boarding sequence", (next) => ({ next: { ...next, boardingStop: { ...next.boardingStop, apiSeq: 21 } } })],
  ["physical stop order", (next) => ({ next: { ...next, stops: [next.stops[1], next.stops[0], next.stops[2]] } })],
  ["physical stop boundary", (next) => ({ next: { ...next, stops: next.stops.map((stop, i) => i === 1 ? { ...stop, cumDist: 900 } : stop) } })],
  ["ordered route geometry", (next) => ({ next: { ...next, polyline: next.polyline.map((point, i) => i === 1 ? { ...point, lng: 114.105 } : point) } })],
]) {
  test(`${label} resets visual continuity rather than traversing incompatible estimates`, () => {
    const { smoother } = beginRevision();
    const { next, options } = revise(model({ boardEtaMs: NOW + 3 * MINUTE }));
    const wallNow = NOW + 1_000;
    assert.deepEqual(smoother.setEstimate("route", next, wallNow, 1_000, options),
      resolveBusPlacement(next, wallNow));
  });
}

test("a large ETA discontinuity resets instead of animating a likely bus replacement", () => {
  const smoother = createPositionSmoother();
  const oldModel = model({ boardEtaMs: NOW + MINUTE });
  const next = model({ boardEtaMs: oldModel.boardEtaMs + 5 * MINUTE });
  smoother.setEstimate("route", oldModel, NOW, 0);
  assert.deepEqual(smoother.setEstimate("route", next, NOW, 0),
    resolveBusPlacement(next, NOW), "the reset threshold is inclusive");
});

test("route bounds contain every frame, including large backward corrections", () => {
  const { smoother, nextModel } = beginRevision(model({ boardEtaMs: NOW + 30_000 }),
    model({ boardEtaMs: NOW + 4 * MINUTE }));
  for (let elapsed = 0; elapsed <= BLEND_MS; elapsed += 25) {
    assertOnPath(smoother.getPosition("route", NOW + elapsed, elapsed), nextModel);
  }
});

test("correction progress uses animation time while absolute ETAs still use wall time", () => {
  const { smoother, oldModel, nextModel } = beginRevision();
  const wallNow = NOW + 10_000;
  const position = smoother.getPosition("route", wallNow, 2_500);
  const residual = resolveBusPlacement(oldModel, NOW).cumDist -
    resolveBusPlacement(nextModel, NOW).cumDist;
  approximately(position.cumDist,
    resolveBusPlacement(nextModel, wallNow).cumDist + residual / 2);
  assert.deepEqual(smoother.getPosition("route", wallNow, BLEND_MS),
    resolveBusPlacement(nextModel, wallNow));
});

for (const [label, wallNow, motionNow] of [
  ["nonfinite wall time", NaN, 1_000],
  ["nonfinite animation time", NOW + 1_000, Infinity],
]) {
  test(`${label} clears continuity safely`, () => {
    const { smoother } = beginRevision();
    assert.equal(smoother.getPosition("route", wallNow, motionNow), null);
    assert.equal(smoother.getPosition("route", NOW + 2_000, 2_000), null);
    assert.equal(smoother.setEstimate("route", model(), wallNow, motionNow), null);
  });
}

test("presentation smoothing never mutates the validated ETA model or passage constraints", () => {
  const first = model();
  const second = model({
    boardEtaMs: NOW + 5 * MINUTE,
    etaChain: [{ stopId: "boarding", seq: 3, cumDist: 2_000, etaMs: NOW + 5 * MINUTE }],
  });
  const snapshots = [structuredClone(first), structuredClone(second)];
  const { smoother } = beginRevision(first, second);
  for (let elapsed = 0; elapsed <= BLEND_MS; elapsed += 250) {
    smoother.getPosition("route", NOW + elapsed, elapsed);
  }
  smoother.clearAll();
  assert.deepEqual(first, snapshots[0]);
  assert.deepEqual(second, snapshots[1]);
});

test("a configured duration converges exactly and a zero duration immediately follows the target", () => {
  const oldModel = model();
  const next = model({ boardEtaMs: NOW + 5 * MINUTE });
  const short = createPositionSmoother({ blendMs: 800 });
  short.setEstimate("route", oldModel, NOW, 0);
  assert.deepEqual(short.setEstimate("route", next, NOW, 0), resolveBusPlacement(oldModel, NOW));
  assert.deepEqual(short.getPosition("route", NOW + 800, 800), resolveBusPlacement(next, NOW + 800));
  const instant = createPositionSmoother({ blendMs: 0 });
  instant.setEstimate("route", oldModel, NOW, 0);
  assert.deepEqual(instant.setEstimate("route", next, NOW, 0), resolveBusPlacement(next, NOW));
});
