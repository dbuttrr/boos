import {
  PULSE_DASH_WIDTH_PX,
  PULSE_DASH_SPEED_PX_PER_SEC,
  PULSE_DASH_NEAR_LENGTH_PX,
  PULSE_DASH_FAR_LENGTH_PX,
  PULSE_DASH_NEAR_GAP_PX,
  PULSE_DASH_FAR_GAP_PX,
  PULSE_DASH_NEAR_DISTANCE_M,
  PULSE_DASH_FAR_DISTANCE_M,
  PULSE_FADE_OUT_MS,
  PULSE_MIN_REMAINING_PX,
  PULSE_ZOOM_REF,
  PULSE_ZOOM_SCALE_MAX,
  PULSE_ZOOM_SCALE_MIN,
} from "./config.js";
import { haversineMeters } from "./estimate.js";

const PULSE_LETTERS = ["a", "b", "c", "d", "e", "f"];

function pulseCssColor(varName, fallback) {
  const val = getComputedStyle(document.documentElement)
    .getPropertyValue(varName)
    .trim();
  return val || fallback;
}

function pulseZoomScale(map) {
  const zoom = map?.getZoom?.() ?? PULSE_ZOOM_REF;
  const raw = 2 ** (zoom - PULSE_ZOOM_REF);
  return Math.min(PULSE_ZOOM_SCALE_MAX, Math.max(PULSE_ZOOM_SCALE_MIN, raw));
}

function dashDimensions(remainingM, scale) {
  const distanceRange = PULSE_DASH_FAR_DISTANCE_M - PULSE_DASH_NEAR_DISTANCE_M;
  const far = Math.max(0, Math.min(1, (remainingM - PULSE_DASH_NEAR_DISTANCE_M) / distanceRange));
  const length = (PULSE_DASH_NEAR_LENGTH_PX + far * (PULSE_DASH_FAR_LENGTH_PX - PULSE_DASH_NEAR_LENGTH_PX)) * scale;
  const visibleGap = Math.max(1.5,
    (PULSE_DASH_NEAR_GAP_PX + far * (PULSE_DASH_FAR_GAP_PX - PULSE_DASH_NEAR_GAP_PX)) * scale);
  // SVG gaps are measured between geometric endpoints; both round caps take
  // up one stroke width, which must be added to preserve the visible gap.
  return { length, spacing: length + PULSE_DASH_WIDTH_PX + visibleGap };
}

function buildDashStream(pathLength, remaining, length, spacing, phase) {
  const phasePx = phase * spacing;
  // Include both round caps in the bounds. Only complete, equally sized
  // dashes wholly inside the remaining bus-to-stop section are drawn.
  const usable = remaining - PULSE_DASH_WIDTH_PX - length - phasePx;
  const count = usable < 0 ? 0 : Math.floor(usable / spacing) + 1;
  const parts = [];
  for (let i = 0; i < count; i++) parts.push(length, spacing - length);
  if (parts.length) {
    // An even finite pattern followed by a long gap prevents an earlier SVG
    // repetition from painting dashes behind the bus, including near the stop.
    parts[parts.length - 1] += pathLength + spacing + PULSE_DASH_WIDTH_PX;
  }
  return { dashArray: parts.join(" "), count, phasePx };
}

function legLengthMeters(points) {
  let length = 0;
  for (let i = 1; i < points.length; i++) {
    length += haversineMeters(
      { lat: points[i - 1][0], lng: points[i - 1][1] },
      { lat: points[i][0], lng: points[i][1] }
    );
  }
  return length;
}

function trackStyle(theme, colorIndex = 0, { dual = false } = {}) {
  const letter = PULSE_LETTERS[colorIndex % PULSE_LETTERS.length];
  return {
    color: pulseCssColor("--focus-pulse-fiber", "rgba(255, 255, 255, 0.28)"),
    weight: 6,
    opacity: dual ? 0.7 : 1,
    lineCap: "round",
    lineJoin: "round",
    className: `focus-route-pulse-track focus-route-pulse-track--${letter}`,
    noClip: true,
  };
}

function cometStyle(theme, colorIndex = 0, { dual = false } = {}) {
  const letter = PULSE_LETTERS[colorIndex % PULSE_LETTERS.length];
  return {
    color: pulseCssColor("--focus-pulse-spark", "rgba(255, 255, 255, 0.92)"),
    weight: PULSE_DASH_WIDTH_PX,
    opacity: dual ? 0.85 : 0.95,
    lineCap: "round",
    lineJoin: "round",
    className: `focus-route-pulse-comet focus-route-pulse-comet--${letter}`,
    noClip: true,
  };
}

function defaultState() {
  return {
    track: null,
    comet: null,
    pathLength: 0,
    dashArray: "",
    zoomKey: null,
    pathKey: null,
    dashPhase: 0,
    legLengthM: 0,
    remainingM: 0,
    progress: 0,
    geometryKey: null,
    colorIndex: 0,
    dual: false,
    theme: "light",
    visible: false,
    fadingOut: false,
    fadeTimer: null,
  };
}

function pathElements(state) {
  return [state.track, state.comet]
    .map((layer) => layer?.getElement?.())
    .filter(Boolean);
}

function wrapPhase(phase) {
  return ((phase % 1) + 1) % 1;
}

function pointsGeometryKey(points) {
  return points.map((p) => `${p[0]},${p[1]}`).join("|");
}

/**
 * Nerve pulse renderer: pearl track + uniform dashes on the remaining leg.
 * @param {import("leaflet").Map} map
 */
export function createPulseController(map) {
  /** @type {Map<string, ReturnType<typeof defaultState>>} */
  const routes = new Map();

  function getOrCreate(routeId) {
    if (!routes.has(routeId)) routes.set(routeId, defaultState());
    return routes.get(routeId);
  }

  function applyDash(pathEl, dashArray) {
    if (!pathEl) return;
    pathEl.style.animation = "none";
    pathEl.style.strokeDasharray = dashArray;
  }

  function finalizeGeometry(state) {
    const pathEl = state.comet?.getElement?.();
    if (!pathEl?.getTotalLength) return;

    const pathLength = pathEl.getTotalLength();
    if (!Number.isFinite(pathLength)) return;
    state.pathLength = Math.max(0, pathLength);
    state.pathKey = pathEl.getAttribute("d");
    // Comet styling clamps at high/low zooms, but path geometry keeps scaling.
    state.zoomKey = String(map.getZoom());
  }

  function setVisible(state, visible) {
    state.visible = visible;
    for (const el of pathElements(state)) {
      el.classList.toggle("focus-route-pulse-layer--visible", visible);
      el.classList.remove("focus-route-pulse-layer--exiting");
    }
  }

  function beginFadeIn(state) {
    if (state.visible) return;
    for (const el of pathElements(state)) {
      el.classList.remove("focus-route-pulse-layer--exiting");
    }
    setVisible(state, true);
  }

  return {
    setGeometry(
      routeId,
      { points, colorIndex = 0, dual = false, theme = "light" } = {}
    ) {
      if (!map || !points?.length || points.length < 2) return false;

      const L = window.L;
      const state = getOrCreate(routeId);
      const key = pointsGeometryKey(points);
      const geometryChanged = key !== state.geometryKey || !state.track;
      const styleChanged = state.colorIndex !== colorIndex || state.dual !== dual || state.theme !== theme;

      state.colorIndex = colorIndex;
      state.dual = dual;
      state.theme = theme;

      if (!geometryChanged && !styleChanged && !state.fadingOut) return false;

      state.geometryKey = key;
      state.fadingOut = false;
      if (geometryChanged) {
        state.pathLength = 0;
        state.dashArray = "";
        state.dashPhase = 0;
        state.legLengthM = legLengthMeters(points);
      }

      if (state.fadeTimer) {
        clearTimeout(state.fadeTimer);
        state.fadeTimer = null;
      }

      if (!state.track) {
        state.track = L.polyline(points, trackStyle(theme, colorIndex, { dual })).addTo(
          map
        );
        state.comet = L.polyline(points, cometStyle(theme, colorIndex, { dual })).addTo(
          map
        );
        beginFadeIn(state);
      } else {
        if (geometryChanged) state.track.setLatLngs(points);
        state.track.setStyle(trackStyle(theme, colorIndex, { dual }));
        if (geometryChanged) state.comet.setLatLngs(points);
        state.comet.setStyle(cometStyle(theme, colorIndex, { dual }));
        setVisible(state, true);
      }

      if (geometryChanged) {
        finalizeGeometry(state);
        requestAnimationFrame(() => finalizeGeometry(state));
      }
      return true;
    },

    setMotion(routeId, { progress = 0, dtMs = 16, remainingM } = {}) {
      const state = routes.get(routeId);
      if (!state?.comet || state.fadingOut) return;

      const cometEl = state.comet.getElement?.();
      const trackEl = state.track?.getElement?.();
      if (!cometEl) return;

      const zoomKey = String(map.getZoom());
      // Leaflet can update the SVG after its zoom value changes. Observe the
      // actual projected path too, so delayed reprojection cannot leave stale
      // pixel distances cached under the new zoom.
      const pathKey = cometEl.getAttribute("d");
      if (
        state.pathLength < 1 ||
        state.zoomKey !== zoomKey ||
        state.pathKey !== pathKey
      ) {
        finalizeGeometry(state);
      }
      const pathLength = state.pathLength;
      if (pathLength < 1) {
        cometEl.style.opacity = "0";
        return;
      }

      progress = Math.max(0, Math.min(1, Number.isFinite(progress) ? progress : 0));
      dtMs = Math.max(0, Number.isFinite(dtMs) ? dtMs : 0);
      state.progress = progress;
      state.remainingM = Number.isFinite(remainingM)
        ? Math.max(0, remainingM) : (1 - progress) * state.legLengthM;

      const reducedMotion = window.matchMedia(
        "(prefers-reduced-motion: reduce)"
      ).matches;

      const busPos = progress * pathLength;
      const remaining = Math.max(0, pathLength - busPos);
      const scale = pulseZoomScale(map);
      const { length, spacing } = dashDimensions(state.remainingM, scale);
      // Keep at least one complete dash visible throughout the spacing cycle;
      // a section that cannot fit one would otherwise blink at each wrap.
      const canPulse = remaining >= Math.max(PULSE_MIN_REMAINING_PX, length + PULSE_DASH_WIDTH_PX + spacing);
      if (reducedMotion) {
        state.dashPhase = 0;
      } else if (canPulse) {
        state.dashPhase = wrapPhase(state.dashPhase + PULSE_DASH_SPEED_PX_PER_SEC * scale * dtMs / (1_000 * spacing));
      }
      const { dashArray, count, phasePx } = buildDashStream(pathLength, remaining, length, spacing, state.dashPhase);
      if (dashArray && dashArray !== state.dashArray) {
        applyDash(cometEl, dashArray);
        state.dashArray = dashArray;
      }

      const cometBase = state.comet.options?.opacity ?? 0.95;
      const trackBase = state.track.options?.opacity ?? 1;

      if (trackEl) {
        trackEl.style.opacity = state.visible ? String(trackBase) : "0";
      }

      cometEl.style.strokeDashoffset = String(
        -(busPos + PULSE_DASH_WIDTH_PX / 2 + phasePx)
      );
      cometEl.style.opacity = String(
        canPulse && count > 0
          ? Math.max(0, Math.min(1, cometBase))
          : "0"
      );
    },

    syncTheme(routeId, { colorIndex, dual, theme } = {}) {
      const state = routes.get(routeId);
      if (!state?.track) return;

      state.colorIndex = colorIndex ?? state.colorIndex;
      state.dual = dual ?? state.dual;
      state.theme = theme ?? state.theme;

      state.track.setStyle(
        trackStyle(state.theme, state.colorIndex, { dual: state.dual })
      );
      state.comet.setStyle(
        cometStyle(state.theme, state.colorIndex, { dual: state.dual })
      );
      this.setMotion(routeId, { progress: state.progress, remainingM: state.remainingM, dtMs: 0 });
    },

    syncAllThemes(theme, dual) {
      for (const routeId of routes.keys()) {
        this.syncTheme(routeId, { dual, theme });
      }
    },

    bringToFront(routeId) {
      const state = routes.get(routeId);
      state?.track?.bringToFront?.();
      state?.comet?.bringToFront?.();
    },

    fadeOut(routeId) {
      const state = routes.get(routeId);
      if (!state?.track || state.fadingOut) return;

      state.fadingOut = true;
      state.visible = false;
      for (const el of pathElements(state)) {
        el.classList.remove("focus-route-pulse-layer--visible");
        el.classList.add("focus-route-pulse-layer--exiting");
      }

      if (state.fadeTimer) clearTimeout(state.fadeTimer);
      state.fadeTimer = setTimeout(() => {
        state.fadeTimer = null;
        this.clear(routeId);
      }, PULSE_FADE_OUT_MS);
    },

    clear(routeId) {
      const state = routes.get(routeId);
      if (!state) return;

      if (state.fadeTimer) {
        clearTimeout(state.fadeTimer);
        state.fadeTimer = null;
      }
      if (state.track) map.removeLayer(state.track);
      if (state.comet) map.removeLayer(state.comet);
      routes.delete(routeId);
    },

    clearAll() {
      for (const routeId of [...routes.keys()]) {
        this.clear(routeId);
      }
    },

    hasPulse(routeId) {
      return Boolean(routes.get(routeId)?.track);
    },

    getLatLngs(routeId) {
      const state = routes.get(routeId);
      if (!state?.track) return null;
      const latlngs = state.track.getLatLngs();
      return latlngs.length >= 2 ? latlngs : null;
    },
  };
}
