import { BUS_MARKER_LERP, IDLE_FOLLOW_WINDOW, LOCATION } from "./config.js";

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
/** Route focus overlays are painted (vs idle GPS-follow). */
let focusActive = false;
/** Add-flow stop picking on the main map. */
let addPickActive = false;
/** Recenter GPS into the top-half active area while idle. */
let idleFollow = true;
const IDLE_ZOOM = 15;
const DEFAULT_CENTER = { lat: LOCATION.lat, lng: LOCATION.lng };

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
  {
    light: "#1a7f37",
    dark: "#3fb950",
    busClass: "focus-marker--bus-c",
    lineOpacity: { single: 0.7, dual: 0.5 },
    rowAlpha: {
      light: { border: 0.5, bg: 0.14, glow: 0.14 },
      dark: { border: 0.6, bg: 0.16, glow: 0.2 },
    },
  },
  {
    light: "#cf222e",
    dark: "#f85149",
    busClass: "focus-marker--bus-d",
    lineOpacity: { single: 0.7, dual: 0.5 },
    rowAlpha: {
      light: { border: 0.5, bg: 0.14, glow: 0.14 },
      dark: { border: 0.6, bg: 0.16, glow: 0.2 },
    },
  },
  {
    light: "#8250df",
    dark: "#a371f7",
    busClass: "focus-marker--bus-e",
    lineOpacity: { single: 0.7, dual: 0.5 },
    rowAlpha: {
      light: { border: 0.5, bg: 0.14, glow: 0.14 },
      dark: { border: 0.6, bg: 0.16, glow: 0.2 },
    },
  },
  {
    light: "#0891b2",
    dark: "#39c5e0",
    busClass: "focus-marker--bus-f",
    lineOpacity: { single: 0.7, dual: 0.5 },
    rowAlpha: {
      light: { border: 0.5, bg: 0.14, glow: 0.14 },
      dark: { border: 0.6, bg: 0.16, glow: 0.2 },
    },
  },
];

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
    iconSize: [36, 36],
    iconAnchor: [18, 18],
  });
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Split "Name, District" style stop titles onto two lines (text after the
 * first comma becomes the secondary line). No comma → single line.
 */
function formatStopLabelHtml(name) {
  const comma = name.indexOf(",");
  if (comma < 0) {
    return `<span class="focus-marker__stop-label-text">${escapeHtml(name)}</span>`;
  }
  const primary = name.slice(0, comma).trim();
  const secondary = name.slice(comma + 1).trim();
  if (!primary || !secondary) {
    return `<span class="focus-marker__stop-label-text">${escapeHtml(name)}</span>`;
  }
  return `<span class="focus-marker__stop-label-text">${escapeHtml(primary)}</span><span class="focus-marker__stop-label-sub">${escapeHtml(secondary)}</span>`;
}

/** Wide icon box so a glass name label can sit above the pin tip. */
const STOP_LABEL_ICON_W = 168;
const STOP_LABEL_ICON_H = 58;
const STOP_LABEL_ICON_H_TWO_LINE = 72;

/**
 * Boarding / picker stop pin.
 * Pass `label` in focus mode to show a glass name tooltip above the pin.
 */
export function stopIcon({
  selected = false,
  label = "",
  colorIndex = 0,
} = {}) {
  const L = window.L;
  const name = typeof label === "string" ? label.trim() : "";
  const hasLabel = Boolean(name);
  const twoLine =
    hasLabel &&
    name.includes(",") &&
    name.slice(0, name.indexOf(",")).trim() &&
    name.slice(name.indexOf(",") + 1).trim();
  const selectedMod = selected || hasLabel ? " focus-marker--stop-selected" : "";
  const labeledMod = hasLabel ? " focus-marker--stop-labeled" : "";
  const twoLineMod = twoLine ? " focus-marker--stop-labeled-2" : "";
  const palette = ROUTE_COLORS[colorIndex] ?? ROUTE_COLORS[0];
  const accent = getAppTheme() === "dark" ? palette.dark : palette.light;

  const labelHtml = hasLabel
    ? `<span class="focus-marker__stop-label">${formatStopLabelHtml(name)}</span>`
    : "";

  const width = hasLabel ? STOP_LABEL_ICON_W : 22;
  const height = hasLabel
    ? twoLine
      ? STOP_LABEL_ICON_H_TWO_LINE
      : STOP_LABEL_ICON_H
    : 30;

  return L.divIcon({
    className: `focus-marker focus-marker--stop${selectedMod}${labeledMod}${twoLineMod}`,
    html: `<span class="focus-marker__stop-wrap"${hasLabel || selected ? ` style="--stop-label-accent:${accent}"` : ""}>${labelHtml}<span class="focus-marker__stop" aria-hidden="true"><span class="focus-marker__stop-head"></span><span class="focus-marker__stop-stem"></span></span></span>`,
    iconSize: [width, height],
    iconAnchor: [width / 2, height - 2],
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
  if (addPickRouteLine) {
    addPickRouteLine.setStyle(addPickLineStyle(theme));
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

/** Padding so fitBounds frames content into the top-half active area. */
function activeAreaPadding() {
  const size = map.getSize();
  const bottomInset = Math.round(size.y * 0.5);
  return {
    // Extra top room for boarding-stop name labels above pins (incl. two-line).
    paddingTopLeft: [40, 84],
    paddingBottomRight: [40, bottomInset + 16],
  };
}

/**
 * Place a latlng at the center of the top half (not the full viewport center).
 * Computes a single target center so setView can animate smoothly (no snap + panBy).
 */
function centerInActiveArea(latlng, zoom = IDLE_ZOOM, { animate = true } = {}) {
  if (!map || !latlng) return;
  map.invalidateSize({ animate: false });
  const z = zoom ?? map.getZoom() ?? IDLE_ZOOM;
  const size = map.getSize();
  if (size.x === 0 || size.y === 0) {
    map.setView([latlng.lat, latlng.lng], z, { animate: false });
    return;
  }
  // setView centers on the container midpoint; offset south so latlng sits at y = size.y/4.
  const point = map.project([latlng.lat, latlng.lng], z);
  const target = map.unproject(point.add([0, size.y / 4]), z);
  map.setView(target, z, { animate });
}

/**
 * True while `latlng` is inside the soft follow window around the top-half center.
 * Used for Maps/Uber-style idle follow (marker moves; camera only when you leave).
 */
function isYouInFollowWindow(latlng) {
  if (!map || !latlng) return false;
  const size = map.getSize();
  if (size.x === 0 || size.y === 0) return false;
  const pt = map.latLngToContainerPoint([latlng.lat, latlng.lng]);
  const cx = size.x / 2;
  const cy = size.y / 4;
  const halfW = (size.x / 2) * IDLE_FOLLOW_WINDOW;
  const halfH = (size.y / 4) * IDLE_FOLLOW_WINDOW;
  return Math.abs(pt.x - cx) <= halfW && Math.abs(pt.y - cy) <= halfH;
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

  applyTileTheme(getAppTheme());
  watchTheme();
  map.setView([DEFAULT_CENTER.lat, DEFAULT_CENTER.lng], IDLE_ZOOM, {
    animate: false,
  });
  return map;
}

/**
 * Mount the full-bleed map and show the idle (top-half) view.
 * @param {{ center?: { lat: number, lng: number }, youLatLng?: { lat: number, lng: number } | null }} [opts]
 */
export async function initMapStage({
  center = DEFAULT_CENTER,
  youLatLng = null,
} = {}) {
  await ensureMap();
  await new Promise((r) => requestAnimationFrame(() => r()));
  map.invalidateSize({ animate: false });

  focusActive = false;
  idleFollow = true;
  document.body.classList.remove("focus-active");

  if (youLatLng) {
    ensureYouMarker(youLatLng);
    centerInActiveArea(youLatLng, IDLE_ZOOM, { animate: false });
  } else {
    centerInActiveArea(center, IDLE_ZOOM, { animate: false });
  }
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
  if (!map || !focusActive) return;
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
    scheduleFitToMarkers({ includeYou: true });
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
  if (!map || !focusActive) return Promise.resolve();
  const layer = routeLayers.get(routeId);
  if (!layer?.busMarker) return Promise.resolve();
  busChase.delete(routeId);
  return dissolveBusMarkerElement(layer, routeId);
}

function clearRouteOverlays() {
  if (!map) return;
  stopBusChase();
  for (const layer of routeLayers.values()) {
    clearRouteLayer(layer);
  }
  routeLayers.clear();
}

function ensureYouMarker(youLatLng) {
  if (!map || !youLatLng || !window.L) return;
  const L = window.L;
  if (youMarker) {
    youMarker.setLatLng([youLatLng.lat, youLatLng.lng]);
    return;
  }
  youMarker = L.marker([youLatLng.lat, youLatLng.lng], {
    icon: youIcon(),
    title: "You",
    zIndexOffset: 300,
  }).addTo(map);
}

function fitVisible(points, { animate = true } = {}) {
  if (!map || !points.length) return;
  const L = window.L;
  map.invalidateSize({ animate: false });
  if (points.length === 1) {
    centerInActiveArea(points[0], IDLE_ZOOM, { animate });
    return;
  }
  const bounds = L.latLngBounds(points.map((p) => [p.lat, p.lng]));
  const pad = activeAreaPadding();
  map.fitBounds(bounds, {
    ...pad,
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

/** Refit the map to current stop / bus / you markers (top-half active area). */
export function fitToMarkers({ includeYou = true, animate = true } = {}) {
  fitVisible(collectMarkerPoints({ includeYou }), { animate });
}

/** Fit after layout settles (focus paint / marker appear). */
function scheduleFitToMarkers({ includeYou = true, animate = true } = {}) {
  if (fitFrame) cancelAnimationFrame(fitFrame);
  fitFrame = requestAnimationFrame(() => {
    fitFrame = requestAnimationFrame(() => {
      fitFrame = 0;
      if (!map || !focusActive) return;
      fitVisible(collectMarkerPoints({ includeYou }), { animate });
    });
  });
}

/**
 * Idle GPS follow (Maps/Uber-style): always move the you marker; recenter into
 * the top-half active area only when you leave the soft follow window (or on
 * first fix / force). No-ops while a route is focused.
 */
export function followYouInActiveArea(
  youLatLng,
  { animate = true, showMarker = true, force = false } = {}
) {
  if (!map || !youLatLng || focusActive || addPickActive || !idleFollow) return;
  const isNew = !youMarker;
  if (showMarker) ensureYouMarker(youLatLng);
  if (force || isNew || !isYouInFollowWindow(youLatLng)) {
    centerInActiveArea(youLatLng, map.getZoom() || IDLE_ZOOM, { animate });
  }
}

function paintRoute(route, theme, { dual = false, showStopLabel = true } = {}) {
  const L = window.L;
  const colorIndex = route.colorIndex ?? 0;
  const boardingStop = route.boardingStop;
  const boardingId = boardingStop?.stopId ?? boardingStop?.id;
  const polyline = route.polyline;
  const routePolyline = route.routePolyline;
  const stops = route.stops ?? [];
  const busLatLng = route.busLatLng;
  const stopName =
    typeof boardingStop?.nameEn === "string" ? boardingStop.nameEn.trim() : "";

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
    const label = showStopLabel && stopName ? stopName : "";
    layer.stopMarker = L.marker([boardingStop.lat, boardingStop.lng], {
      icon: stopIcon({
        selected: true,
        label,
        colorIndex,
      }),
      title: stopName || "Boarding stop",
      zIndexOffset: label ? 280 : 200,
      interactive: false,
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
 * Paint one or more focused routes.
 * Always shows the you pin when youLatLng is provided; multi-select uses lower line opacity.
 * Shared boarding stops only get one name label (first focused route wins).
 */
function paintFocusRoutes(routes, { youLatLng = null, refit = true } = {}) {
  if (!map) return;
  const L = window.L;
  const theme = getAppTheme();
  const multi = routes.length >= 2;
  const labeledStopIds = new Set();

  clearRouteOverlays();
  if (youMarker) {
    map.removeLayer(youMarker);
    youMarker = null;
  }

  for (const route of routes) {
    if (!route?.id) continue;
    const stopId = route.boardingStop?.stopId ?? route.boardingStop?.id;
    const showStopLabel = Boolean(stopId) && !labeledStopIds.has(stopId);
    if (showStopLabel) labeledStopIds.add(stopId);
    routeLayers.set(
      route.id,
      paintRoute(route, theme, { dual: multi, showStopLabel })
    );
  }

  if (youLatLng) {
    youMarker = L.marker([youLatLng.lat, youLatLng.lng], {
      icon: youIcon(),
      title: "You",
      zIndexOffset: 300,
    }).addTo(map);
  }

  if (refit) {
    scheduleFitToMarkers({ includeYou: true });
  }
}

/** Enter route-focus mode on the always-on map (stops idle GPS follow). */
export async function showFocusPanel({
  routes = [],
  youLatLng = null,
  refit = true,
} = {}) {
  idleFollow = false;
  focusActive = true;
  document.body.classList.add("focus-active");

  await ensureMap();
  await new Promise((r) => requestAnimationFrame(() => r()));
  map.invalidateSize({ animate: false });

  paintFocusRoutes(routes, { youLatLng, refit });
}

/** Upgrade focus overlays without remounting Leaflet. */
export function updateFocusOverlays({
  routes = [],
  youLatLng = null,
  refit = true,
} = {}) {
  if (!map || !focusActive) return;
  paintFocusRoutes(routes, { youLatLng, refit });
}

export function updateYouMarker(youLatLng, { refit = false } = {}) {
  if (!map || !youLatLng || !focusActive) return;
  const isNew = !youMarker;
  ensureYouMarker(youLatLng);
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

/** Leave route focus; resume idle GPS follow (map stays visible). */
export function hideFocusPanel({ youLatLng = null } = {}) {
  focusActive = false;
  idleFollow = true;
  document.body.classList.remove("focus-active");
  if (fitFrame) {
    cancelAnimationFrame(fitFrame);
    fitFrame = 0;
  }
  clearRouteOverlays();
  if (youLatLng) {
    ensureYouMarker(youLatLng);
    centerInActiveArea(youLatLng, IDLE_ZOOM, { animate: true });
  } else if (youMarker) {
    map?.removeLayer(youMarker);
    youMarker = null;
  }
}

/** True while one or more routes are focused (not merely that the map exists). */
export function isFocusPanelVisible() {
  return focusActive;
}

export function isMapReady() {
  return Boolean(map);
}

let addPickRouteLine = null;
/** @type {Map<string, any>} */
let addPickStopMarkers = new Map();
let addPickOnSelect = null;
let addPickSelectedId = null;
let addPickFitFrame = 0;
let addPickUnsubscribePosition = null;
/** @type {object[]} */
let addPickStops = [];
/** @type {{ lat: number, lng: number }|null} */
let addPickYouLatLng = null;

function addPickLineStyle(theme) {
  return {
    color: theme === "dark" ? "#58a6ff" : "#0969da",
    weight: 3.5,
    opacity: 0.7,
    lineCap: "round",
    lineJoin: "round",
  };
}

function clearAddPickLayers() {
  if (!map) return;
  if (addPickRouteLine) {
    map.removeLayer(addPickRouteLine);
    addPickRouteLine = null;
  }
  for (const marker of addPickStopMarkers.values()) {
    map.removeLayer(marker);
  }
  addPickStopMarkers.clear();
  addPickSelectedId = null;
}

function updateAddPickMarkerIcons() {
  for (const [stopId, marker] of addPickStopMarkers) {
    const selected = stopId === addPickSelectedId;
    marker.setIcon(selected ? stopIcon({ selected: true }) : stopDotIcon());
    marker.setZIndexOffset(selected ? 250 : 100);
  }
}

function collectAddPickPoints({ includeYou = true } = {}) {
  const points = [];
  for (const marker of addPickStopMarkers.values()) {
    points.push(marker.getLatLng());
  }
  if (includeYou && youMarker) points.push(youMarker.getLatLng());
  return points;
}

function fitAddPickBounds({ animate = true } = {}) {
  const points = collectAddPickPoints({ includeYou: true });
  if (!points.length && addPickYouLatLng) {
    centerInActiveArea(addPickYouLatLng, IDLE_ZOOM, { animate });
    return;
  }
  fitVisible(points, { animate });
}

function scheduleFitAddPick({ animate = true } = {}) {
  if (addPickFitFrame) cancelAnimationFrame(addPickFitFrame);
  addPickFitFrame = requestAnimationFrame(() => {
    addPickFitFrame = requestAnimationFrame(() => {
      addPickFitFrame = 0;
      if (!map || !addPickActive) return;
      fitAddPickBounds({ animate });
    });
  });
}

function setAddPickRouteLineFromPath(path) {
  if (!map || !window.L) return;
  const L = window.L;
  const theme = getAppTheme();
  const points = (path ?? [])
    .filter((p) => p && Number.isFinite(p.lat) && Number.isFinite(p.lng))
    .map((p) => [p.lat, p.lng]);

  if (addPickRouteLine) {
    map.removeLayer(addPickRouteLine);
    addPickRouteLine = null;
  }

  if (points.length > 1) {
    addPickRouteLine = L.polyline(points, addPickLineStyle(theme)).addTo(map);
  }
}

/** True while the user is picking a boarding stop on the main map. */
export function isAddPickActive() {
  return addPickActive;
}

/**
 * Paint route stops on the main map for add-flow. Calls onSelect(stop) on tap.
 * @param {{ stops: object[], path?: object[], youLatLng?: object|null, onSelect?: Function, onPositionChange?: Function, isStale?: () => boolean }} options
 */
export async function enterAddPickMode({
  stops = [],
  path = null,
  youLatLng = null,
  onSelect = null,
  onPositionChange = null,
  isStale = () => false,
} = {}) {
  addPickOnSelect = onSelect;
  addPickSelectedId = null;
  addPickStops = stops;
  addPickYouLatLng = youLatLng;

  focusActive = false;
  idleFollow = false;
  addPickActive = true;
  document.body.classList.remove("focus-active");
  document.body.classList.add("add-pick-active");

  await ensureMap();
  if (isStale()) return;
  await new Promise((r) => requestAnimationFrame(() => r()));
  if (isStale()) return;
  map.invalidateSize({ animate: false });

  clearRouteOverlays();
  clearAddPickLayers();
  const L = window.L;

  const linePath =
    path?.length > 1 ? path : stops.length > 1 ? stops : null;
  if (linePath) {
    setAddPickRouteLineFromPath(linePath);
  }

  for (const stop of stops) {
    const marker = L.marker([stop.lat, stop.lng], {
      icon: stopDotIcon(),
      title: stop.nameEn || "Stop",
      zIndexOffset: 100,
      interactive: true,
    }).addTo(map);

    marker.on("click", () => {
      addPickSelectedId = stop.stopId;
      updateAddPickMarkerIcons();
      addPickOnSelect?.(stop);
    });

    addPickStopMarkers.set(stop.stopId, marker);
  }

  if (youLatLng) {
    ensureYouMarker(youLatLng);
  } else if (youMarker) {
    map.removeLayer(youMarker);
    youMarker = null;
  }

  if (onPositionChange) {
    if (addPickUnsubscribePosition) {
      addPickUnsubscribePosition();
      addPickUnsubscribePosition = null;
    }
    addPickUnsubscribePosition = onPositionChange((pos) => {
      if (!map || !addPickActive) return;
      if (pos) {
        const isNew = !youMarker;
        addPickYouLatLng = pos;
        ensureYouMarker(pos);
        if (isNew) {
          fitAddPickBounds({ animate: false });
          scheduleFitAddPick({ animate: true });
        }
      }
    });
  }

  fitAddPickBounds({ animate: false });
  scheduleFitAddPick({ animate: true });
}

/** Replace the add-pick route polyline (e.g. after OSRM road-snap). */
export function updateAddPickPath(path) {
  if (!map || !addPickActive) return;
  setAddPickRouteLineFromPath(path);
  fitAddPickBounds({ animate: false });
  scheduleFitAddPick({ animate: true });
}

export function setAddPickSelection(stopId) {
  addPickSelectedId = stopId;
  updateAddPickMarkerIcons();
}

/** Leave add-pick mode; resume idle GPS follow. */
export function exitAddPickMode({ youLatLng = null } = {}) {
  addPickActive = false;
  idleFollow = true;
  addPickOnSelect = null;
  addPickSelectedId = null;
  addPickStops = [];
  addPickYouLatLng = null;
  document.body.classList.remove("add-pick-active");

  if (addPickFitFrame) {
    cancelAnimationFrame(addPickFitFrame);
    addPickFitFrame = 0;
  }
  if (addPickUnsubscribePosition) {
    addPickUnsubscribePosition();
    addPickUnsubscribePosition = null;
  }

  clearAddPickLayers();

  if (youLatLng) {
    ensureYouMarker(youLatLng);
    centerInActiveArea(youLatLng, IDLE_ZOOM, { animate: true });
  } else if (youMarker) {
    map?.removeLayer(youMarker);
    youMarker = null;
  }
}
