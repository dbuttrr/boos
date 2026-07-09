import { initTheme } from "./theme.js";
import {
  WATCHLIST,
  REFRESH_INTERVAL_MS,
  MAX_WALK_MINUTES,
  WALK_SPEED_M_PER_MIN,
} from "./config.js";
import {
  fetchEta,
  fetchStop,
  formatArrivalDisplay,
  formatTime,
  prefetchRouteGeometry,
} from "./api.js";
import { estimateBusPosition, pointAtCumDist, haversineMeters } from "./estimate.js";
import {
  startGeolocation,
  getLastPosition,
  onPositionChange,
} from "./geo.js";
import {
  ROUTE_COLORS,
  showFocusPanel,
  hideFocusPanel,
  updateYouMarker,
  updateBusMarker,
  updateFocusOverlays,
  isFocusPanelVisible,
  prefetchLeaflet,
} from "./map.js";
import { roadSnapStopsChunked } from "./routing.js";

const cardsEl = document.getElementById("cards");
const lastRefreshEl = document.getElementById("last-refresh");
const WATCHLIST_INDEX = new Map(WATCHLIST.map((entry, i) => [entry.id, i]));
const SORT_DEBOUNCE_MS = 2_000;

let refreshTimer = null;
let isRefreshing = false;
let focusedIds = [];
let focusToken = 0;
let lastEtaById = new Map();
let animFrame = null;
let animStartedAt = 0;
let didPrefetch = false;
let stopCoordsById = new Map();
let sortTimer = null;
let lastSortedOrderKey = "";
/** @type {Map<string, object>} */
let focusEstimates = new Map();

function routeText(entry) {
  return entry.label.split(" · ")[0];
}

function createRowElement(entry) {
  const row = document.createElement("article");
  row.className = "row";
  row.dataset.id = entry.id;
  row.setAttribute("role", "button");
  row.tabIndex = 0;
  row.innerHTML = `
    <div class="row__route"></div>
    <div class="row__times">
      <span class="row__eta"></span>
      <span class="row__next"></span>
    </div>
  `;
  row.querySelector(".row__route").textContent = routeText(entry);
  return row;
}

function applyEtaStyle(el, variant) {
  el.className = "row__eta";
  if (variant === "remark") {
    el.classList.add("row__eta--remark");
  } else if (variant === "none") {
    el.classList.add("row__eta--none");
  }
}

function renderRow(row, result) {
  const etaEl = row.querySelector(".row__eta");
  const nextEl = row.querySelector(".row__next");
  const existingError = row.querySelector(".row__error");
  existingError?.remove();

  row.classList.remove("row--loading");

  if (result.error) {
    etaEl.textContent = "—";
    etaEl.className = "row__eta row__eta--none";
    nextEl.textContent = "";
    nextEl.hidden = true;
    const err = document.createElement("p");
    err.className = "row__error";
    err.textContent = result.error;
    row.appendChild(err);
    return;
  }

  const first = formatArrivalDisplay(result.first);
  etaEl.textContent = first.text;
  applyEtaStyle(etaEl, first.variant);

  const second = formatArrivalDisplay(result.second);
  if (second.variant === "none" && second.text === "—") {
    nextEl.textContent = "";
    nextEl.hidden = true;
  } else {
    nextEl.textContent = second.text;
    nextEl.hidden = false;
    nextEl.className =
      second.variant === "remark" ? "row__next row__next--remark" : "row__next";
  }
}

function ensureRows() {
  if (cardsEl.children.length > 0) return;
  const list = document.createElement("div");
  list.className = "route-list";
  for (const entry of WATCHLIST) {
    list.appendChild(createRowElement(entry));
  }
  cardsEl.appendChild(list);
}

function rowsContainer() {
  return cardsEl.querySelector(".route-list") ?? cardsEl;
}

async function loadStopCoords() {
  const uniqueIds = [...new Set(WATCHLIST.map((e) => e.stopId))];
  await Promise.all(
    uniqueIds.map(async (stopId) => {
      if (stopCoordsById.has(stopId)) return;
      try {
        const stop = await fetchStop(stopId);
        stopCoordsById.set(stopId, { lat: stop.lat, lng: stop.lng });
      } catch {
        // leave missing; those entries keep config order
      }
    })
  );
}

function orderedWatchlist(pos) {
  if (!pos || stopCoordsById.size === 0) return WATCHLIST;

  return [...WATCHLIST].sort((a, b) => {
    const stopA = stopCoordsById.get(a.stopId);
    const stopB = stopCoordsById.get(b.stopId);
    const distA = stopA ? haversineMeters(pos, stopA) : Number.POSITIVE_INFINITY;
    const distB = stopB ? haversineMeters(pos, stopB) : Number.POSITIVE_INFINITY;
    if (distA !== distB) return distA - distB;
    return (WATCHLIST_INDEX.get(a.id) ?? 0) - (WATCHLIST_INDEX.get(b.id) ?? 0);
  });
}

function maxWalkableMeters() {
  return MAX_WALK_MINUTES * WALK_SPEED_M_PER_MIN;
}

/** True when crow-flies distance already exceeds a 20-min walk. */
function isDefinitelyNotWalkable(pos, stop) {
  if (!pos || !stop) return false;
  return haversineMeters(pos, stop) > maxWalkableMeters();
}

function applyWalkability(pos) {
  const list = rowsContainer();
  for (const entry of WATCHLIST) {
    const row = list.querySelector(`[data-id="${entry.id}"]`);
    if (!row) continue;
    const stop = stopCoordsById.get(entry.stopId);
    row.classList.toggle("row--far", isDefinitelyNotWalkable(pos, stop));
  }
}

function applyListOrder(pos) {
  const ordered = orderedWatchlist(pos);
  const orderKey = ordered.map((e) => e.id).join(",");
  if (orderKey === lastSortedOrderKey) return;
  lastSortedOrderKey = orderKey;

  const list = rowsContainer();
  for (const entry of ordered) {
    const row = list.querySelector(`[data-id="${entry.id}"]`);
    if (row) list.appendChild(row);
  }
}

function scheduleListReorder(pos) {
  if (!pos) return;
  if (sortTimer) clearTimeout(sortTimer);
  sortTimer = setTimeout(() => {
    sortTimer = null;
    applyListOrder(pos);
  }, SORT_DEBOUNCE_MS);
}

async function initNearestOrder() {
  await loadStopCoords();
  const pos = (await startGeolocation()) ?? getLastPosition();
  if (pos) {
    applyListOrder(pos);
    applyWalkability(pos);
  }
}

function hexToRgba(hex, alpha) {
  const h = hex.replace("#", "");
  const n = parseInt(h.length === 3 ? h.replace(/(.)/g, "$1$1") : h, 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function clearRowFocusStyles(row) {
  row.classList.remove("row--focused");
  row.style.removeProperty("--row-focus-border");
  row.style.removeProperty("--row-focus-bg");
  row.style.removeProperty("--row-focus-glow");
}

function setFocusedRows(ids) {
  cardsEl.querySelectorAll(".row--focused").forEach(clearRowFocusStyles);

  const theme =
    document.documentElement.dataset.theme === "dark" ? "dark" : "light";
  const dark = theme === "dark";
  ids.forEach((id, colorIndex) => {
    const row = cardsEl.querySelector(`[data-id="${id}"]`);
    if (!row) return;
    const palette = ROUTE_COLORS[colorIndex] ?? ROUTE_COLORS[0];
    const hex = theme === "dark" ? palette.dark : palette.light;
    const alpha = palette.rowAlpha?.[theme] ?? {
      border: dark ? 0.55 : 0.45,
      bg: dark ? 0.14 : 0.12,
      glow: dark ? 0.18 : 0.12,
    };
    row.classList.add("row--focused");
    row.style.setProperty("--row-focus-border", hexToRgba(hex, alpha.border));
    row.style.setProperty("--row-focus-bg", hexToRgba(hex, alpha.bg));
    row.style.setProperty(
      "--row-focus-glow",
      `0 8px ${dark ? 28 : 24}px ${hexToRgba(hex, alpha.glow)}`
    );
  });
}

function selectionKey(ids = focusedIds) {
  return ids.join("|");
}

function stopBusAnimation() {
  if (animFrame) {
    cancelAnimationFrame(animFrame);
    animFrame = null;
  }
}

function startBusAnimations(estimatesById, token = focusToken) {
  stopBusAnimation();

  const tracks = [];
  for (const [id, estimate] of estimatesById) {
    if (
      !estimate?.polyline?.length ||
      estimate.busCumDist == null ||
      !estimate.speedMPerMin ||
      estimate.reason !== "ok"
    ) {
      continue;
    }

    const polyline = estimate.polyline;
    const boardingCum =
      estimate.boardingCumDist ??
      estimate.boardingStop?.cumDist ??
      polyline[polyline.length - 1].cumDist;
    const startCum = estimate.busCumDist;
    const speedMPerMin = estimate.speedMPerMin;
    const minutes = estimate.minutesToBoard;
    if (!minutes || minutes <= 0 || startCum >= boardingCum) continue;

    const maxAdvanceM = Math.min(
      speedMPerMin * (REFRESH_INTERVAL_MS / 60_000),
      boardingCum - startCum
    );
    if (maxAdvanceM <= 0) continue;

    tracks.push({
      id,
      polyline,
      startCum,
      speedMPerMin,
      maxAdvanceM,
    });
  }

  if (!tracks.length) return;

  animStartedAt = performance.now();

  const tick = (now) => {
    if (
      token !== focusToken ||
      !isFocusPanelVisible() ||
      focusedIds.length === 0
    ) {
      return;
    }
    const elapsedMin = (now - animStartedAt) / 60_000;
    let anyActive = false;
    for (const track of tracks) {
      if (!focusedIds.includes(track.id)) continue;
      const advance = Math.min(track.maxAdvanceM, track.speedMPerMin * elapsedMin);
      const cum = track.startCum + advance;
      const point = pointAtCumDist(track.polyline, cum);
      if (point) {
        updateBusMarker(track.id, { lat: point.lat, lng: point.lng });
      }
      if (advance < track.maxAdvanceM) anyActive = true;
    }
    if (anyActive) {
      animFrame = requestAnimationFrame(tick);
    }
  };

  animFrame = requestAnimationFrame(tick);
}

async function loadEstimateForEntry(entry) {
  let boardingStop = null;
  try {
    const stop = await fetchStop(entry.stopId);
    boardingStop = {
      stopId: stop.id,
      lat: stop.lat,
      lng: stop.lng,
      nameEn: stop.nameEn,
    };
  } catch {
    // continue without pin
  }

  const cached = lastEtaById.get(entry.id);
  const etaPromise = cached?.first?.eta
    ? Promise.resolve(cached)
    : fetchEta(entry.route, entry.stopId, entry.direction);

  try {
    const eta = await etaPromise;
    const estimate = await estimateBusPosition(entry, eta);
    return {
      ...estimate,
      boardingStop: estimate.boardingStop ?? boardingStop,
    };
  } catch (err) {
    console.warn("Focus estimate failed:", err);
    return {
      polyline: [],
      routePolyline: [],
      boardingStop,
      busLatLng: null,
      stops: [],
      reason: "error",
    };
  }
}

function routesFromEstimates(ids, estimatesById) {
  return ids.map((id, colorIndex) => {
    const estimate = estimatesById.get(id);
    return {
      id,
      colorIndex,
      boardingStop: estimate?.boardingStop ?? null,
      busLatLng: estimate?.busLatLng ?? null,
      polyline: estimate?.polyline ?? [],
      routePolyline: estimate?.routePolyline ?? [],
      stops: estimate?.stops ?? [],
    };
  });
}

async function syncFocusMap({ refit = true } = {}) {
  const token = ++focusToken;
  const ids = [...focusedIds];
  const key = selectionKey(ids);
  setFocusedRows(ids);
  stopBusAnimation();
  focusEstimates.clear();

  if (ids.length === 0) {
    hideFocusPanel();
    return;
  }

  const dual = ids.length >= 2;
  const youLatLng = dual ? null : getLastPosition();

  // Progressive paint: open map ASAP with boarding stops only
  const quickRoutes = await Promise.all(
    ids.map(async (id, colorIndex) => {
      const entry = WATCHLIST.find((e) => e.id === id);
      let boardingStop = null;
      if (entry) {
        try {
          const stop = await fetchStop(entry.stopId);
          boardingStop = {
            stopId: stop.id,
            lat: stop.lat,
            lng: stop.lng,
            nameEn: stop.nameEn,
          };
        } catch {
          // continue
        }
      }
      return {
        id,
        colorIndex,
        boardingStop,
        busLatLng: null,
        polyline: [],
        routePolyline: [],
        stops: [],
      };
    })
  );

  if (token !== focusToken || selectionKey() !== key) return;

  if (!isFocusPanelVisible()) {
    await showFocusPanel({
      routes: quickRoutes,
      youLatLng,
      refit,
    });
  } else {
    updateFocusOverlays({
      routes: quickRoutes,
      youLatLng,
      refit,
    });
  }

  if (!dual) {
    startGeolocation().then((you) => {
      if (token !== focusToken || selectionKey() !== key) return;
      if (focusedIds.length !== 1) return;
      const pos = you ?? getLastPosition();
      if (pos) updateYouMarker(pos, { refit: true });
    });
  }

  const estimates = await Promise.all(
    ids.map(async (id) => {
      const entry = WATCHLIST.find((e) => e.id === id);
      if (!entry) return [id, null];
      const estimate = await loadEstimateForEntry(entry);
      return [id, estimate];
    })
  );

  if (token !== focusToken || selectionKey() !== key) return;

  const estimatesById = new Map(estimates.filter(([, e]) => e));
  focusEstimates = estimatesById;

  updateFocusOverlays({
    routes: routesFromEstimates(ids, estimatesById),
    youLatLng: dual ? null : getLastPosition(),
    refit,
  });

  startBusAnimations(estimatesById, token);
}

function exitFocus() {
  focusToken += 1;
  focusedIds = [];
  focusEstimates.clear();
  stopBusAnimation();
  setFocusedRows([]);
  hideFocusPanel();
}

async function toggleFocus(entryId) {
  const entry = WATCHLIST.find((e) => e.id === entryId);
  if (!entry) return;

  const idx = focusedIds.indexOf(entryId);
  if (idx >= 0) {
    focusedIds = focusedIds.filter((id) => id !== entryId);
    if (focusedIds.length === 0) {
      exitFocus();
      return;
    }
    await syncFocusMap({ refit: true });
    return;
  }

  if (focusedIds.length >= 2) {
    exitFocus();
    return;
  }

  focusedIds = [...focusedIds, entryId];
  await syncFocusMap({ refit: true });
}

async function refreshFocusedEstimate() {
  if (focusedIds.length === 0) return;

  const token = focusToken;
  const ids = [...focusedIds];
  const key = selectionKey(ids);
  const dual = ids.length >= 2;

  try {
    const estimates = await Promise.all(
      ids.map(async (id) => {
        const entry = WATCHLIST.find((e) => e.id === id);
        const eta = lastEtaById.get(id);
        if (!entry || !eta) return [id, focusEstimates.get(id) ?? null];
        try {
          const estimate = await estimateBusPosition(entry, eta);
          const prior = focusEstimates.get(id);
          // Keep last pin if this poll couldn't place the bus (but ETA still valid)
          if (
            !estimate?.busLatLng &&
            prior?.busLatLng &&
            estimate?.reason !== "no-eta"
          ) {
            return [
              id,
              {
                ...estimate,
                busLatLng: prior.busLatLng,
                busCumDist: prior.busCumDist ?? estimate.busCumDist,
                speedMPerMin: estimate.speedMPerMin ?? prior.speedMPerMin,
              },
            ];
          }
          return [id, estimate];
        } catch {
          return [id, focusEstimates.get(id) ?? null];
        }
      })
    );

    if (token !== focusToken || selectionKey() !== key) return;

    const estimatesById = new Map(estimates.filter(([, e]) => e));
    focusEstimates = estimatesById;

    updateFocusOverlays({
      routes: routesFromEstimates(ids, estimatesById),
      youLatLng: dual ? null : getLastPosition(),
      refit: false,
    });
    startBusAnimations(estimatesById, token);
  } catch (err) {
    console.warn("Focus refresh failed:", err);
  }
}

async function loadEntry(entry) {
  try {
    const { first, second, generatedAt } = await fetchEta(
      entry.route,
      entry.stopId,
      entry.direction
    );
    return { first, second, generatedAt, error: null };
  } catch (err) {
    return { first: null, second: null, generatedAt: null, error: err.message };
  }
}

function scheduleIdle(fn) {
  if (typeof requestIdleCallback === "function") {
    requestIdleCallback(() => fn(), { timeout: 2500 });
  } else {
    setTimeout(fn, 800);
  }
}

async function prefetchWatchlistGeometry() {
  if (didPrefetch) return;
  didPrefetch = true;

  await prefetchLeaflet();

  for (const entry of WATCHLIST) {
    try {
      const coords = await prefetchRouteGeometry(entry);
      if (coords.length > 1) {
        // Warm OSRM / stop-to-stop cache in the background
        await roadSnapStopsChunked(coords);
      }
    } catch {
      // ignore prefetch failures
    }
  }
}

async function refreshAll() {
  if (isRefreshing) return;
  isRefreshing = true;

  ensureRows();
  cardsEl.querySelectorAll(".row").forEach((row) => {
    row.classList.add("row--loading");
  });

  const results = await Promise.all(
    WATCHLIST.map(async (entry) => ({
      id: entry.id,
      result: await loadEntry(entry),
    }))
  );

  for (const { id, result } of results) {
    lastEtaById.set(id, result);
    const row = cardsEl.querySelector(`[data-id="${id}"]`);
    if (row) renderRow(row, result);
  }

  lastRefreshEl.textContent = `Updated ${formatTime(new Date().toISOString())}`;
  isRefreshing = false;

  if (focusedIds.length > 0) {
    refreshFocusedEstimate();
  }

  scheduleIdle(prefetchWatchlistGeometry);
}

function startAutoRefresh() {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = setInterval(refreshAll, REFRESH_INTERVAL_MS);
}

ensureRows();
initTheme();
refreshAll();
startAutoRefresh();
initNearestOrder();

onPositionChange((pos) => {
  if (focusedIds.length === 1 && pos && isFocusPanelVisible()) {
    updateYouMarker(pos, { refit: false });
  }
  applyWalkability(pos);
  scheduleListReorder(pos);
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    refreshAll();
  }
});

document.addEventListener("themechange", () => {
  if (focusedIds.length > 0) {
    setFocusedRows(focusedIds);
  }
});

cardsEl.addEventListener("click", (event) => {
  const row = event.target.closest(".row");
  if (!row) return;
  event.stopPropagation();
  toggleFocus(row.dataset.id);
});

cardsEl.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" && event.key !== " ") return;
  const row = event.target.closest(".row");
  if (!row) return;
  event.preventDefault();
  toggleFocus(row.dataset.id);
});

document.getElementById("focus-panel").addEventListener("click", (event) => {
  event.stopPropagation();
});

document.getElementById("theme-toggle")?.addEventListener("click", (event) => {
  event.stopPropagation();
});

document.getElementById("app").addEventListener("click", (event) => {
  if (
    event.target.closest(".row") ||
    event.target.closest("#focus-panel") ||
    event.target.closest("#theme-toggle")
  ) {
    return;
  }
  refreshAll();
});
