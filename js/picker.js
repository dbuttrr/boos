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

function fitPickerBounds(stops, youLatLng) {
  if (!pickerMap || !stops.length) return;
  const L = window.L;
  const points = stops.map((s) => [s.lat, s.lng]);
  if (youLatLng) {
    points.push([youLatLng.lat, youLatLng.lng]);
  }
  if (points.length === 1) {
    pickerMap.setView(points[0], 15);
    return;
  }
  const bounds = L.latLngBounds(points);
  pickerMap.fitBounds(bounds, { padding: [48, 48], maxZoom: 16 });
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
    zoomControl: true,
    attributionControl: true,
  });
  pickerMap.attributionControl.setPrefix(false);
  L.control.zoom({ position: "bottomright" }).addTo(pickerMap);

  applyPickerTileTheme(getAppTheme());
  watchPickerTheme();
  return pickerMap;
}

/**
 * Show route stops on the picker map. Calls onSelect(stop) when user taps a stop.
 * @param {{ stops: object[], youLatLng?: object|null, onSelect?: Function, onPositionChange?: Function }} options
 */
export async function showPickerMap({
  stops = [],
  youLatLng = null,
  onSelect = null,
  onPositionChange = null,
} = {}) {
  onSelectCallback = onSelect;
  selectedStopId = null;

  if (unsubscribePosition) {
    unsubscribePosition();
    unsubscribePosition = null;
  }

  await ensurePickerMap();
  await new Promise((r) => requestAnimationFrame(() => r()));
  pickerMap.invalidateSize();

  clearPickerLayers();
  const L = window.L;
  const theme = getAppTheme();

  if (stops.length > 1) {
    routeLine = L.polyline(
      stops.map((s) => [s.lat, s.lng]),
      routeLineStyle(theme)
    ).addTo(pickerMap);
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
      }
    });
  }

  fitPickerBounds(stops, youLatLng);
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
  onSelectCallback = null;
  selectedStopId = null;
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
