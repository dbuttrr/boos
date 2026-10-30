import test from "node:test";
import assert from "node:assert/strict";
import { createPulseController } from "../js/pulse.js";
import {
  PULSE_DASH_WIDTH_PX,
  PULSE_DASH_NEAR_LENGTH_PX,
  PULSE_DASH_FAR_LENGTH_PX,
  PULSE_DASH_NEAR_GAP_PX,
  PULSE_DASH_FAR_GAP_PX,
  PULSE_DASH_NEAR_DISTANCE_M,
  PULSE_DASH_FAR_DISTANCE_M,
  PULSE_DASH_SPEED_PX_PER_SEC,
} from "../js/config.js";

function installGlobal(t, name, value) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  t.after(() => {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete globalThis[name];
  });
}

function harness(t, { length = 1000, zoom = 15, reducedMotion = false } = {}) {
  const layers = [];
  const timers = new Map();
  const frames = new Map();
  let nextId = 1;
  let lengthReads = 0;
  const map = {
    getZoom: () => zoom,
    removeLayer(layer) { layer.removed = true; },
  };
  installGlobal(t, "document", { documentElement: {} });
  installGlobal(t, "getComputedStyle", () => ({ getPropertyValue: () => "" }));
  installGlobal(t, "requestAnimationFrame", callback => {
    const id = nextId++;
    frames.set(id, callback);
    return id;
  });
  installGlobal(t, "cancelAnimationFrame", id => frames.delete(id));
  t.mock.method(globalThis, "setTimeout", callback => {
    const id = nextId++;
    timers.set(id, callback);
    return id;
  });
  t.mock.method(globalThis, "clearTimeout", id => timers.delete(id));
  installGlobal(t, "window", {
    matchMedia: () => ({ matches: reducedMotion }),
    L: {
      polyline(points, options) {
        const classes = new Set();
        const writes = new Map();
        const style = new Proxy({}, {
          set(target, name, value) {
            target[name] = value;
            writes.set(name, (writes.get(name) ?? 0) + 1);
            return true;
          },
        });
        const element = {
          style,
          getTotalLength() { lengthReads++; return length; },
          getAttribute: name => name === "d" ? `M0,0L${length},0` : null,
          classList: {
            add: name => classes.add(name),
            remove: name => classes.delete(name),
            contains: name => classes.has(name),
            toggle(name, enabled) { enabled ? classes.add(name) : classes.delete(name); },
          },
        };
        const layer = {
          options: { ...options },
          element,
          writes,
          removed: false,
          addTo() { layers.push(this); return this; },
          getElement: () => element,
          getLatLngs: () => points,
          setLatLngs(next) { points = next; return this; },
          setStyle(next) { this.options = { ...this.options, ...next }; return this; },
        };
        return layer;
      },
    },
  });
  const controller = createPulseController(map);
  const points = [[22.3, 114.1], [22.301, 114.101]];
  controller.setGeometry("route", { points });
  return {
    controller,
    points,
    layers,
    get track() { return layers[0]; },
    get comet() { return layers[1]; },
    get lengthReads() { return lengthReads; },
    setLength(value) { length = value; },
    setZoom(value) { zoom = value; },
    setReducedMotion(value) { reducedMotion = value; },
    flushFrames() {
      const pending = [...frames.values()];
      frames.clear();
      for (const callback of pending) callback();
    },
    runTimers() {
      const pending = [...timers.values()];
      timers.clear();
      for (const callback of pending) callback();
    },
    pendingTimers: () => timers.size,
  };
}

function dashValues(layer) {
  return String(layer.element.style.strokeDasharray).trim().split(/[ ,]+/).map(Number);
}

// Interpret SVG's dash repetition independently of the controller: an odd list
// repeats twice, and a positive offset advances the pattern along the path.
// Include round caps when checking the actual visible bounds, independently of opacity.
function paintedIntervals(layer, pathLength, { caps = false } = {}) {
  let dash = dashValues(layer);
  assert.ok(dash.every(value => Number.isFinite(value) && value >= 0));
  if (dash.length % 2) dash = [...dash, ...dash];
  const cycle = dash.reduce((sum, value) => sum + value, 0);
  assert.ok(cycle > 0);
  const offset = Number(layer.element.style.strokeDashoffset || 0);
  const result = [];
  const firstCycle = Math.floor(offset / cycle) - 1;
  const lastCycle = Math.ceil((pathLength + offset) / cycle) + 1;
  for (let repeat = firstCycle; repeat <= lastCycle; repeat++) {
    let start = repeat * cycle - offset;
    for (let i = 0; i < dash.length; i++) {
      const end = start + dash[i];
      if (i % 2 === 0 && end > 0 && start < pathLength && end > start) {
        const radius = caps ? layer.options.weight / 2 : 0;
        result.push([Math.max(0, start) - radius, Math.min(pathLength, end) + radius]);
      }
      start = end;
    }
  }
  return result.sort((a, b) => a[0] - b[0]);
}

function bounds(intervals) {
  assert.ok(intervals.length > 0, "comet geometry must contain dashes");
  return { start: intervals[0][0], end: intervals.at(-1)[1] };
}

function approximately(actual, expected, message = "") {
  assert.ok(Math.abs(actual - expected) < 1e-6,
    `${message} expected ${expected}, received ${actual}`);
}

function pitch(layer) {
  const values = dashValues(layer);
  assert.ok(values.length >= 4, "the test stream contains at least two dashes");
  return values[0] + values[1];
}

function markMetrics(layer) {
  const values = dashValues(layer);
  assert.ok(values.length >= 4, "metrics require at least two visible marks");
  return {
    length: values[0],
    visibleLength: values[0] + layer.options.weight,
    visibleGap: values[1] - layer.options.weight,
    pitch: values[0] + values[1],
  };
}

function dashStarts(layer, length) {
  return paintedIntervals(layer, length).map(([start]) => start);
}

function normalizedPhase(layer, length, progress) {
  const first = dashStarts(layer, length)[0];
  return (first - progress * length - layer.options.weight / 2) / pitch(layer);
}

test("the stream has equal long dashes and equal gaps at a fixed distance", t => {
  const h = harness(t);
  h.controller.setMotion("route", { progress: 0.2, remainingM: 500, dtMs: 0 });
  const dash = dashValues(h.comet);
  assert.equal(dash.length % 2, 0, "an odd SVG pattern would duplicate its painted marks");
  assert.ok(dash.length > 12, "the whole remaining section contains more than a fixed six-dash packet");
  assert.equal(h.comet.options.lineCap, "round");
  assert.equal(h.comet.options.weight, PULSE_DASH_WIDTH_PX);
  const marks = dash.filter((_, i) => i % 2 === 0);
  const gaps = dash.filter((_, i) => i % 2 === 1).slice(0, -1);
  approximately(marks[0], PULSE_DASH_FAR_LENGTH_PX, "the individual far-away marks are long dashes");
  for (const value of marks) approximately(value, marks[0]);
  for (const value of gaps) approximately(value, gaps[0]);
  assert.ok(dash.at(-1) > 1000 + pitch(h.comet) + h.comet.options.weight,
    "the trailing separator prevents another repeated stream from painting behind the bus");
});

test("the dashed section is longer farther from the stop and shorter and denser nearby", t => {
  const h = harness(t);
  h.controller.setMotion("route", { progress: 0.1, remainingM: 500, dtMs: 0 });
  const far = bounds(paintedIntervals(h.comet, 1000, { caps: true }));
  const farPitch = pitch(h.comet);
  h.controller.setMotion("route", { progress: 0.85, remainingM: 20, dtMs: 0 });
  const near = bounds(paintedIntervals(h.comet, 1000, { caps: true }));
  const nearPitch = pitch(h.comet);
  assert.ok(far.end - far.start > 5 * (near.end - near.start));
  assert.ok(farPitch > nearPitch, "the near-stop dashes have tighter center spacing");
  approximately(farPitch, (PULSE_DASH_FAR_LENGTH_PX + PULSE_DASH_WIDTH_PX + PULSE_DASH_FAR_GAP_PX));
  approximately(nearPitch, (PULSE_DASH_NEAR_LENGTH_PX + PULSE_DASH_WIDTH_PX + PULSE_DASH_NEAR_GAP_PX));
  approximately(far.start, 100);
  approximately(near.start, 850);
  assert.ok(1000 - far.end < farPitch);
  assert.ok(1000 - near.end < nearPitch);
});

test("individual dashes shorten and their visible gaps tighten as remaining distance decreases", t => {
  const h = harness(t);
  let previous = null;
  for (const remainingM of [500, 300, 200, 160, 100, 20, 0]) {
    // Fix screen length and progress: this must change individual marks, not
    // merely shorten the total bus-to-stop window.
    h.controller.setMotion("route", { progress: 0.5, remainingM, dtMs: 0 });
    const metrics = markMetrics(h.comet);
    const values = dashValues(h.comet);
    for (let i = 0; i < values.length; i += 2) approximately(values[i], metrics.length);
    for (let i = 1; i < values.length - 1; i += 2) {
      approximately(values[i] - h.comet.options.weight, metrics.visibleGap);
    }
    if (previous) {
      assert.ok(metrics.length <= previous.length, "each geometric dash gets shorter");
      assert.ok(metrics.visibleLength <= previous.visibleLength, "round caps do not obscure the length change");
      assert.ok(metrics.visibleGap <= previous.visibleGap, "the actual clear gap gets tighter");
    }
    if (remainingM === 300) {
      approximately(metrics.length, PULSE_DASH_FAR_LENGTH_PX);
      approximately(metrics.visibleGap, PULSE_DASH_FAR_GAP_PX);
    }
    if (remainingM === 20) {
      approximately(metrics.length, PULSE_DASH_NEAR_LENGTH_PX);
      approximately(metrics.visibleGap, PULSE_DASH_NEAR_GAP_PX);
      assert.ok(PULSE_DASH_NEAR_LENGTH_PX < PULSE_DASH_FAR_LENGTH_PX);
      assert.ok(PULSE_DASH_NEAR_GAP_PX < PULSE_DASH_FAR_GAP_PX);
    }
    previous = metrics;
  }
});

test("dash length and clear gap interpolate independently without a threshold jump", t => {
  const h = harness(t);
  const metricsAt = remainingM => {
    h.controller.setMotion("route", { progress: 0.5, remainingM, dtMs: 0 });
    return markMetrics(h.comet);
  };
  const near = metricsAt(PULSE_DASH_NEAR_DISTANCE_M);
  const far = metricsAt(PULSE_DASH_FAR_DISTANCE_M);
  const middle = metricsAt((PULSE_DASH_NEAR_DISTANCE_M + PULSE_DASH_FAR_DISTANCE_M) / 2);
  approximately(middle.length, (near.length + far.length) / 2);
  approximately(middle.visibleGap, (near.visibleGap + far.visibleGap) / 2);
  for (const endpoint of [PULSE_DASH_NEAR_DISTANCE_M, PULSE_DASH_FAR_DISTANCE_M]) {
    const before = metricsAt(endpoint - 0.001);
    const after = metricsAt(endpoint + 0.001);
    assert.ok(Math.abs(before.length - after.length) < 0.001);
    assert.ok(Math.abs(before.visibleGap - after.visibleGap) < 0.001);
  }
  assert.deepEqual(metricsAt(-50), near);
  assert.deepEqual(metricsAt(1000), far);
});

test("zoom scales dash length and clear spacing while preserving their distance relationship", t => {
  const h = harness(t);
  for (const zoom of [1, 15, 20]) {
    h.setZoom(zoom);
    h.controller.setMotion("route", { progress: 0.5, remainingM: 500, dtMs: 0 });
    const far = markMetrics(h.comet);
    h.controller.setMotion("route", { progress: 0.5, remainingM: 10, dtMs: 0 });
    const near = markMetrics(h.comet);
    assert.ok(far.length > near.length, "the individual far dash remains longer at every zoom");
    assert.ok(far.visibleGap > near.visibleGap, "near dashes remain closer together at every zoom");
    assert.ok(near.visibleGap >= 1.5 - 1e-6, "round caps remain separated");
    if (zoom === 15) {
      approximately(far.length, PULSE_DASH_FAR_LENGTH_PX);
      approximately(near.length, PULSE_DASH_NEAR_LENGTH_PX);
    }
  }
});

test("density follows absolute remaining metres rather than leg progress or screen length", t => {
  const h = harness(t);
  h.controller.setMotion("route", { progress: 0.5, remainingM: 10, dtMs: 0 });
  const near = pitch(h.comet);
  h.controller.setMotion("route", { progress: 0.5, remainingM: 500, dtMs: 0 });
  const far = pitch(h.comet);
  assert.ok(far > near);
  approximately(near, (PULSE_DASH_NEAR_LENGTH_PX + PULSE_DASH_WIDTH_PX + PULSE_DASH_NEAR_GAP_PX));
  approximately(far, (PULSE_DASH_FAR_LENGTH_PX + PULSE_DASH_WIDTH_PX + PULSE_DASH_FAR_GAP_PX));
  h.setLength(2000);
  h.controller.setMotion("route", { progress: 0.5, remainingM: 500, dtMs: 0 });
  approximately(pitch(h.comet), far, "projected path length does not change the distance-driven density");
});

test("distance thresholds interpolate spacing continuously and clamp at either end", t => {
  const h = harness(t);
  h.controller.setMotion("route", { progress: 0.5, remainingM: 0, dtMs: 0 });
  const near = pitch(h.comet);
  h.controller.setMotion("route", {
    progress: 0.5,
    remainingM: (PULSE_DASH_NEAR_DISTANCE_M + PULSE_DASH_FAR_DISTANCE_M) / 2,
    dtMs: 0,
  });
  const middle = pitch(h.comet);
  h.controller.setMotion("route", { progress: 0.5, remainingM: 1000, dtMs: 0 });
  const far = pitch(h.comet);
  approximately(middle, (near + far) / 2);
  assert.ok(near < middle && middle < far);
});

test("callers without remaining metres use the geographic leg length as a fallback", t => {
  const h = harness(t);
  h.controller.setMotion("route", { progress: 0.1, dtMs: 0 });
  const farther = pitch(h.comet);
  h.controller.setMotion("route", { progress: 0.9, dtMs: 0 });
  const closer = pitch(h.comet);
  assert.ok(farther > closer, "the same geographic leg becomes denser as the bus approaches");
  approximately(closer, (PULSE_DASH_NEAR_LENGTH_PX + PULSE_DASH_WIDTH_PX + PULSE_DASH_NEAR_GAP_PX));
});

test("round caps stay within bus-to-stop bounds through distances, zooms, phases, and progress", t => {
  const h = harness(t);
  for (const zoom of [1, 15, 20]) {
    h.setZoom(zoom);
    for (const remainingM of [10, 160, 500]) {
      for (const progress of [0, 0.5, 0.9, 0.95, 0.98]) {
        for (let frame = 0; frame < 180; frame++) {
          h.controller.setMotion("route", { progress, remainingM, dtMs: 16 });
          // No mark may be drawn if the remaining window cannot fit a whole
          // dash including caps; hidden stale SVG patterns are not visible ink.
          if (Number(h.comet.element.style.opacity) === 0) continue;
          const intervals = paintedIntervals(h.comet, 1000, { caps: true });
          assert.ok(intervals.length > 0);
          const ink = bounds(intervals);
          assert.ok(ink.start >= progress * 1000 - 1e-6, "no stroke cap paints behind the bus");
          assert.ok(ink.end <= 1000 + 1e-6, "no stroke cap extends past the next stop");
          for (let i = 1; i < intervals.length; i++) {
            assert.ok(intervals[i][0] - intervals[i - 1][1] >= 1.5 - 1e-6,
              "nearby round dashes remain separate rather than merging into a line");
          }
        }
      }
    }
  }
});

test("dashes advance at the same screen speed for far and near spacing", t => {
  const h = harness(t);
  for (const remainingM of [10, 500]) {
    h.controller.setGeometry("route", { points: [[22.3, 114.1], [22.301 + remainingM / 100_000, 114.101]] });
    h.controller.setMotion("route", { progress: 0.5, remainingM, dtMs: 0 });
    let previous = dashStarts(h.comet, 1000)[0];
    for (let frame = 0; frame < 8; frame++) {
      h.controller.setMotion("route", { progress: 0.5, remainingM, dtMs: 16 });
      const current = dashStarts(h.comet, 1000)[0];
      approximately(current - previous, PULSE_DASH_SPEED_PX_PER_SEC * 16 / 1000);
      previous = current;
    }
  }
});

test("different frame partitions cover the same distance without an easing clock", t => {
  const h = harness(t);
  h.controller.setGeometry("other", { points: h.points });
  h.controller.setMotion("route", { progress: 0.5, remainingM: 500, dtMs: 240 });
  for (let frame = 0; frame < 15; frame++) {
    h.controller.setMotion("other", { progress: 0.5, remainingM: 500, dtMs: 16 });
  }
  approximately(Number(h.comet.element.style.strokeDashoffset),
    Number(h.layers[3].element.style.strokeDashoffset));
});

test("pitch wrapping preserves the continuing dashes and never fades the whole trail", t => {
  const h = harness(t);
  h.controller.setMotion("route", { progress: 0.5, remainingM: 10, dtMs: 0 });
  let before = dashStarts(h.comet, 1000);
  let wraps = 0;
  const distance = PULSE_DASH_SPEED_PX_PER_SEC * 16 / 1000;
  for (let frame = 0; frame < 120; frame++) {
    h.controller.setMotion("route", { progress: 0.5, remainingM: 10, dtMs: 16 });
    const after = dashStarts(h.comet, 1000);
    if (after[0] < before[0]) wraps++;
    for (const start of before) {
      const moved = start + distance;
      if (moved + dashValues(h.comet)[0] + h.comet.options.weight / 2 <= 1000) {
        assert.ok(after.some(next => Math.abs(next - moved) < 1e-6),
          "an existing dash keeps moving forward when a new dash enters beside the bus");
      }
    }
    approximately(Number(h.comet.element.style.opacity), h.comet.options.opacity);
    before = after;
  }
  assert.ok(wraps >= 5, "the test observes several seamless pitch wraps");
});

test("changing density preserves normalized phase instead of restarting the stream", t => {
  const h = harness(t);
  h.controller.setMotion("route", { progress: 0.5, remainingM: 500, dtMs: 160 });
  const before = normalizedPhase(h.comet, 1000, 0.5);
  assert.ok(before > 0 && before < 1);
  h.controller.setMotion("route", { progress: 0.5, remainingM: 20, dtMs: 0 });
  approximately(normalizedPhase(h.comet, 1000, 0.5), before);
});

test("very short remaining sections hide the dashes before their caps can collide", t => {
  const h = harness(t, { length: 40 });
  h.controller.setMotion("route", { progress: 0.5, remainingM: 10, dtMs: 0 });
  const ink = bounds(paintedIntervals(h.comet, 40, { caps: true }));
  approximately(ink.start, 20);
  assert.ok(ink.end <= 40);
  h.controller.setMotion("route", { progress: 0.7, remainingM: 5, dtMs: 16 });
  assert.equal(Number(h.comet.element.style.opacity), 0);
});

test("a long dash never blinks on and off as its phase crosses a nearly full screen window", t => {
  const h = harness(t);
  // At the reference zoom a 50px window cannot sustain a complete far dash
  // throughout one pitch, but a 60px window can. Near dashes fit either one.
  for (let frame = 0; frame < 180; frame++) {
    h.controller.setMotion("route", { progress: 0.95, remainingM: 500, dtMs: 16 });
    assert.equal(Number(h.comet.element.style.opacity), 0,
      "an undersized window hides the long-dash stream for the whole cycle");
  }
  for (const [progress, remainingM] of [[0.94, 500], [0.95, 10]]) {
    for (let frame = 0; frame < 180; frame++) {
      h.controller.setMotion("route", { progress, remainingM, dtMs: 16 });
      approximately(Number(h.comet.element.style.opacity), h.comet.options.opacity,
        "a readable complete-dash window remains visible throughout the cycle");
      const ink = bounds(paintedIntervals(h.comet, 1000, { caps: true }));
      assert.ok(ink.start >= progress * 1000 - 1e-6);
      assert.ok(ink.end <= 1000 + 1e-6);
    }
  }
});

test("minimum zoom keeps tight dashes visibly separate", t => {
  const h = harness(t, { zoom: 1 });
  h.controller.setMotion("route", { progress: 0.5, remainingM: 10, dtMs: 0 });
  const intervals = paintedIntervals(h.comet, 1000, { caps: true });
  assert.ok(intervals.length > 2);
  for (let i = 1; i < intervals.length; i++) {
    assert.ok(intervals[i][0] - intervals[i - 1][1] >= 1.5 - 1e-6);
  }
});

test("zoom changes update actual path length even beyond the visual scale clamp", t => {
  const h = harness(t, { zoom: 18 });
  h.controller.setMotion("route", { progress: 0.5, remainingM: 500, dtMs: 0 });
  h.setZoom(19);
  h.setLength(2000);
  h.controller.setMotion("route", { progress: 0.5, remainingM: 500, dtMs: 0 });
  const ink = bounds(paintedIntervals(h.comet, 2000, { caps: true }));
  approximately(ink.start, 1000, "new geometry is used in the same frame");
  assert.ok(ink.end <= 2000);
});

test("a delayed SVG projection updates path length after the zoom value has settled", t => {
  const h = harness(t, { zoom: 18, length: 1000 });
  h.controller.setMotion("route", { progress: 0.5, remainingM: 500, dtMs: 0 });
  h.setZoom(19);
  h.controller.setMotion("route", { progress: 0.5, remainingM: 500, dtMs: 0 });
  h.setLength(2000);
  h.controller.setMotion("route", { progress: 0.5, remainingM: 500, dtMs: 0 });
  const ink = bounds(paintedIntervals(h.comet, 2000, { caps: true }));
  approximately(ink.start, 1000, "SVG geometry invalidates the old length without another zoom change");
  assert.ok(ink.end <= 2000);
});

test("both pulse paths disable viewport clipping so panning cannot resize the stream", t => {
  const h = harness(t);
  assert.equal(h.track.options.noClip, true);
  assert.equal(h.comet.options.noClip, true);
});

test("identical geometry and style-only changes preserve phase and layers", t => {
  const h = harness(t);
  h.controller.setMotion("route", { progress: 0.5, remainingM: 500, dtMs: 80 });
  const before = h.comet.element.style.strokeDashoffset;
  assert.equal(h.controller.setGeometry("route", { points: h.points }), false);
  h.controller.setMotion("route", { progress: 0.5, remainingM: 500, dtMs: 0 });
  assert.equal(h.comet.element.style.strokeDashoffset, before);
  h.controller.setGeometry("route", { points: h.points, colorIndex: 2, dual: true, theme: "dark" });
  h.controller.setMotion("route", { progress: 0.5, remainingM: 500, dtMs: 0 });
  assert.equal(h.comet.element.style.strokeDashoffset, before, "recoloring does not restart motion");
  assert.equal(h.layers.length, 2);
});

test("a new physical leg begins at the bus without carrying the old leg's phase", t => {
  const h = harness(t);
  h.controller.setMotion("route", { progress: 0.5, remainingM: 500, dtMs: 100 });
  assert.equal(h.controller.setGeometry("route", {
    points: [[22.301, 114.101], [22.302, 114.102]],
  }), true);
  h.controller.setMotion("route", { progress: 0.5, remainingM: 500, dtMs: 0 });
  const ink = bounds(paintedIntervals(h.comet, 1000, { caps: true }));
  approximately(ink.start, 500);
});

test("reduced motion leaves the uniform stream stationary and visible", t => {
  const h = harness(t, { reducedMotion: true });
  h.controller.setMotion("route", { progress: 0.5, remainingM: 500, dtMs: 100 });
  const initialOffset = h.comet.element.style.strokeDashoffset;
  approximately(bounds(paintedIntervals(h.comet, 1000, { caps: true })).start, 500);
  for (let frame = 0; frame < 5; frame++) {
    h.controller.setMotion("route", { progress: 0.5, remainingM: 500, dtMs: 100 });
    assert.equal(h.comet.element.style.strokeDashoffset, initialOffset);
    approximately(Number(h.comet.element.style.opacity), h.comet.options.opacity);
  }
});

test("stable frames do not remeasure geometry or rewrite an unchanged dash count", t => {
  const h = harness(t, { length: 1010 });
  h.flushFrames();
  h.controller.setMotion("route", { progress: 0.5, remainingM: 500, dtMs: 0 });
  const before = h.comet.writes.get("strokeDasharray");
  const lengthReads = h.lengthReads;
  for (let frame = 0; frame < 5; frame++) {
    h.controller.setMotion("route", { progress: 0.5, remainingM: 500, dtMs: 16 });
  }
  assert.equal(h.comet.writes.get("strokeDasharray"), before);
  assert.equal(h.lengthReads, lengthReads);
});

test("fade completion removes both paths and reactivation cancels stale cleanup", t => {
  const h = harness(t);
  h.controller.setMotion("route", { progress: 0.5, remainingM: 500, dtMs: 16 });
  h.controller.fadeOut("route");
  assert.ok(h.comet.element.classList.contains("focus-route-pulse-layer--exiting"));
  assert.equal(h.pendingTimers(), 1);
  h.controller.setGeometry("route", { points: h.points });
  assert.equal(h.pendingTimers(), 0);
  assert.ok(h.controller.hasPulse("route"));
  assert.ok(!h.comet.element.classList.contains("focus-route-pulse-layer--exiting"));
  h.runTimers();
  assert.ok(h.controller.hasPulse("route"), "cancelled fade cannot remove a revived route");
  h.controller.fadeOut("route");
  h.runTimers();
  assert.equal(h.controller.hasPulse("route"), false);
  assert.ok(h.track.removed && h.comet.removed);
});
