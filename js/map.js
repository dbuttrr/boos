import { BUS_MARKER_LERP } from "./config.js";

let map = null;
let tileLayer = null;
let youMarker = null;
/** @type {Map<string, { fullRouteLine: any, routeLine: any, stopMarker: any, stopDots: any[], busMarker: any, colorIndex: number }>} */
let routeLayers = new Map();
/** @type {Map<string, { lat: number, lng: number, targetLat: number, targetLng: number }>} */
let busChase = new Map();
let busChaseFrame = null;
let fitFrame = 0;
let leafletReady = null;
let themeObserver = null;
let currentTheme = null;

export const CARTO_ATTR =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> &copy; <a href="https://carto.com/attributions">CARTO</a>';

export const ROUTE_COLORS = [
  {
    light: "#0969da",
    dark: "#4a90d9",
    busClass: "focus-marker--bus-a",
    lineOpacity: { single: 0.65, dual: 0.4 },
    rowAlpha: {
      light: { border: 0.45, bg: 0.12, glow: 0.12 },
      dark: { border: 0.55, bg: 0.14, glow: 0.18 },
    },
  },
  {
    light: "#f5c400",
    dark: "#d4b84a",
    busClass: "focus-marker--bus-b",
    lineOpacity: { single: 0.75, dual: 0.65 },
    rowAlpha: {
      light: { border: 0.75, bg: 0.22, glow: 0.2 },
      dark: { border: 0.85, bg: 0.22, glow: 0.28 },
    },
  },
];

const panelEl = () => document.getElementById("focus-panel");
const mapEl = () => document.getElementById("focus-map");

function getAppTheme() {
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}

export function cartoUrl(theme) {
  const style = theme === "dark" ? "dark_all" : "light_all";
  return `https://{s}.basemaps.cartocdn.com/${style}/{z}/{x}/{y}{r}.png`;
}

function approachLineStyle(theme, colorIndex = 0, { dual = false } = {}) {
  const palette = ROUTE_COLORS[colorIndex] ?? ROUTE_COLORS[0];
  const lineOpacity = palette.lineOpacity ?? { single: 0.8, dual: 0.5 };
  return {
    color: theme === "dark" ? palette.dark : palette.light,
    weight: 3.5,
    opacity: dual ? lineOpacity.dual : lineOpacity.single,
    lineCap: "round",
    lineJoin: "round",
  };
}

function fullRouteLineStyle(theme) {
  return {
    color: theme === "dark" ? "#8b949e" : "#8c959f",
    weight: 3,
    opacity: 0.55,
    lineCap: "round",
    lineJoin: "round",
  };
}

export function loadLeaflet() {
  if (window.L) return Promise.resolve(window.L);
  if (leafletReady) return leafletReady;

  leafletReady = new Promise((resolve, reject) => {
    const css = document.createElement("link");
    css.rel = "stylesheet";
    css.href = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css";
    css.integrity =
      "sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY=";
    css.crossOrigin = "";
    document.head.appendChild(css);

    const script = document.createElement("script");
    script.src = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js";
    script.integrity =
      "sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo=";
    script.crossOrigin = "";
    script.onload = () => resolve(window.L);
    script.onerror = () => reject(new Error("Failed to load Leaflet"));
    document.head.appendChild(script);
  });

  return leafletReady;
}

/** Warm Leaflet assets without initializing a map. */
export function prefetchLeaflet() {
  return loadLeaflet().catch(() => null);
}

export function youIcon() {
  const L = window.L;
  return L.divIcon({
    className: "focus-marker focus-marker--you",
    html: `<span class="focus-marker__you"><span class="focus-marker__pulse"></span><span class="focus-marker__you-dot"></span></span>`,
    iconSize: [28, 28],
    iconAnchor: [14, 14],
  });
}

export function stopIcon({ selected = false } = {}) {
  const L = window.L;
  const modifier = selected ? " focus-marker--stop-selected" : "";
  return L.divIcon({
    className: `focus-marker focus-marker--stop${modifier}`,
    html: `<span class="focus-marker__stop" aria-hidden="true"><span class="focus-marker__stop-head"></span><span class="focus-marker__stop-stem"></span></span>`,
    iconSize: [22, 30],
    iconAnchor: [11, 28],
  });
}

export function stopDotIcon() {
  const L = window.L;
  return L.divIcon({
    className: "focus-marker focus-marker--stop-dot",
    html: `<span class="focus-marker__stop-dot" aria-hidden="true"></span>`,
    iconSize: [10, 10],
    iconAnchor: [5, 5],
  });
}

function busIcon(colorIndex = 0, { appearing = false } = {}) {
  const L = window.L;
  const palette = ROUTE_COLORS[colorIndex] ?? ROUTE_COLORS[0];
  const appearClass = appearing ? " focus-marker--appearing" : "";
  return L.divIcon({
    className: `focus-marker focus-marker--bus ${palette.busClass}${appearClass}`,
    html: `<span class="focus-marker__bus" aria-hidden="true"><span class="focus-marker__bus-body"></span></span>`,
    iconSize: [30, 30],
    iconAnchor: [15, 15],
  });
}

const BUS_DISSOLVE_MS = 620;
const SAND_CHIP_COUNT = 20;

function applyTileTheme(theme) {
  if (!map || !window.L) return;
  if (theme === currentTheme && tileLayer) return;

  currentTheme = theme;
  const next = window.L.tileLayer(cartoUrl(theme), {
    maxZoom: 20,
    attribution: CARTO_ATTR,
    subdomains: "abcd",
  });

  if (tileLayer) {
    map.removeLayer(tileLayer);
  }
  tileLayer = next.addTo(map);
  tileLayer.bringToBack();

  const dual = routeLayers.size >= 2;
  for (const layer of routeLayers.values()) {
    if (layer.fullRouteLine) {
      layer.fullRouteLine.setStyle(fullRouteLineStyle(theme));
    }
    if (layer.routeLine) {
      layer.routeLine.setStyle(
        approachLineStyle(theme, layer.colorIndex, { dual })
      );
    }
  }
}

export function setMapTheme(theme) {
  applyTileTheme(theme === "dark" ? "dark" : "light");
}

function watchTheme() {
  if (themeObserver) return;
  themeObserver = new MutationObserver(() => {
    applyTileTheme(getAppTheme());
  });
  themeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme"],
  });
}

async function ensureMap() {
  const L = await loadLeaflet();
  if (map) {
    applyTileTheme(getAppTheme());
    return map;
  }

  map = L.map(mapEl(), {
    zoomControl: false,
    attributionControl: true,
  });

  map.attributionControl.setPrefix(false);

  L.control
    .zoom({
      position: "bottomright",
    })
    .addTo(map);

  applyTileTheme(getAppTheme());
  watchTheme();
  return map;
}

function clearRouteLayer(layer) {
  if (!map || !layer) return;
  if (layer.fullRouteLine) map.removeLayer(layer.fullRouteLine);
  if (layer.routeLine) map.removeLayer(layer.routeLine);
  if (layer.stopMarker) map.removeLayer(layer.stopMarker);
  if (layer.busMarker) map.removeLayer(layer.busMarker);
  for (const marker of layer.stopDots ?? []) {
    map.removeLayer(marker);
  }
}

function stopBusChase() {
  if (busChaseFrame) {
    cancelAnimationFrame(busChaseFrame);
    busChaseFrame = null;
  }
  busChase.clear();
}

function ensureBusChaseLoop() {
  if (busChaseFrame) return;
  if (busChase.size === 0) return;

  const tick = () => {
    if (!map || busChase.size === 0) {
      busChaseFrame = null;
      return;
    }

    let anyMoving = false;
    for (const [routeId, chase] of busChase) {
      const layer = routeLayers.get(routeId);
      if (!layer?.busMarker) continue;

      const dLat = chase.targetLat - chase.lat;
      const dLng = chase.targetLng - chase.lng;
      if (Math.abs(dLat) > 1e-7 || Math.abs(dLng) > 1e-7) {
        chase.lat += dLat * BUS_MARKER_LERP;
        chase.lng += dLng * BUS_MARKER_LERP;
        layer.busMarker.setLatLng([chase.lat, chase.lng]);
        anyMoving = true;
      } else {
        chase.lat = chase.targetLat;
        chase.lng = chase.targetLng;
        layer.busMarker.setLatLng([chase.lat, chase.lng]);
      }
    }

    busChaseFrame = anyMoving ? requestAnimationFrame(tick) : null;
  };

  busChaseFrame = requestAnimationFrame(tick);
}

function setBusMarkerPosition(
  routeId,
  busLatLng,
  { smooth = false, dissolve = false, appear = false } = {}
) {
  if (!map || panelEl().hidden) return;
  const layer = routeLayers.get(routeId);
  if (!layer) return;
  const L = window.L;

  if (!busLatLng) {
    busChase.delete(routeId);
    if (layer.busMarker) {
      if (dissolve) {
        dissolveBusMarkerElement(layer, routeId);
      } else {
        map.removeLayer(layer.busMarker);
        layer.busMarker = null;
      }
    }
    if (busChase.size === 0) stopBusChase();
    return;
  }

  if (!layer.busMarker) {
    layer.busMarker = L.marker([busLatLng.lat, busLatLng.lng], {
      icon: busIcon(layer.colorIndex, { appearing: appear }),
      title: "Approx. bus location",
      zIndexOffset: 400,
    }).addTo(map);
    busChase.set(routeId, {
      lat: busLatLng.lat,
      lng: busLatLng.lng,
      targetLat: busLatLng.lat,
      targetLng: busLatLng.lng,
    });
    // Bus often appears after the first paint — frame you + stop + bus.
    scheduleFitToMarkers({ includeYou: routeLayers.size < 2 });
    return;
  }

  // Dissolve owns the marker until timeout removal — do not move it.
  const el = layer.busMarker.getElement?.() ?? layer.busMarker._icon;
  if (el?.classList?.contains("focus-marker--dissolving")) return;

  if (!smooth) {
    busChase.set(routeId, {
      lat: busLatLng.lat,
      lng: busLatLng.lng,
      targetLat: busLatLng.lat,
      targetLng: busLatLng.lng,
    });
    layer.busMarker.setLatLng([busLatLng.lat, busLatLng.lng]);
    return;
  }

  const chase = busChase.get(routeId);
  if (chase) {
    chase.targetLat = busLatLng.lat;
    chase.targetLng = busLatLng.lng;
  } else {
    const current = layer.busMarker.getLatLng();
    busChase.set(routeId, {
      lat: current.lat,
      lng: current.lng,
      targetLat: busLatLng.lat,
      targetLng: busLatLng.lng,
    });
  }
  ensureBusChaseLoop();
}

function dissolveBusMarkerElement(layer, routeId) {
  const marker = layer.busMarker;
  if (!marker || !map) return Promise.resolve();

  busChase.delete(routeId);

  const el = marker.getElement?.() ?? marker._icon;
  if (!el) {
    map.removeLayer(marker);
    if (layer.busMarker === marker) layer.busMarker = null;
    return Promise.resolve();
  }

  el.classList.add("focus-marker--dissolving");
  const bus = el.querySelector(".focus-marker__bus");
  if (bus && !bus.querySelector(".focus-marker__sand")) {
    const sand = document.createElement("span");
    sand.className = "focus-marker__sand";
    sand.setAttribute("aria-hidden", "true");
    for (let i = 0; i < SAND_CHIP_COUNT; i++) {
      const chip = document.createElement("span");
      chip.className = "focus-marker__sand-chip";
      chip.style.setProperty("--sand-i", String(i));
      sand.appendChild(chip);
    }
    bus.appendChild(sand);
  }

  return new Promise((resolve) => {
    window.setTimeout(() => {
      if (map && layer.busMarker === marker) {
        map.removeLayer(marker);
        layer.busMarker = null;
      }
      busChase.delete(routeId);
      resolve();
    }, BUS_DISSOLVE_MS);
  });
}

/** Dissolve then remove the bus marker for a route. */
export function dissolveBusMarker(routeId) {
  if (!map || panelEl().hidden) return Promise.resolve();
  const layer = routeLayers.get(routeId);
  if (!layer?.busMarker) return Promise.resolve();
  busChase.delete(routeId);
  return dissolveBusMarkerElement(layer, routeId);
}

function clearOverlays() {
  if (!map) return;
  stopBusChase();
  if (youMarker) {
    map.removeLayer(youMarker);
    youMarker = null;
  }
  for (const layer of routeLayers.values()) {
    clearRouteLayer(layer);
  }
  routeLayers.clear();
}

function fitVisible(points, { animate = true } = {}) {
  if (!map || !points.length) return;
  const L = window.L;
  map.invalidateSize({ animate: false });
  if (points.length === 1) {
    map.setView([points[0].lat, points[0].lng], 15, { animate });
    return;
  }
  const bounds = L.latLngBounds(points.map((p) => [p.lat, p.lng]));
  // Extra bottom pad clears zoom controls on the short 50dvh panel.
  map.fitBounds(bounds, {
    paddingTopLeft: [40, 40],
    paddingBottomRight: [40, 64],
    maxZoom: 16,
    animate,
  });
}

function collectMarkerPoints({ includeYou = true } = {}) {
  const points = [];
  for (const layer of routeLayers.values()) {
    if (layer.stopMarker) points.push(layer.stopMarker.getLatLng());
    if (layer.busMarker) points.push(layer.busMarker.getLatLng());
  }
  if (includeYou && youMarker) points.push(youMarker.getLatLng());
  return points;
}

/** Refit the map to current stop / bus / you markers. */
export function fitToMarkers({ includeYou = true, animate = true } = {}) {
  fitVisible(collectMarkerPoints({ includeYou }), { animate });
}

/** Fit after layout settles (panel open / marker paint). */
function scheduleFitToMarkers({ includeYou = true, animate = true } = {}) {
  if (fitFrame) cancelAnimationFrame(fitFrame);
  fitFrame = requestAnimationFrame(() => {
    fitFrame = requestAnimationFrame(() => {
      fitFrame = 0;
      if (!map || panelEl().hidden) return;
      fitVisible(collectMarkerPoints({ includeYou }), { animate });
    });
  });
}

function paintRoute(route, theme, { dual = false } = {}) {
  const L = window.L;
  const colorIndex = route.colorIndex ?? 0;
  const boardingStop = route.boardingStop;
  const boardingId = boardingStop?.stopId ?? boardingStop?.id;
  const polyline = route.polyline;
  const routePolyline = route.routePolyline;
  const stops = route.stops ?? [];
  const busLatLng = route.busLatLng;

  const layer = {
    fullRouteLine: null,
    routeLine: null,
    stopMarker: null,
    stopDots: [],
    busMarker: null,
    colorIndex,
  };

  const fullLine =
    routePolyline?.length > 1
      ? routePolyline
      : polyline?.length > 1
        ? polyline
        : null;

  if (fullLine) {
    layer.fullRouteLine = L.polyline(
      fullLine.map((p) => [p.lat, p.lng]),
      fullRouteLineStyle(theme)
    ).addTo(map);
  }

  if (polyline?.length > 1) {
    layer.routeLine = L.polyline(
      polyline.map((p) => [p.lat, p.lng]),
      approachLineStyle(theme, colorIndex, { dual })
    ).addTo(map);
  }

  for (const stop of stops) {
    if (stop.isBoarding || stop.stopId === boardingId) continue;
    const marker = L.marker([stop.lat, stop.lng], {
      icon: stopDotIcon(),
      title: stop.nameEn || "Stop",
      zIndexOffset: 100,
      interactive: false,
    }).addTo(map);
    layer.stopDots.push(marker);
  }

  if (boardingStop) {
    layer.stopMarker = L.marker([boardingStop.lat, boardingStop.lng], {
      icon: stopIcon(),
      title: boardingStop.nameEn || "Boarding stop",
      zIndexOffset: 200,
    }).addTo(map);
  }

  if (busLatLng) {
    layer.busMarker = L.marker([busLatLng.lat, busLatLng.lng], {
      icon: busIcon(colorIndex, { appearing: Boolean(route.busAppearing) }),
      title: "Approx. bus location",
      zIndexOffset: 400,
    }).addTo(map);
  }

  return layer;
}

/**
 * Paint one or two focused routes.
 * Dual-select (2 routes): hide you pin and fit to buses + boarding stops only.
 */
function paintFocusRoutes(routes, { youLatLng = null, refit = true } = {}) {
  if (!map) return;
  const L = window.L;
  const theme = getAppTheme();
  const dual = routes.length >= 2;

  clearOverlays();

  for (const route of routes) {
    if (!route?.id) continue;
    routeLayers.set(route.id, paintRoute(route, theme, { dual }));
  }

  if (!dual && youLatLng) {
    youMarker = L.marker([youLatLng.lat, youLatLng.lng], {
      icon: youIcon(),
      title: "You",
      zIndexOffset: 300,
    }).addTo(map);
  }

  if (refit) {
    scheduleFitToMarkers({ includeYou: !dual });
  }
}

export async function showFocusPanel({
  routes = [],
  youLatLng = null,
  refit = true,
} = {}) {
  const panel = panelEl();
  panel.hidden = false;
  document.body.classList.add("focus-active");

  await ensureMap();
  await new Promise((r) => requestAnimationFrame(() => r()));
  map.invalidateSize({ animate: false });

  paintFocusRoutes(routes, { youLatLng, refit });
}

/** Upgrade an open focus map without remounting Leaflet. */
export function updateFocusOverlays({
  routes = [],
  youLatLng = null,
  refit = true,
} = {}) {
  if (!map || panelEl().hidden) return;
  const dual = routes.length >= 2;
  paintFocusRoutes(routes, {
    youLatLng: dual ? null : youLatLng,
    refit,
  });
}

export function updateYouMarker(youLatLng, { refit = false } = {}) {
  if (!map || !youLatLng || panelEl().hidden) return;
  // Dual-select: never show the you pin
  if (routeLayers.size >= 2) {
    if (youMarker) {
      map.removeLayer(youMarker);
      youMarker = null;
    }
    return;
  }
  const L = window.L;
  const isNew = !youMarker;
  if (youMarker) {
    youMarker.setLatLng([youLatLng.lat, youLatLng.lng]);
  } else {
    youMarker = L.marker([youLatLng.lat, youLatLng.lng], {
      icon: youIcon(),
      title: "You",
      zIndexOffset: 300,
    }).addTo(map);
  }
  if (refit || isNew) {
    scheduleFitToMarkers({ includeYou: true });
  }
}

export function updateBusMarker(
  routeId,
  busLatLng,
  { smooth = false, dissolve = false, appear = false } = {}
) {
  setBusMarkerPosition(routeId, busLatLng, { smooth, dissolve, appear });
}

export function hideFocusPanel() {
  const panel = panelEl();
  panel.hidden = true;
  document.body.classList.remove("focus-active");
  if (fitFrame) {
    cancelAnimationFrame(fitFrame);
    fitFrame = 0;
  }
  clearOverlays();
}

export function isFocusPanelVisible() {
  return !panelEl().hidden;
}
