import test from "node:test";
import assert from "node:assert/strict";
import {
  estimateBusPosition,
  resolveApproachPulse,
  resolveBusPlacement,
} from "../js/estimate.js";
import { DEFAULT_BUS_SPEED_M_PER_MIN, MAX_BUS_SPEED_M_PER_MIN } from "../js/config.js";

const NOW = Date.UTC(2026, 9, 30, 4);
const MINUTE = 60_000;
let scenarioNumber = 0;

function arrival(minutes, seq = 1, stopSeq = null) {
  return {
    eta: new Date(NOW + minutes * MINUTE).toISOString(),
    dir: "O",
    dest_en: "Test destination",
    eta_seq: seq,
    ...(stopSeq == null ? {} : { seq: stopSeq }),
    data_timestamp: new Date(NOW - 50_000).toISOString(),
  };
}

function fixture(t, offsets, etaMinutes, {
  roadIndices = null,
  upstreamFailure = false,
  upstreamData = null,
  failedStopIndices = [],
  failedCoordinateIndices = [],
  stopIds = null,
  boardingIndex = offsets.length - 1,
  apiSeqOffset = 0,
} = {}) {
  const id = ++scenarioNumber;
  const route = `TEST-${id}`;
  const lat = 22.3 + id * 0.01;
  const stops = offsets.map((offset, i) => ({
    stopId: `test-${id}-${stopIds?.[i] ?? i}`,
    seq: i + 1,
    lat,
    lng: 114.1 + offset,
  }));
  const byId = new Map(stops.map(stop => [stop.stopId, stop]));
  const road = (roadIndices ?? stops.map((_, i) => i)).map(i => stops[i]);
  const requests = [];
  const cache = new Map();
  const storageDescriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: key => cache.get(key) ?? null,
      setItem: (key, value) => cache.set(key, value),
      removeItem: key => cache.delete(key),
    },
  });
  t.after(() => {
    if (storageDescriptor) Object.defineProperty(globalThis, "localStorage", storageDescriptor);
    else delete globalThis.localStorage;
  });
  t.mock.method(Date, "now", () => NOW);
  t.mock.method(globalThis, "fetch", async input => {
    const url = new URL(String(input));
    requests.push(url.pathname);
    let body;
    if (url.hostname === "router.project-osrm.org") {
      const requested = url.pathname.split("/driving/")[1].split(";")
        .map(coordinate => coordinate.split(",").map(Number));
      const boundaryIndices = [];
      let cursor = 0;
      for (const [lng, lat] of requested) {
        const index = road.findIndex((point, i) => i >= cursor && point.lng === lng && point.lat === lat);
        assert.ok(index >= 0, "requested waypoint must exist in the ordered fixture geometry");
        boundaryIndices.push(index);
        cursor = index + 1;
      }
      const requestedRoad = road.slice(boundaryIndices[0], boundaryIndices.at(-1) + 1);
      body = {
        code: "Ok",
        waypoints: requested.map(location => ({ location })),
        routes: [{
          geometry: { coordinates: requestedRoad.map(stop => [stop.lng, stop.lat]) },
          legs: boundaryIndices.slice(1).map((end, i) => ({
            steps: [{ geometry: {
              type: "LineString",
              coordinates: road.slice(boundaryIndices[i], end + 1).map(stop => [stop.lng, stop.lat]),
            } }],
          })),
        }],
      };
    } else if (url.pathname === `/v2/transport/citybus/route-stop/CTB/${route}/outbound`) {
      body = { data: stops.map(stop => ({ seq: stop.seq, stop: stop.stopId, dir: "O" })) };
    } else if (url.pathname.startsWith("/v2/transport/citybus/stop/")) {
      const stop = byId.get(url.pathname.split("/").at(-1));
      assert.ok(stop, "unexpected stop request");
      if (failedCoordinateIndices.some(index => stops[index].stopId === stop.stopId)) {
        throw new Error("Synthetic stop coordinate outage");
      }
      body = { data: {
        stop: stop.stopId,
        name_en: `Test stop ${stop.seq}`,
        lat: stop.lat,
        long: stop.lng,
      } };
    } else if (url.pathname.startsWith("/v2/transport/citybus/eta/CTB/")) {
      const stopId = url.pathname.split("/").at(-2);
      const indices = stops.flatMap((stop, index) => stop.stopId === stopId ? [index] : []);
      assert.ok(indices.length > 0, "unexpected upstream ETA request");
      if (upstreamFailure || indices.some(index => failedStopIndices.includes(index))) {
        throw new Error("Synthetic upstream API outage");
      }
      body = {
        data: indices.flatMap(index => {
          const minutes = etaMinutes[index];
          const entries = upstreamData && Object.hasOwn(upstreamData, index)
            ? upstreamData[index]
            : minutes == null ? [] : [arrival(minutes)];
          return entries.map(entry => ({ ...entry, seq: entry.seq ?? stops[index].seq + apiSeqOffset }));
        }),
        generated_timestamp: new Date(NOW).toISOString(),
      };
    } else {
      assert.fail(`Unexpected network request: ${url.origin}${url.pathname}`);
    }
    return new Response(JSON.stringify(body), { status: 200 });
  });
  return {
    entry: { route, stopId: stops[boardingIndex].stopId, direction: "O" },
    stops,
    requests,
    bundle: {
      first: arrival(etaMinutes[boardingIndex], 1, stops[boardingIndex].seq + apiSeqOffset),
      second: null,
      snapshotMs: NOW - 50_000,
      receivedAtMs: NOW,
    },
  };
}

function assertPlausibleChain(chain) {
  assert.ok(chain.length >= 2, "test fixture must produce usable chain evidence");
  for (let i = 1; i < chain.length; i++) {
    const distance = chain[i].cumDist - chain[i - 1].cumDist;
    const minutes = (chain[i].etaMs - chain[i - 1].etaMs) / MINUTE;
    assert.ok(distance > 0 && minutes > 0);
    assert.ok(distance / minutes <= MAX_BUS_SPEED_M_PER_MIN);
  }
}

test("estimation maps boarding to its ordered later road occurrence", async t => {
  // A→B passes boarding's coordinates, then returns to the actual boarding stop.
  const f = fixture(t, [0, 0.02, 0.01], [2, 4, 10], { roadIndices: [0, 2, 1, 2] });
  const result = await estimateBusPosition(f.entry, f.bundle, { denseUpstream: true, refreshUpstream: true });
  const middle = result.stops.find(stop => stop.stopId === f.stops[1].stopId);
  assert.ok(middle.cumDist < result.boardingCumDist, "boarding belongs after the upstream stop");
  assert.equal(result.boardingCumDist, result.routePolyline.at(-1).cumDist);
  assert.equal(result.etaChain.at(-1).stopId, f.entry.stopId);
  assert.equal(result.etaChain.at(-1).cumDist, result.boardingCumDist);
  assert.ok(result.etaChain.every(p => p.cumDist <= result.boardingCumDist));
  assertPlausibleChain(result.etaChain);
});

test("offset ETA sequence values preserve unique boarding and upstream route occurrences", async t => {
  const f = fixture(t, [0, 0.005, 0.01, 0.015], [2, 4, 6, 10], { apiSeqOffset: 15 });
  assert.equal(f.bundle.first.seq, 19, "API sequence differs from canonical boarding sequence 4");
  const result = await estimateBusPosition(f.entry, f.bundle, { denseUpstream: true, refreshUpstream: true });
  assert.equal(result.boardingStop.seq, 4);
  assert.equal(result.boardingStop.stopId, f.stops[3].stopId);
  assert.equal(result.reason, "segment");
  assert.deepEqual(result.etaChain.map(stop => stop.seq), [1, 2, 3, 4]);
  assert.deepEqual(result.etaChain.map(stop => stop.etaMs), [2, 4, 6, 10].map(minutes => NOW + minutes * MINUTE));
  assertPlausibleChain(result.etaChain);
});

test("unique physical stops remain usable when API sequence offsets disagree", async t => {
  const f = fixture(t, [0, 0.005, 0.01, 0.015], [2, 4, 6, 10], {
    apiSeqOffset: 15,
    upstreamData: { 1: [{ ...arrival(4), seq: 99 }] },
  });
  const result = await estimateBusPosition(f.entry, f.bundle, { denseUpstream: true, refreshUpstream: true });
  assert.equal(result.boardingStop.seq, 4);
  assert.deepEqual(result.etaChain.map(stop => stop.seq), [1, 2, 3, 4]);
  assertPlausibleChain(result.etaChain);
});

test("a route returning to its origin keeps the later boarding occurrence and return-leg motion", async t => {
  const f = fixture(t, [0, 0.01, 0], [2, 4, 10]);
  const result = await estimateBusPosition(f.entry, f.bundle, { denseUpstream: true, refreshUpstream: true });
  assert.ok(result.boardingCumDist > 0);
  assert.equal(result.stops[0].cumDist, 0);
  assert.ok(result.stops[1].cumDist > 0 && result.stops[1].cumDist < result.boardingCumDist);
  assert.equal(result.stops[2].cumDist, result.boardingCumDist);
  assertPlausibleChain(result.etaChain);
  const time = NOW + 5 * MINUTE;
  const placement = resolveBusPlacement(result, time);
  const pulse = resolveApproachPulse(result, time, placement);
  assert.ok(placement.cumDist > result.stops[1].cumDist && placement.cumDist < result.boardingCumDist);
  assert.equal(pulse.fromCum, result.stops[1].cumDist);
  assert.equal(pulse.toCum, result.boardingCumDist);
  assert.equal(pulse.busCum, placement.cumDist);
});

test("out-and-back stops on the same road retain separate ordered distances", async t => {
  const f = fixture(t, [0, 0.01, 0.02, 0.01, 0], [2, 4, 6, 8, 12]);
  const result = await estimateBusPosition(f.entry, f.bundle, { denseUpstream: true, refreshUpstream: true });
  assert.equal(result.stops[1].lng, result.stops[3].lng);
  assert.ok(result.stops[3].cumDist > result.stops[1].cumDist);
  assert.ok(result.stops.every((stop, i) => i === 0 || stop.cumDist > result.stops[i - 1].cumDist));
  assert.equal(result.etaChain.length, 5);
  assertPlausibleChain(result.etaChain);
});

test("repeated stop IDs use each ETA's route sequence instead of merging visits", async t => {
  const f = fixture(t, [0, 0.005, 0.01, 0.015, 0.005, 0], [2, 4, 6, 8, 10, 14], {
    stopIds: [0, 1, 2, 3, 1, 0],
  });
  const result = await estimateBusPosition(f.entry, f.bundle, { denseUpstream: true, refreshUpstream: true });
  assert.notEqual(result.reason, "seq-1", "boarding ETA sequence identifies the later visit to this stop ID");
  assert.equal(result.stops.length, 6);
  assert.deepEqual(result.stops.map(stop => stop.seq), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(result.etaChain.map(stop => stop.seq), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(result.etaChain.map(stop => stop.etaMs), [2, 4, 6, 8, 10, 14].map(minutes => NOW + minutes * MINUTE));
  assert.ok(result.boardingCumDist > result.stops[4].cumDist);
  assertPlausibleChain(result.etaChain);

  const noSequence = { ...f.bundle, first: { ...f.bundle.first } };
  delete noSequence.first.seq;
  const ambiguous = await estimateBusPosition(f.entry, noSequence, { denseUpstream: true, refreshUpstream: true });
  assert.equal(ambiguous.reason, "ambiguous-stop");
  assert.equal(resolveBusPlacement(ambiguous, NOW), null);
});

test("two consistent unique anchors calibrate an offset before selecting a repeated visit", async t => {
  const f = fixture(t, [0, 0.005, 0.01, 0.005, 0.02], [2, 4, 6, 8, 12], {
    stopIds: [0, 1, 2, 1, 3],
    boardingIndex: 3,
    apiSeqOffset: 15,
  });
  const result = await estimateBusPosition(f.entry, f.bundle, { denseUpstream: true, refreshUpstream: true });
  assert.equal(result.boardingStop.seq, 4);
  assert.equal(result.boardingStop.apiSeq, 19);
  assert.deepEqual(result.etaChain.map(stop => stop.seq), [1, 2, 3, 4]);
  assert.deepEqual(result.etaChain.map(stop => stop.etaMs), [2, 4, 6, 8].map(minutes => NOW + minutes * MINUTE));
  assertPlausibleChain(result.etaChain);
});

test("an offset API sequence colliding with a later canonical sequence cannot select the wrong visit", async t => {
  const f = fixture(t, [0, 0.005, 0.01, 0.005, 0.02], [2, 4, 6, 8, 12], {
    stopIds: [0, 1, 2, 1, 3],
    boardingIndex: 1,
    apiSeqOffset: 2,
  });
  assert.equal(f.bundle.first.seq, 4, "raw API seq also names the later canonical visit");
  const result = await estimateBusPosition(f.entry, f.bundle, { denseUpstream: true, refreshUpstream: true });
  assert.equal(result.boardingStop.seq, 2);
  assert.equal(result.boardingStop.apiSeq, 4);
  assert.deepEqual(result.stops.map(stop => stop.seq), [1, 2]);
  assert.deepEqual(result.etaChain.map(stop => stop.seq), [1, 2]);
});

test("one unique anchor is insufficient to disambiguate a repeated boarding stop", async t => {
  const f = fixture(t, [0, 0.005, 0.01, 0.005, 0], [2, 4, 6, 8, 12], { stopIds: [0, 1, 2, 1, 0] });
  const result = await estimateBusPosition(f.entry, f.bundle, { denseUpstream: true, refreshUpstream: true });
  assert.equal(result.reason, "ambiguous-stop");
  assert.equal(resolveBusPlacement(result, NOW), null);
  assert.equal(resolveApproachPulse(result, NOW), null);
});

test("conflicting unique anchor offsets leave a repeated boarding stop ambiguous", async t => {
  const f = fixture(t, [0, 0.005, 0.01, 0.005, 0.02], [2, 4, 6, 8, 12], {
    stopIds: [0, 1, 2, 1, 3],
    boardingIndex: 3,
    apiSeqOffset: 15,
    upstreamData: { 2: [{ ...arrival(6), seq: 99 }] },
  });
  const result = await estimateBusPosition(f.entry, f.bundle, { denseUpstream: true, refreshUpstream: true });
  assert.equal(result.reason, "ambiguous-stop");
  assert.equal(resolveBusPlacement(result, NOW), null);
});

test("uncalibrated repeated upstream visits remain unknown while unique boarding still works", async t => {
  const f = fixture(t, [0, 0.005, 0, 0.005, 0.01], [2, 4, 6, 8, 20], {
    stopIds: [0, 1, 0, 1, 2],
  });
  const result = await estimateBusPosition(f.entry, f.bundle, { denseUpstream: true, refreshUpstream: true });
  assert.equal(result.boardingStop.seq, 5);
  assert.equal(result.reason, "default-speed");
  assert.equal(result.etaChain, null);
  assert.equal(result.minCumDist, 0);
  assert.equal(resolveBusPlacement(result, NOW).cumDist, 0);
});

test("missing upstream coordinates cannot shift the selected boarding occurrence", async t => {
  const f = fixture(t, [0, 0.01, 0.02, 0.03, 0.04], [2, 4, 6, 12, 16], {
    boardingIndex: 3,
    failedCoordinateIndices: [1],
  });
  const result = await estimateBusPosition(f.entry, f.bundle, { denseUpstream: true, refreshUpstream: true });
  assert.equal(result.boardingStop.seq, 4);
  assert.equal(result.boardingStop.stopId, f.stops[3].stopId);
  assert.deepEqual(result.stops.map(stop => stop.seq), [1, 3, 4]);
  assert.deepEqual(result.stops.filter(stop => stop.isBoarding).map(stop => stop.seq), [4]);
  assert.equal(result.polyline.at(-1).cumDist, result.boardingCumDist);
  assert.ok(result.routePolyline.at(-1).cumDist > result.boardingCumDist);
  assert.equal(result.etaChain.at(-1).seq, 4);
  assertPlausibleChain(result.etaChain);
});

test("missing every upstream coordinate hides the bus instead of fabricating it at boarding", async t => {
  const f = fixture(t, [0, 0.01, 0.02], [2, 4, 10], { failedCoordinateIndices: [0, 1] });
  const result = await estimateBusPosition(f.entry, f.bundle, { denseUpstream: true, refreshUpstream: true });
  assert.equal(result.reason, "no-geometry");
  assert.equal(result.boardingStop.seq, 3);
  assert.equal(result.boardingCumDist, 0);
  assert.equal(result.busLatLng, null);
  assert.equal(result.busCumDist, null);
  assert.equal(resolveBusPlacement(result, NOW), null);
  assert.equal(resolveApproachPulse(result, NOW), null);
});

test("a zero-length approach hides the bus even when every stop has coordinates", async t => {
  const f = fixture(t, [0, 0, 0], [2, 4, 10]);
  const result = await estimateBusPosition(f.entry, f.bundle, { denseUpstream: true, refreshUpstream: true });
  assert.equal(result.reason, "no-geometry");
  assert.equal(result.stops.length, 3);
  assert.ok(result.stops.every(stop => stop.cumDist === 0));
  assert.equal(result.busLatLng, null);
  assert.equal(result.busCumDist, null);
  assert.equal(resolveBusPlacement(result, NOW), null);
  assert.equal(resolveApproachPulse(result, NOW), null);
});

test("missing boarding ETA sequence leaves repeated visits ambiguous", async t => {
  const f = fixture(t, [0, 0.005, 0.01, 0.005, 0.02], [2, 4, 6, 8, 12], {
    boardingIndex: 3,
    stopIds: [0, 1, 2, 1, 3],
  });
  delete f.bundle.first.seq;
  const result = await estimateBusPosition(f.entry, f.bundle, { denseUpstream: true, refreshUpstream: true });
  assert.equal(result.reason, "ambiguous-stop");
  assert.equal(resolveBusPlacement(result, NOW), null);
  assert.equal(resolveApproachPulse(result, NOW), null);
});

test("a unique boarding stop remains usable without an API sequence", async t => {
  const f = fixture(t, [0, 0.005, 0.01, 0.015], [2, 4, 6, 10]);
  delete f.bundle.first.seq;
  const result = await estimateBusPosition(f.entry, f.bundle, { denseUpstream: true, refreshUpstream: true });
  assert.equal(result.boardingStop.seq, 4);
  assert.deepEqual(result.etaChain.map(stop => stop.seq), [1, 2, 3, 4]);
  assertPlausibleChain(result.etaChain);
});

test("sampled upstream evidence retains repeated stop IDs as distinct sequence occurrences", async t => {
  const f = fixture(t, [0, 0.005, 0.01, 0, 0.015, 0.01, 0.02], [2, 4, 6, 8, 10, 12, 20], {
    stopIds: [0, 1, 2, 0, 3, 2, 4],
  });
  const result = await estimateBusPosition(f.entry, f.bundle, { denseUpstream: false, refreshUpstream: true });
  const requests = f.requests.filter(path => path.includes("/eta/CTB/"));
  const repeatedIds = new Set([f.stops[0].stopId, f.stops[2].stopId]);
  const repeatedRequests = requests.filter(path => repeatedIds.has(path.split("/").at(-2)));
  assert.equal(repeatedRequests.length, 2, "concurrent occurrence reads share each physical stop's payload");
  assert.equal(new Set(repeatedRequests).size, 2, "two physical stop IDs each supply two route occurrences");
  assert.deepEqual(result.etaChain.map(stop => stop.seq), [1, 3, 4, 6, 7]);
  assertPlausibleChain(result.etaChain);
});

test("approach geometry is a prefix of the same full route instead of a second routing result", async t => {
  const f = fixture(t, [0, 0.01, 0.02, 0.03, 0.04], [2, 4, 8, 12, 15], {
    boardingIndex: 2,
    roadIndices: [0, 1, 0, 2, 3, 4],
  });
  const result = await estimateBusPosition(f.entry, f.bundle, { denseUpstream: true, refreshUpstream: true });
  assert.deepEqual(result.polyline, result.routePolyline.slice(0, result.polyline.length));
  assert.equal(result.polyline.at(-1).cumDist, result.boardingCumDist);
  assert.ok(result.routePolyline.at(-1).cumDist > result.boardingCumDist);
  assert.equal(f.requests.filter(path => path.includes("/route/v1/driving/")).length, 1);
});

test("long routes preserve every stop occurrence through overlapping routing chunks", async t => {
  const offsets = Array.from({ length: 30 }, (_, i) => i * 0.001);
  const f = fixture(t, offsets, offsets.map((_, i) => i === offsets.length - 1 ? 40 : null));
  const result = await estimateBusPosition(f.entry, f.bundle, { denseUpstream: true, refreshUpstream: true });
  const routes = f.requests.filter(path => path.includes("/route/v1/driving/"))
    .map(path => path.split("/driving/")[1].split(";"));
  assert.equal(routes.length, 2, "one chunked full route also supplies the approach");
  assert.ok(routes.every(chunk => chunk.length <= 25));
  assert.equal(routes[0].at(-1), routes[1][0], "chunks share their join stop");
  assert.equal(new Set(routes.flat()).size, offsets.length);
  assert.equal(result.stops.length, offsets.length);
  assert.ok(result.stops.every((stop, i) => i === 0 || stop.cumDist > result.stops[i - 1].cumDist));
  assert.deepEqual(result.polyline, result.routePolyline);
  assert.equal(result.boardingCumDist, result.routePolyline.at(-1).cumDist);
});

test("actual ETA fetching and chain construction reject an impossible adjacent leg", async t => {
  const f = fixture(t, [0, 0.01, 0.02, 0.03], [null, 2, 2.1, 10]);
  const result = await estimateBusPosition(f.entry, f.bundle, { denseUpstream: true, refreshUpstream: true });
  assert.equal(result.etaChain.at(-1).stopId, f.entry.stopId);
  assertPlausibleChain(result.etaChain);
  assert.ok(result.etaChain.length < 3, "conflicting upstream observations cannot both survive");
  assert.ok(f.requests.some(path => path.includes("/eta/CTB/")));
});

test("an old boarding snapshot hands off an expired first bus using current time", async t => {
  const f = fixture(t, [0, 0.002, 0.004], [2, 3, 5]);
  f.bundle.first = arrival(-1 / 6);
  f.bundle.second = arrival(5, 2);
  const result = await estimateBusPosition(f.entry, f.bundle, { denseUpstream: true, refreshUpstream: true });
  assert.equal(result.boardEtaMs, NOW + 5 * MINUTE);
  assert.equal(result.minutesToBoard, 5);
  assert.equal(result.busChanged, true);
  assert.equal(result.snapshotMs, NOW - 50_000, "source time remains metadata");
  assertPlausibleChain(result.etaChain);
});

test("upstream API failure falls back to finite shared placement without real network access", async t => {
  const f = fixture(t, [0, 0.01, 0.02], [null, null, 5], { upstreamFailure: true });
  const result = await estimateBusPosition(f.entry, f.bundle, { denseUpstream: true, refreshUpstream: true });
  assert.equal(result.reason, "default-speed");
  assert.equal(result.speedMPerMin, DEFAULT_BUS_SPEED_M_PER_MIN);
  assert.equal(result.etaChain, null);
  const placement = resolveBusPlacement(result, NOW);
  const pulse = resolveApproachPulse(result, NOW, placement);
  assert.ok(Number.isFinite(placement.cumDist));
  assert.ok(placement.cumDist >= 0 && placement.cumDist <= result.boardingCumDist);
  assert.equal(pulse.busCum, placement.cumDist);
  assert.ok(pulse.fromCum <= placement.cumDist && placement.cumDist <= pulse.toCum);
});

for (const secondsToBoard of [60, 30]) {
  test(`a boarding ETA ${secondsToBoard}s away still fetches upstream evidence and estimates position`, async t => {
    const minutes = secondsToBoard / 60;
    const f = fixture(t, [0, 0.0004, 0.0008], [minutes * 0.2, minutes * 0.4, minutes]);
    const result = await estimateBusPosition(f.entry, f.bundle, { denseUpstream: true, refreshUpstream: true });
    assert.equal(result.reason, "segment");
    assertPlausibleChain(result.etaChain);
    assert.equal(result.minutesToBoard, minutes);
    assert.equal(f.requests.filter(path => path.includes("/eta/CTB/")).length, 2);
    const initial = resolveBusPlacement(result, NOW);
    const laterTime = NOW + secondsToBoard * 1000 * 0.6;
    const later = resolveBusPlacement(result, laterTime);
    const pulse = resolveApproachPulse(result, laterTime, later);
    assert.ok(initial.cumDist < result.boardingCumDist);
    assert.ok(later.cumDist > initial.cumDist && later.cumDist < result.boardingCumDist);
    assert.equal(pulse.busCum, later.cumDist);
    assert.ok(pulse.fromCum <= later.cumDist && later.cumDist <= pulse.toCum);
  });
}

test("upstream outage in the final 30 seconds uses a moving fallback instead of boarding snap", async t => {
  const f = fixture(t, [0, 0.002, 0.004], [null, null, 0.5], { upstreamFailure: true });
  const result = await estimateBusPosition(f.entry, f.bundle, { denseUpstream: true, refreshUpstream: true });
  assert.equal(result.reason, "default-speed");
  assert.equal(f.requests.filter(path => path.includes("/eta/CTB/")).length, 2);
  const initial = resolveBusPlacement(result, NOW);
  const laterTime = NOW + 15_000;
  const later = resolveBusPlacement(result, laterTime);
  const pulse = resolveApproachPulse(result, laterTime, later);
  assert.ok(initial.cumDist < result.boardingCumDist);
  assert.ok(later.cumDist > initial.cumDist && later.cumDist < result.boardingCumDist);
  assert.ok(Math.abs(result.boardingCumDist - initial.cumDist - 125) < 1e-6);
  assert.equal(pulse.busCum, later.cumDist);
  assert.ok(pulse.fromCum <= later.cumDist && later.cumDist <= pulse.toCum);
});

for (const denseUpstream of [true, false]) {
  test(`empty upstream ETAs do not imply passed stops in ${denseUpstream ? "dense" : "sampled"} estimation`, async t => {
    const offsets = denseUpstream ? [0, 0.01, 0.02, 0.03] : [0, 0.008, 0.016, 0.024, 0.032, 0.04];
    const etaMinutes = offsets.map((_, i) => i === offsets.length - 1 ? 20 : null);
    const f = fixture(t, offsets, etaMinutes);
    const result = await estimateBusPosition(f.entry, f.bundle, { denseUpstream, refreshUpstream: true });
    assert.equal(result.minCumDist, 0);
    assert.equal(result.reason, "default-speed");
    assert.equal(result.busCumDist, 0, "long ETA fallback remains at the route origin");
    assert.equal(resolveBusPlacement(result, NOW).cumDist, 0);
    assert.equal(f.requests.filter(path => path.includes("/eta/CTB/")).length, denseUpstream ? 3 : 4);
  });
}

const absentEvidenceCases = [
  {
    name: "failed upstream requests",
    etaMinutes: [null, null, null, 20],
    options: { upstreamFailure: true },
  },
  {
    name: "remark-only upstream responses",
    etaMinutes: [null, null, null, 20],
    options: { upstreamData: Object.fromEntries([0, 1, 2].map(index => [index, [{
      ...arrival(1), eta: "", rmk_en: "No scheduled service",
    }]])) },
  },
  {
    name: "upstream ETAs later than boarding",
    etaMinutes: [21, 22, 23, 20],
  },
  {
    name: "upstream ETAs for another destination",
    etaMinutes: [null, null, null, 20],
    options: { upstreamData: Object.fromEntries([0, 1, 2].map(index => [index, [{
      ...arrival(2 + index), dest_en: "Another destination",
    }]])) },
  },
  {
    name: "upstream candidates rejected for impossible travel speed",
    etaMinutes: [19.9, 19.9, 19.9, 20],
  },
];

for (const scenario of absentEvidenceCases) {
  test(`${scenario.name} leave passage unknown, matching the empty-response fallback`, async t => {
    const f = fixture(t, [0, 0.01, 0.02, 0.03], scenario.etaMinutes, scenario.options);
    const result = await estimateBusPosition(f.entry, f.bundle, { denseUpstream: true, refreshUpstream: true });
    assert.equal(result.minCumDist, 0);
    assert.equal(result.reason, "default-speed");
    assert.equal(result.etaChain, null);
    assert.equal(result.busCumDist, 0);
    const placement = resolveBusPlacement(result, NOW);
    const pulse = resolveApproachPulse(result, NOW, placement);
    assert.equal(placement.cumDist, 0);
    assert.equal(pulse.busCum, placement.cumDist);
    assert.equal(pulse.fromCum, 0);
    assert.ok(pulse.toCum > placement.cumDist);
  });
}

for (const failedStopIndices of [[], [0]]) {
  test(`mixed missing${failedStopIndices.length ? " and failed" : ""} ETAs preserve credible upstream chain motion`, async t => {
    const f = fixture(t, [0, 0.01, 0.02, 0.03], [null, null, 15, 20], { failedStopIndices });
    const result = await estimateBusPosition(f.entry, f.bundle, { denseUpstream: true, refreshUpstream: true });
    assert.equal(result.minCumDist, 0);
    assert.equal(result.reason, "segment");
    assertPlausibleChain(result.etaChain);
    const futureStop = result.etaChain[0];
    assert.equal(futureStop.stopId, f.stops[2].stopId);
    const initial = resolveBusPlacement(result, NOW);
    assert.equal(initial.cumDist, 0, "missing earlier ETAs must not force the bus to their stops");
    const beforeFuture = resolveBusPlacement(result, NOW + 14 * MINUTE);
    const afterFuture = resolveBusPlacement(result, NOW + 16 * MINUTE);
    assert.ok(beforeFuture.cumDist > initial.cumDist && beforeFuture.cumDist < futureStop.cumDist);
    assert.ok(afterFuture.cumDist > futureStop.cumDist && afterFuture.cumDist < result.boardingCumDist);
    for (const [time, placement] of [[NOW, initial], [NOW + 14 * MINUTE, beforeFuture], [NOW + 16 * MINUTE, afterFuture]]) {
      const pulse = resolveApproachPulse(result, time, placement);
      assert.equal(pulse.busCum, placement.cumDist);
      assert.ok(pulse.fromCum <= placement.cumDist && placement.cumDist <= pulse.toCum);
    }
  });
}
