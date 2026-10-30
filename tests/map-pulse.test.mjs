import test from "node:test";
import assert from "node:assert/strict";
import {
  PULSE_DASH_WIDTH_PX,
  PULSE_DASH_FAR_LENGTH_PX,
  PULSE_DASH_NEAR_LENGTH_PX,
  PULSE_DASH_FAR_GAP_PX,
  PULSE_DASH_NEAR_GAP_PX,
  PULSE_DASH_SPEED_PX_PER_SEC,
} from "../js/config.js";

let nextImport = 1;

function installGlobal(t, name, value) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  t.after(() => {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete globalThis[name];
  });
}

function classList() {
  const values = new Set();
  return {
    add: (...names) => names.forEach(name => values.add(name)),
    remove: (...names) => names.forEach(name => values.delete(name)),
    contains: name => values.has(name),
    toggle(name, enabled) { enabled ? values.add(name) : values.delete(name); },
  };
}

async function harness(t) {
  const layers = [];
  const renderOrder = [];
  const frames = new Map();
  let nextFrameId = 1;
  const mapElement = {};
  const map = {
    attributionControl: { setPrefix() {} },
    getZoom: () => 15,
    setView() { return this; },
    invalidateSize() {},
    removeLayer(layer) {
      layer.removed = true;
      const index = renderOrder.indexOf(layer);
      if (index >= 0) renderOrder.splice(index, 1);
    },
    getSize: () => ({ x: 800, y: 600 }),
    fitBounds() {},
  };
  function layer(points, options = {}, kind = "polyline") {
    const element = {
      style: {},
      classList: classList(),
      getTotalLength: () => 1000,
      getAttribute: name => name === "d" ? "M0,0L1000,0" : null,
    };
    return {
      kind,
      options: { ...options },
      element,
      removed: false,
      addTo(target) {
        assert.equal(target, map);
        layers.push(this);
        renderOrder.push(this);
        return this;
      },
      bringToBack() {
        const index = renderOrder.indexOf(this);
        if (index >= 0) renderOrder.splice(index, 1);
        renderOrder.unshift(this);
      },
      bringToFront() {
        const index = renderOrder.indexOf(this);
        if (index >= 0) renderOrder.splice(index, 1);
        renderOrder.push(this);
      },
      getElement: () => element,
      getLatLngs: () => points,
      getLatLng: () => ({ lat: points[0], lng: points[1] }),
      setLatLng(next) { points = next; return this; },
      setLatLngs(next) { points = next; return this; },
      setStyle(next) { this.options = { ...this.options, ...next }; return this; },
    };
  }
  installGlobal(t, "document", {
    documentElement: { dataset: { theme: "light" } },
    body: { classList: classList() },
    getElementById: id => id === "focus-map" ? mapElement : null,
  });
  installGlobal(t, "getComputedStyle", () => ({ getPropertyValue: () => "" }));
  installGlobal(t, "MutationObserver", class {
    observe() {}
  });
  installGlobal(t, "requestAnimationFrame", callback => {
    const id = nextFrameId++;
    frames.set(id, callback);
    queueMicrotask(() => {
      if (!frames.has(id)) return;
      frames.delete(id);
      callback(0);
    });
    return id;
  });
  installGlobal(t, "cancelAnimationFrame", id => frames.delete(id));
  installGlobal(t, "window", {
    matchMedia: () => ({ matches: false }),
    L: {
      map(element) { assert.equal(element, mapElement); return map; },
      tileLayer: () => layer([], {}, "tile"),
      divIcon: options => options,
      polyline: (points, options) => layer(points, options),
      marker: (points, options) => layer(points, options, "marker"),
      latLngBounds: points => points,
    },
  });
  t.mock.method(globalThis, "fetch", () => {
    throw new Error("map integration tests must not request network data");
  });
  const api = await import(`../js/map.js?pulse-integration=${nextImport++}`);
  return {
    api,
    layers,
    renderOrder,
    activeComets: () => layers.filter(item =>
      !item.removed && item.options.className?.includes("focus-route-pulse-comet")
    ),
    activeTracks: () => layers.filter(item =>
      !item.removed && item.options.className?.includes("focus-route-pulse-track")
    ),
  };
}

function route(overrides = {}) {
  return {
    id: "route-a",
    colorIndex: 0,
    boardingStop: { stopId: "board", nameEn: "Boarding stop", lat: 22.301, lng: 114.101 },
    busLatLng: { lat: 22.3005, lng: 114.1005 },
    polyline: [{ lat: 22.3, lng: 114.1 }, { lat: 22.301, lng: 114.101 }],
    routePolyline: [{ lat: 22.3, lng: 114.1 }, { lat: 22.301, lng: 114.101 }],
    stops: [],
    activeSegment: {
      points: [[22.3, 114.1], [22.301, 114.101]],
      progress: 0.5,
      // Deliberately unlike the ~150 m geometry fallback, exposing lost data.
      remainingM: 500,
    },
    ...overrides,
  };
}

function pitch(comet) {
  const values = String(comet.element.style.strokeDasharray).split(/[ ,]+/).map(Number);
  assert.ok(values.length >= 4);
  return values[0] + values[1];
}

function markMetrics(comet) {
  const values = String(comet.element.style.strokeDasharray).split(/[ ,]+/).map(Number);
  return { length: values[0], visibleGap: values[1] - comet.options.weight };
}

function offset(comet) {
  return Number(comet.element.style.strokeDashoffset);
}

function approximately(actual, expected, message = "") {
  assert.ok(Math.abs(actual - expected) < 1e-6,
    `${message} expected ${expected}, received ${actual}`);
}

test("initial focus painting forwards remaining metres without advancing an extra frame", async t => {
  const h = await harness(t);
  await h.api.showFocusPanel({ routes: [route()], refit: false });
  const [comet] = h.activeComets();
  assert.ok(comet);
  approximately(pitch(comet), (PULSE_DASH_FAR_LENGTH_PX + PULSE_DASH_WIDTH_PX + PULSE_DASH_FAR_GAP_PX),
    "first paint must use the supplied 500 m, not the short geometry fallback");
  approximately(markMetrics(comet).length, PULSE_DASH_FAR_LENGTH_PX);
  approximately(markMetrics(comet).visibleGap, PULSE_DASH_FAR_GAP_PX);
  approximately(offset(comet), -(500 + PULSE_DASH_WIDTH_PX / 2),
    "overlay painting uses dtMs zero rather than inventing elapsed time");
  h.api.updateFocusOverlays({
    routes: [route({ activeSegment: { ...route().activeSegment, remainingM: 10 } })],
    refit: false,
  });
  assert.equal(h.activeComets()[0], comet);
  approximately(pitch(comet), (PULSE_DASH_NEAR_LENGTH_PX + PULSE_DASH_WIDTH_PX + PULSE_DASH_NEAR_GAP_PX));
  approximately(markMetrics(comet).length, PULSE_DASH_NEAR_LENGTH_PX,
    "the individual dash becomes shorter when supplied remaining metres shrink");
  approximately(markMetrics(comet).visibleGap, PULSE_DASH_NEAR_GAP_PX,
    "the clear gap tightens independently of the dash length");
});

test("a distance revision changes individual dash length and gap without restarting motion", async t => {
  const h = await harness(t);
  await h.api.showFocusPanel({ routes: [route()], refit: false });
  const [comet] = h.activeComets();
  h.api.updateActiveSegmentMotion("route-a", { progress: 0.5, remainingM: 500, dtMs: 160 });
  const oldPitch = pitch(comet);
  const phase = (-offset(comet) - 500 - comet.options.weight / 2) / oldPitch;
  const far = markMetrics(comet);
  h.api.updateFocusOverlays({
    routes: [route({ activeSegment: { ...route().activeSegment, remainingM: 10 } })],
    refit: false,
  });
  assert.equal(h.activeComets()[0], comet);
  const near = markMetrics(comet);
  assert.ok(near.length < far.length);
  assert.ok(near.visibleGap < far.visibleGap);
  approximately((-offset(comet) - 500 - comet.options.weight / 2) / pitch(comet), phase,
    "remaining-distance revisions preserve the existing spacing phase");
});

test("full ETA overlay repaints retain the pulse layer and its current phase", async t => {
  const h = await harness(t);
  await h.api.showFocusPanel({ routes: [route()], refit: false });
  const [comet] = h.activeComets();
  const [track] = h.activeTracks();
  h.api.updateActiveSegmentMotion("route-a", { progress: 0.5, remainingM: 500, dtMs: 160 });
  const before = offset(comet);
  for (let repaint = 0; repaint < 4; repaint++) {
    h.api.updateFocusOverlays({ routes: [structuredClone(route())], refit: false });
    assert.equal(h.activeComets()[0], comet, "an ETA repaint must not recreate the moving stream");
    assert.equal(h.activeTracks()[0], track);
    assert.equal(comet.removed, false);
    approximately(offset(comet), before, "a repaint does not rewind or advance phase");
  }
  h.api.updateActiveSegmentMotion("route-a", { progress: 0.5, remainingM: 500, dtMs: 16 });
  approximately(offset(comet), before - PULSE_DASH_SPEED_PX_PER_SEC * 16 / 1000,
    "the next real animation frame continues from the retained phase");
});

test("a changed physical leg resets phase during an overlay repaint", async t => {
  const h = await harness(t);
  await h.api.showFocusPanel({ routes: [route()], refit: false });
  const [comet] = h.activeComets();
  h.api.updateActiveSegmentMotion("route-a", { progress: 0.5, remainingM: 500, dtMs: 160 });
  const before = offset(comet);
  const nextPoints = [[22.301, 114.101], [22.302, 114.102]];
  h.api.updateFocusOverlays({
    routes: [route({ activeSegment: { points: nextPoints, progress: 0.5, remainingM: 500 } })],
    refit: false,
  });
  assert.equal(h.activeComets()[0], comet, "the existing SVG layer can be reused for the next leg");
  assert.deepEqual(comet.getLatLngs(), nextPoints);
  assert.notEqual(offset(comet), before);
  approximately(offset(comet), -(500 + PULSE_DASH_WIDTH_PX / 2));
});

test("an unavailable active segment clears its previous stream before repainting", async t => {
  const h = await harness(t);
  await h.api.showFocusPanel({ routes: [route()], refit: false });
  const [comet] = h.activeComets();
  const [track] = h.activeTracks();
  h.api.updateFocusOverlays({ routes: [route({ activeSegment: null, busLatLng: null })], refit: false });
  assert.equal(comet.removed, true);
  assert.equal(track.removed, true);
  assert.deepEqual(h.activeComets(), []);
  assert.deepEqual(h.activeTracks(), []);
  h.api.updateFocusOverlays({ routes: [route()], refit: false });
  assert.notEqual(h.activeComets()[0], comet, "a recovered estimate gets fresh presentation state");
});

test("removing one focused route clears only its stream and preserves the remaining route", async t => {
  const h = await harness(t);
  const routeB = route({ id: "route-b", colorIndex: 1 });
  await h.api.showFocusPanel({ routes: [route(), routeB], refit: false });
  const [cometA, cometB] = h.activeComets();
  h.api.updateActiveSegmentMotion("route-b", { progress: 0.5, remainingM: 500, dtMs: 160 });
  const before = offset(cometB);
  h.api.updateFocusOverlays({ routes: [routeB], refit: false });
  assert.equal(cometA.removed, true);
  assert.equal(cometB.removed, false);
  assert.deepEqual(h.activeComets(), [cometB]);
  approximately(offset(cometB), before, "changing multi-route styling does not reset motion");
});

test("retained pulse paths remain above every repainted base route line", async t => {
  const h = await harness(t);
  const routes = [route(), route({ id: "route-b", colorIndex: 1 })];
  await h.api.showFocusPanel({ routes, refit: false });
  const comets = h.activeComets();
  const tracks = h.activeTracks();
  h.api.updateFocusOverlays({ routes: structuredClone(routes), refit: false });
  assert.deepEqual(h.activeComets(), comets, "the raised paths retain their animation state");
  const svgPaths = h.renderOrder.filter(item => item.kind === "polyline");
  assert.deepEqual(svgPaths.slice(-4), [tracks[0], comets[0], tracks[1], comets[1]],
    "all base route lines are below the tracks and dashes, and each dash stream is above its track");
});

test("leaving focus clears every pulse and prevents later motion from restoring it", async t => {
  const h = await harness(t);
  await h.api.showFocusPanel({ routes: [route(), route({ id: "route-b", colorIndex: 1 })], refit: false });
  const before = [...h.activeComets(), ...h.activeTracks()];
  h.api.hideFocusPanel();
  assert.equal(h.api.isFocusPanelVisible(), false);
  assert.ok(before.every(item => item.removed));
  assert.deepEqual(h.activeComets(), []);
  assert.deepEqual(h.activeTracks(), []);
  h.api.updateActiveSegmentMotion("route-a", { progress: 0.5, remainingM: 500, dtMs: 160 });
  h.api.updateFocusOverlays({ routes: [route()], refit: false });
  assert.deepEqual(h.activeComets(), []);
});
