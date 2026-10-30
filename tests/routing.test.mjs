import assert from "node:assert/strict";
import test from "node:test";

const asStops = (coordinates) => coordinates.map(([lng, lat]) => ({ lat, lng }));
const asCoordinates = (points) => points.map(({ lng, lat }) => [lng, lat]);
const coordinatesFromUrl = (url) => new URL(url).pathname.split("/").at(-1)
  .split(";").map((pair) => pair.split(",").map(Number));

function osrmPayload(coordinates, legPaths = null) {
  const paths = legPaths ?? coordinates.slice(1).map((to, i) => [coordinates[i], to]);
  return {
    code: "Ok",
    waypoints: coordinates.map((location) => ({ location })),
    routes: [{
      legs: paths.map((path) => ({
        distance: path.length > 1 ? 1 : 0,
        steps: [{ geometry: { type: "LineString", coordinates: path } }],
      })),
    }],
  };
}

function mockStorage(t) {
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const entries = new Map();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key) => entries.get(key) ?? null,
      setItem: (key, value) => entries.set(key, value),
      removeItem: (key) => entries.delete(key),
    },
  });
  t.after(() => {
    if (original) Object.defineProperty(globalThis, "localStorage", original);
    else delete globalThis.localStorage;
  });
  return entries;
}

const freshRouting = (name) => import(`../js/routing.js?routing-test=${name}`);
const okResponse = (payload) => ({ ok: true, json: async () => payload });

function assertBoundaries(route, coordinates) {
  assert.equal(route.stopIndices.length, coordinates.length);
  assert.equal(route.stopIndices[0], 0);
  assert.equal(route.stopIndices.at(-1), route.points.length - 1);
  for (let i = 0; i < coordinates.length; i++) {
    assert.deepEqual(asCoordinates([route.points[route.stopIndices[i]]])[0], coordinates[i]);
    if (i) assert.ok(route.stopIndices[i] >= route.stopIndices[i - 1]);
  }
}

test("ordered leg boundaries preserve later visits to the same coordinate", async (t) => {
  mockStorage(t);
  const coordinates = [[114, 22], [114.01, 22], [114, 22], [114.01, 22]];
  t.mock.method(globalThis, "fetch", async (url) => {
    const parsed = new URL(url);
    assert.equal(parsed.searchParams.get("steps"), "true");
    assert.equal(parsed.searchParams.get("geometries"), "geojson");
    assert.equal(parsed.searchParams.get("overview"), "false");
    return okResponse(osrmPayload(coordinates));
  });
  const { roadSnapRoute } = await freshRouting("loop");
  const route = await roadSnapRoute(asStops(coordinates));
  assert.deepEqual(asCoordinates(route.points), coordinates);
  assert.deepEqual(route.stopIndices, [0, 1, 2, 3]);
  assertBoundaries(route, coordinates);
});

test("flattening steps deduplicates shared endpoints without losing stop boundaries", async (t) => {
  mockStorage(t);
  const coordinates = [[114, 22], [114.02, 22], [114.04, 22]];
  const payload = osrmPayload(coordinates);
  payload.routes[0].legs[0].steps = [
    { geometry: { coordinates: [coordinates[0], [114.01, 22]] } },
    { geometry: { coordinates: [[114.01, 22], coordinates[1]] } },
    { geometry: { coordinates: [coordinates[1], coordinates[1]] } },
  ];
  t.mock.method(globalThis, "fetch", async () => okResponse(payload));
  const { roadSnapRoute } = await freshRouting("steps");
  const route = await roadSnapRoute(asStops(coordinates));
  assert.deepEqual(route.stopIndices, [0, 2, 3]);
  assert.deepEqual(asCoordinates(route.points), [coordinates[0], [114.01, 22], coordinates[1], coordinates[2]]);
  assertBoundaries(route, coordinates);
});

test("zero-distance adjacent stops can share a vertex index", async (t) => {
  mockStorage(t);
  const coordinates = [[114, 22], [114, 22], [114.01, 22]];
  const payload = osrmPayload(coordinates);
  payload.routes[0].legs[0] = { distance: 0, steps: [] };
  t.mock.method(globalThis, "fetch", async () => okResponse(payload));
  const { roadSnapRoute } = await freshRouting("zero-distance");
  const route = await roadSnapRoute(asStops(coordinates));
  assert.deepEqual(route.stopIndices, [0, 0, 1]);
  assertBoundaries(route, coordinates);
});

test("sub-metre real OSRM endpoint differences preserve ordered road geometry", async (t) => {
  const entries = mockStorage(t);
  const coordinates = [
    [114.165831, 22.278598],
    [114.179154, 22.277873],
    [114.175976, 22.281696],
  ];
  // These discrepancies occur in the live 1M inbound OSRM response.
  const firstStepStart = [114.165830, 22.278593];
  const firstStepEnd = [114.179158, 22.277874];
  const midpoints = [[114.17, 22.278], [114.177, 22.28]];
  const payload = osrmPayload(coordinates, [
    [firstStepStart, midpoints[0], firstStepEnd],
    [coordinates[1], midpoints[1], coordinates[2]],
  ]);
  t.mock.method(globalThis, "fetch", async () => okResponse(payload));
  const { roadSnapRoute } = await freshRouting("submetre-endpoints");
  const route = await roadSnapRoute(asStops(coordinates));

  assert.equal(entries.size, 1, "valid step geometry is cached instead of falling back");
  assert.deepEqual(route.stopIndices, [0, 3, 6]);
  assert.deepEqual(asCoordinates(route.points), [
    coordinates[0], firstStepStart, midpoints[0], firstStepEnd,
    coordinates[1], midpoints[1], coordinates[2],
  ]);
  assert.deepEqual(asCoordinates([route.points[route.stopIndices[1]]])[0], firstStepEnd);
});

test("endpoint disagreement beyond two metres still rejects the routed chunk", async (t) => {
  const entries = mockStorage(t);
  const coordinates = [[114, 22], [114.01, 22]];
  const payload = osrmPayload(coordinates, [[coordinates[0], [114.01, 22.00003]]]);
  t.mock.method(console, "warn", () => {});
  t.mock.method(globalThis, "fetch", async () => okResponse(payload));
  const { roadSnapRoute } = await freshRouting("distant-endpoint");
  const route = await roadSnapRoute(asStops(coordinates));

  assertBoundaries(route, coordinates);
  assert.equal(entries.size, 0);
});

test("endpoint tolerance does not conceal a discontinuity between route steps", async (t) => {
  const entries = mockStorage(t);
  const coordinates = [[114, 22], [114.01, 22]];
  const payload = osrmPayload(coordinates);
  payload.routes[0].legs[0].steps = [
    { geometry: { coordinates: [coordinates[0], [114.005, 22]] } },
    { geometry: { coordinates: [[114.005, 22.000004], coordinates[1]] } },
  ];
  t.mock.method(console, "warn", () => {});
  t.mock.method(globalThis, "fetch", async () => okResponse(payload));
  const { roadSnapRoute } = await freshRouting("strict-step-joins");
  const route = await roadSnapRoute(asStops(coordinates));

  assertBoundaries(route, coordinates);
  assert.equal(entries.size, 0);
});

test("long routes retain all waypoints and compatibility wrappers share the rich cache", async (t) => {
  const entries = mockStorage(t);
  const coordinates = Array.from({ length: 51 }, (_, i) => [114 + i / 1000, 22]);
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url) => {
    const chunk = coordinatesFromUrl(url);
    calls.push(chunk);
    assert.ok(chunk.length <= 25);
    return okResponse(osrmPayload(chunk));
  });
  const { roadSnapRoute, roadSnapStops, roadSnapStopsChunked } = await freshRouting("chunks");
  const stops = asStops(coordinates);
  const route = await roadSnapRoute(stops);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[0], coordinates.slice(0, 25));
  assert.deepEqual(calls[1], coordinates.slice(24, 49));
  assert.deepEqual(calls[2], coordinates.slice(48));
  assert.deepEqual(asCoordinates(route.points), coordinates);
  assertBoundaries(route, coordinates);
  assert.deepEqual(await roadSnapStops(stops), route.points);
  assert.deepEqual(await roadSnapStopsChunked(stops), route.points);
  assert.equal(calls.length, 3);
  assert.equal(entries.size, 3);
  assert.ok([...entries.keys()].every((key) => key.startsWith("bus:osrm:v3:")));
});

test("different snapped chunk joins retain the connector and the existing stop index", async (t) => {
  mockStorage(t);
  const coordinates = Array.from({ length: 26 }, (_, i) => [114 + i / 1000, 22]);
  t.mock.method(globalThis, "fetch", async (url) => {
    const chunk = coordinatesFromUrl(url);
    if (chunk.length === 2) chunk[0] = [chunk[0][0], 22.0001];
    return okResponse(osrmPayload(chunk));
  });
  const { roadSnapRoute } = await freshRouting("different-join");
  const route = await roadSnapRoute(asStops(coordinates));
  assert.equal(route.points.length, 27);
  assert.equal(route.stopIndices[24], 24);
  assert.equal(route.stopIndices[25], 26);
  assert.deepEqual(asCoordinates([route.points[24], route.points[25]]), [
    coordinates[24], [coordinates[24][0], 22.0001],
  ]);
  assertBoundaries(route, coordinates);
});

test("failed chunks retain every stop occurrence and retry rather than caching fallback", async (t) => {
  const entries = mockStorage(t);
  const coordinates = [[114, 22], [114.01, 22], [114, 22]];
  let requests = 0;
  t.mock.method(console, "warn", () => {});
  t.mock.method(globalThis, "fetch", async () => {
    requests += 1;
    if (requests === 1) throw new Error("offline");
    return okResponse(osrmPayload(coordinates));
  });
  const { roadSnapRoute } = await freshRouting("retry");
  const route = await roadSnapRoute(asStops(coordinates));
  assertBoundaries(route, coordinates);
  assert.equal(entries.size, 0);
  assertBoundaries(await roadSnapRoute(asStops(coordinates)), coordinates);
  assert.equal(requests, 2);
  assert.equal(entries.size, 1);
});

test("one failed chunk does not erase stop boundaries in a longer route", async (t) => {
  const entries = mockStorage(t);
  const coordinates = Array.from({ length: 26 }, (_, i) => [114 + i / 1000, 22]);
  t.mock.method(console, "warn", () => {});
  t.mock.method(globalThis, "fetch", async (url) => {
    const chunk = coordinatesFromUrl(url);
    if (chunk.length === 2) return { ok: false, status: 503 };
    return okResponse(osrmPayload(chunk));
  });
  const { roadSnapRoute } = await freshRouting("failed-chunk");
  const route = await roadSnapRoute(asStops(coordinates));
  assertBoundaries(route, coordinates);
  assert.equal(entries.size, 1);
});

test("malformed leg geometry falls back without inventing a nearest stop location", async (t) => {
  const entries = mockStorage(t);
  const coordinates = [[114, 22], [114.01, 22], [114, 22]];
  const payload = osrmPayload(coordinates);
  // Valid-looking overall endpoints cannot make an unowned middle boundary safe.
  payload.routes[0].legs[0].steps[0].geometry.coordinates[1] = [114.005, 22];
  t.mock.method(console, "warn", () => {});
  t.mock.method(globalThis, "fetch", async () => okResponse(payload));
  const { roadSnapRoute } = await freshRouting("malformed");
  const route = await roadSnapRoute(asStops(coordinates));
  assert.deepEqual(asCoordinates(route.points), coordinates);
  assert.deepEqual(route.stopIndices, [0, 1, 2]);
  assert.equal(entries.size, 0);
});

test("old point-only caches are ignored and rich caches preserve occurrence boundaries", async (t) => {
  const entries = mockStorage(t);
  const coordinates = [[114, 22], [114.01, 22], [114, 22]];
  const key = coordinates.map((coord) => coord.join(",")).join(";");
  entries.set(`bus:osrm:v2:${key}`, JSON.stringify({ at: Date.now(), value: asStops(coordinates) }));
  let requests = 0;
  t.mock.method(globalThis, "fetch", async () => {
    requests += 1;
    return okResponse(osrmPayload(coordinates));
  });
  const first = await freshRouting("cache-write");
  const expected = await first.roadSnapRoute(asStops(coordinates));
  assert.equal(requests, 1);
  const second = await freshRouting("cache-read");
  assert.deepEqual(await second.roadSnapRoute(asStops(coordinates)), expected);
  assert.equal(requests, 1);
});

test("malformed cached indices are rejected and fetched again", async (t) => {
  const entries = mockStorage(t);
  const coordinates = [[114, 22], [114.01, 22], [114, 22]];
  const key = coordinates.map((coord) => coord.join(",")).join(";");
  entries.set(`bus:osrm:v3:${key}`, JSON.stringify({
    at: Date.now(), value: { points: asStops(coordinates), stopIndices: [0, 2, 1] },
  }));
  let requests = 0;
  t.mock.method(globalThis, "fetch", async () => {
    requests += 1;
    return okResponse(osrmPayload(coordinates));
  });
  const { roadSnapRoute } = await freshRouting("invalid-cache");
  const route = await roadSnapRoute(asStops(coordinates));
  assertBoundaries(route, coordinates);
  assert.equal(requests, 1);
});

test("concurrent consumers share one in-flight road request", async (t) => {
  mockStorage(t);
  const coordinates = [[114, 22], [114.01, 22]];
  let requests = 0;
  t.mock.method(globalThis, "fetch", async () => {
    requests += 1;
    return okResponse(osrmPayload(coordinates));
  });
  const { roadSnapRoute, roadSnapStops } = await freshRouting("inflight");
  const [route, points] = await Promise.all([
    roadSnapRoute(asStops(coordinates)), roadSnapStops(asStops(coordinates)),
  ]);
  assert.equal(requests, 1);
  assert.deepEqual(points, route.points);
});

test("empty and singleton routes do not need a road request", async (t) => {
  mockStorage(t);
  t.mock.method(globalThis, "fetch", () => { throw new Error("unexpected fetch"); });
  const { roadSnapRoute } = await freshRouting("empty");
  assert.deepEqual(await roadSnapRoute([]), { points: [], stopIndices: [] });
  assert.deepEqual(await roadSnapRoute([{ lat: 22, lng: 114 }]), {
    points: [{ lat: 22, lng: 114 }], stopIndices: [0],
  });
  await assert.rejects(roadSnapRoute([{ lat: NaN, lng: 114 }]), /invalid stop coordinates/);
});
