import {
  loadLeaflet,
  cartoUrl,
  CARTO_ATTR,
  youIcon,
  stopIcon,
  stopDotIcon,
} from "./map.js";

let pickerMap = null;
let pickerTileLayer = null;
let pickerTheme = null;
let routeLine = null;
let youMarker = null;
/** @type {Map<string, any>} */
let stopMarkers = new Map();
let themeObserver = null;
let onSelectCallback = null;
let selectedStopId = null;
let unsubscribePosition = null;
let fitFrame = 0;
/** @type {object[]} */
let lastStops = [];
/** @type {{ lat: number, lng: number }|null} */
let lastYouLatLng = null;

const mapEl = () => document.getElementById("add-map");

function getAppTheme() {
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}

function routeLineStyle(theme) {
  return {
    color: theme === "dark" ? "#58a6ff" : "#0969da",
    weight: 3.5,
    opacity: 0.7,
    lineCap: "round",
    lineJoin: "round",
  };
}

function applyPickerTileTheme(theme) {
  if (!pickerMap || !window.L) return;
  if (theme === pickerTheme && pickerTileLayer) return;

  pickerTheme = theme;
  const next = window.L.tileLayer(cartoUrl(theme), {
    maxZoom: 20,
    attribution: CARTO_ATTR,
    subdomains: "abcd",
  });

  if (pickerTileLayer) {
    pickerMap.removeLayer(pickerTileLayer);
  }
  pickerTileLayer = next.addTo(pickerMap);
  pickerTileLayer.bringToBack();

  if (routeLine) {
    routeLine.setStyle(routeLineStyle(theme));
  }
}

function watchPickerTheme() {
  if (themeObserver) return;
  themeObserver = new MutationObserver(() => {
    applyPickerTileTheme(getAppTheme());
  });
  themeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme"],
  });
}

function fitPickerBounds({ animate = true } = {}) {
  if (!pickerMap) return;
  const L = window.L;
  pickerMap.invalidateSize({ animate: false });

  let bounds = null;
  if (routeLine) {
    bounds = routeLine.getBounds();
  } else if (lastStops.length) {
    bounds = L.latLngBounds(lastStops.map((s) => [s.lat, s.lng]));
  }

  if (lastYouLatLng) {
    if (bounds && bounds.isValid()) {
      bounds.extend([lastYouLatLng.lat, lastYouLatLng.lng]);
    } else {
      pickerMap.setView(
        [lastYouLatLng.lat, lastYouLatLng.lng],
        15,
        { animate }
      );
      return;
    }
  }

  if (!bounds || !bounds.isValid()) return;

  if (bounds.getNorthEast().equals(bounds.getSouthWest())) {
    pickerMap.setView(bounds.getCenter(), 15, { animate });
    return;
  }

  pickerMap.fitBounds(bounds, {
    paddingTopLeft: [48, 48],
    paddingBottomRight: [48, 64],
    maxZoom: 16,
    animate,
  });
}

/** Fit after layout settles; first fit uses animate:false so Leaflet has a view. */
function scheduleFitPicker({ animate = true } = {}) {
  if (fitFrame) cancelAnimationFrame(fitFrame);
  fitFrame = requestAnimationFrame(() => {
    fitFrame = requestAnimationFrame(() => {
      fitFrame = 0;
      if (!pickerMap) return;
      fitPickerBounds({ animate });
    });
  });
}

function setRouteLineFromPath(path) {
  if (!pickerMap || !window.L) return;
  const L = window.L;
  const theme = getAppTheme();
  const points = (path ?? [])
    .filter((p) => p && Number.isFinite(p.lat) && Number.isFinite(p.lng))
    .map((p) => [p.lat, p.lng]);

  if (routeLine) {
    pickerMap.removeLayer(routeLine);
    routeLine = null;
  }

  if (points.length > 1) {
    routeLine = L.polyline(points, routeLineStyle(theme)).addTo(pickerMap);
  }
}

function updateMarkerIcons() {
  for (const [stopId, marker] of stopMarkers) {
    const selected = stopId === selectedStopId;
    marker.setIcon(selected ? stopIcon({ selected: true }) : stopDotIcon());
    marker.setZIndexOffset(selected ? 250 : 100);
  }
}

function clearPickerLayers() {
  if (!pickerMap) return;
  if (routeLine) {
    pickerMap.removeLayer(routeLine);
    routeLine = null;
  }
  if (youMarker) {
    pickerMap.removeLayer(youMarker);
    youMarker = null;
  }
  for (const marker of stopMarkers.values()) {
    pickerMap.removeLayer(marker);
  }
  stopMarkers.clear();
  selectedStopId = null;
}

async function ensurePickerMap() {
  const L = await loadLeaflet();
  if (pickerMap) {
    applyPickerTileTheme(getAppTheme());
    return pickerMap;
  }

  pickerMap = L.map(mapEl(), {
    zoomControl: false,
    attributionControl: true,
  });
  pickerMap.attributionControl.setPrefix(false);
  L.control.zoom({ position: "bottomright" }).addTo(pickerMap);

  applyPickerTileTheme(getAppTheme());
  watchPickerTheme();
  return pickerMap;
}

/**
 * Replace the route polyline (e.g. after OSRM road-snap) and refit.
 * @param {{ lat: number, lng: number }[]} path
 */
export function setPickerPath(path) {
  if (!pickerMap) return;
  setRouteLineFromPath(path);
  fitPickerBounds({ animate: false });
  scheduleFitPicker({ animate: true });
}

/**
 * Show route stops on the picker map. Calls onSelect(stop) when user taps a stop.
 * @param {{ stops: object[], path?: object[], youLatLng?: object|null, onSelect?: Function, onPositionChange?: Function, isStale?: () => boolean }} options
 */
export async function showPickerMap({
  stops = [],
  path = null,
  youLatLng = null,
  onSelect = null,
  onPositionChange = null,
  isStale = () => false,
} = {}) {
  onSelectCallback = onSelect;
  selectedStopId = null;
  lastStops = stops;
  lastYouLatLng = youLatLng;

  if (unsubscribePosition) {
    unsubscribePosition();
    unsubscribePosition = null;
  }

  await ensurePickerMap();
  if (isStale()) return;
  await new Promise((r) => requestAnimationFrame(() => r()));
  if (isStale()) return;
  pickerMap.invalidateSize({ animate: false });

  clearPickerLayers();
  const L = window.L;

  const linePath =
    path?.length > 1 ? path : stops.length > 1 ? stops : null;
  if (linePath) {
    setRouteLineFromPath(linePath);
  }

  for (const stop of stops) {
    const marker = L.marker([stop.lat, stop.lng], {
      icon: stopDotIcon(),
      title: stop.nameEn || "Stop",
      zIndexOffset: 100,
      interactive: true,
    }).addTo(pickerMap);

    marker.on("click", () => {
      selectedStopId = stop.stopId;
      updateMarkerIcons();
      onSelectCallback?.(stop);
    });

    stopMarkers.set(stop.stopId, marker);
  }

  if (youLatLng) {
    youMarker = L.marker([youLatLng.lat, youLatLng.lng], {
      icon: youIcon(),
      title: "You",
      zIndexOffset: 300,
      interactive: false,
    }).addTo(pickerMap);
  }

  if (onPositionChange) {
    unsubscribePosition = onPositionChange((pos) => {
      if (!pickerMap) return;
      if (pos) {
        const isNew = !youMarker;
        lastYouLatLng = pos;
        if (youMarker) {
          youMarker.setLatLng([pos.lat, pos.lng]);
        } else {
          youMarker = L.marker([pos.lat, pos.lng], {
            icon: youIcon(),
            title: "You",
            zIndexOffset: 300,
            interactive: false,
          }).addTo(pickerMap);
        }
        if (isNew) {
          fitPickerBounds({ animate: false });
          scheduleFitPicker({ animate: true });
        }
      }
    });
  }

  // Immediate non-animated fit so the map has a view; then settle after layout.
  fitPickerBounds({ animate: false });
  scheduleFitPicker({ animate: true });
}

export function setPickerSelection(stopId) {
  selectedStopId = stopId;
  updateMarkerIcons();
}

export function destroyPickerMap() {
  if (unsubscribePosition) {
    unsubscribePosition();
    unsubscribePosition = null;
  }
  if (fitFrame) {
    cancelAnimationFrame(fitFrame);
    fitFrame = 0;
  }
  onSelectCallback = null;
  selectedStopId = null;
  lastStops = [];
  lastYouLatLng = null;
  clearPickerLayers();

  if (pickerMap) {
    pickerMap.remove();
    pickerMap = null;
    pickerTileLayer = null;
    pickerTheme = null;
  }
}

export function isPickerMapActive() {
  return pickerMap !== null;
}
