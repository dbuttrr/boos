import { initTheme } from "./theme.js";
import {
  LOCATION,
  FOCUS_REFRESH_INTERVAL_MS,
  MAX_WALK_MINUTES,
  WALK_SPEED_M_PER_MIN,
  NEARBY_STOP_RADIUS_M,
} from "./config.js";
import {
  fetchEta,
  fetchStop,
  fetchRoutes,
  fetchRouteMeta,
  fetchRouteStops,
  fetchStopRoutes,
  ensureStopsIndex,
  resolveRouteStopCoords,
  formatArrivalDisplay,
  formatTime,
  prefetchRouteGeometry,
  trackingNowMs,
  etaModelKey,
} from "./api.js";
import {
  loadWatchlist,
  addEntry,
  removeEntry,
  hasEntry,
  makeEntryId,
  buildLabel,
} from "./watchlist.js";
import {
  estimateBusPosition,
  resolveApproachPulse,
  slicePolylineBetween,
  sanitizeEtaChain,
  resolveActiveBoardingEta,
  haversineMeters,
} from "./estimate.js";
import {
  startGeolocation,
  getLastPosition,
  onPositionChange,
} from "./geo.js";
import { createRefreshScheduler } from "./refreshScheduler.js";
import { createPositionSmoother } from "./positionSmoothing.js";
import {
  ROUTE_COLORS,
  initMapStage,
  showFocusPanel,
  hideFocusPanel,
  updateYouMarker,
  ensureActiveSegmentGeometry,
  updateActiveSegmentMotion,
  fadeOutActiveSegment,
  updateBusMarker,
  updateFocusOverlays,
  isFocusPanelVisible,
  followYouInActiveArea,
  prefetchLeaflet,
  enterAddPickMode,
  updateAddPickPath,
  setAddPickSelection,
  exitAddPickMode,
  isAddPickActive,
} from "./map.js";
import { roadSnapStopsChunked } from "./routing.js";

const cardsEl = document.getElementById("cards");
const lastRefreshEl = document.getElementById("last-refresh");
const nextRefreshEl = document.getElementById("next-refresh");
const addFlowEl = document.getElementById("add-flow");
const addFlowStackEl = document.querySelector(".add-flow-stack");
const addFlowStepRouteEl = document.getElementById("add-flow-step-route");
const addFlowStepDirectionEl = document.getElementById("add-flow-step-direction");
const addFlowStepNearbyEl = document.getElementById("add-flow-step-nearby");
const addFlowStepStopRoutesEl = document.getElementById("add-flow-step-stop-routes");
const addFlowNearbyStatusEl = document.getElementById("add-flow-nearby-status");
const addFlowStopSummaryEl = document.getElementById("add-flow-stop-summary");
const addFlowStopRoutesEl = document.getElementById("add-flow-stop-routes");
const addFlowBackNearbyEl = document.getElementById("add-flow-back-nearby");
const addMenuBackdropEl = document.getElementById("add-menu-backdrop");
const addMenuEl = document.getElementById("add-menu");
const addMenuNearbyEl = document.getElementById("add-menu-nearby");
const addMenuManualEl = document.getElementById("add-menu-manual");
const addPickHintEl = document.getElementById("add-pick-hint");
const addFlowRouteSummaryEl = document.getElementById("add-flow-route-summary");
const addRouteInputEl = document.getElementById("add-route-input");
const addRouteSuggestionsEl = document.getElementById("add-route-suggestions");
const addDirectionFieldsetEl = document.getElementById("add-direction-fieldset");
const MAX_ROUTE_SUGGESTIONS = 8;
const SUGGESTION_BLUR_MS = 150;
const ADD_TOAST_MS = 2200;
const addDirOutboundEl = document.getElementById("add-dir-outbound");
const addDirInboundEl = document.getElementById("add-dir-inbound");
const addFlowErrorEl = document.getElementById("add-flow-error");
const addToastEl = document.getElementById("add-toast");
const SORT_DEBOUNCE_MS = 2_000;
const SWIPE_ACTION_WIDTH = 76;
const SWIPE_AXIS_THRESHOLD = 12;
const SWIPE_OPEN_RATIO = 0.4;

let watchlist = loadWatchlist();
let watchlistIndex = buildWatchlistIndex(watchlist);

let refreshScheduler = null;
let countdownTimer = null;
let countdownState = { mode: "idle", nextAtMs: null };
let focusedIds = [];
let focusToken = 0;
let focusRefreshGeneration = 0;
let lastEtaById = new Map();
let animFrame = null;
let lastBusAnimAt = 0;
let didPrefetch = false;
let stopCoordsById = new Map();
let sortTimer = null;
let lastSortedOrderKey = "";
/** @type {Map<string, object>} */
let focusEstimates = new Map();
const positionSmoother = createPositionSmoother();
let lastFocusFullRefreshAt = 0;

let routeCatalog = [];
let suggestionBlurTimer = null;
let suggestionTouch = null;
let suggestionSelectedViaTouch = false;
let validateRouteToken = 0;
let addState = {
  step: "idle",
  mode: "nearby",
  route: "",
  direction: null,
  routeMeta: null,
  selectedStop: null,
  stopRoutes: [],
  loadToken: 0,
};
let addToastTimer = null;
let addMenuOpen = false;
let swipeState = null;
let openSwipeRow = null;
let suppressRowClick = false;

function buildWatchlistIndex(entries) {
  return new Map(entries.map((entry, i) => [entry.id, i]));
}

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
    <div class="row__actions">
      <button type="button" class="row__delete">Delete</button>
    </div>
    <div class="row__slide">
      <div class="row__main">
        <div class="row__route"></div>
        <div class="row__times">
          <span class="row__eta"></span>
          <span class="row__next"></span>
        </div>
      </div>
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

function rebuildRows() {
  const list = rowsContainer();
  const existingIds = new Set(
    [...list.querySelectorAll(".row")].map((row) => row.dataset.id)
  );
  const nextIds = new Set(watchlist.map((e) => e.id));

  for (const id of existingIds) {
    if (!nextIds.has(id)) {
      list.querySelector(`[data-id="${id}"]`)?.remove();
      lastEtaById.delete(id);
      focusedIds = focusedIds.filter((fid) => fid !== id);
    }
  }

  for (const entry of watchlist) {
    if (!existingIds.has(entry.id)) {
      list.appendChild(createRowElement(entry));
    }
  }

  lastSortedOrderKey = "";
  refreshScheduler?.notifyEntriesChanged();
}

function ensureRows() {
  if (cardsEl.querySelector(".route-list")) {
    rebuildRows();
    return;
  }
  const list = document.createElement("div");
  list.className = "route-list";
  for (const entry of watchlist) {
    list.appendChild(createRowElement(entry));
  }
  cardsEl.appendChild(list);
}

function rowsContainer() {
  return cardsEl.querySelector(".route-list") ?? cardsEl;
}

async function loadStopCoords() {
  const uniqueIds = [...new Set(watchlist.map((e) => e.stopId))];
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
  if (!pos || stopCoordsById.size === 0) return watchlist;

  return [...watchlist].sort((a, b) => {
    const stopA = stopCoordsById.get(a.stopId);
    const stopB = stopCoordsById.get(b.stopId);
    const distA = stopA ? haversineMeters(pos, stopA) : Number.POSITIVE_INFINITY;
    const distB = stopB ? haversineMeters(pos, stopB) : Number.POSITIVE_INFINITY;
    if (distA !== distB) return distA - distB;
    return (watchlistIndex.get(a.id) ?? 0) - (watchlistIndex.get(b.id) ?? 0);
  });
}

function maxWalkableMeters() {
  return MAX_WALK_MINUTES * WALK_SPEED_M_PER_MIN;
}

function isDefinitelyNotWalkable(pos, stop) {
  if (!pos || !stop) return false;
  return haversineMeters(pos, stop) > maxWalkableMeters();
}

function applyWalkability(pos) {
  const list = rowsContainer();
  for (const entry of watchlist) {
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
    const palette =
      ROUTE_COLORS[colorIndex % ROUTE_COLORS.length] ?? ROUTE_COLORS[0];
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
  syncDockButton();
}

function syncDockButton() {
  const btn = document.getElementById("add-route-btn");
  if (!btn) return;
  const clearMode = isAddFlowActive() || addMenuOpen || focusedIds.length > 1;
  btn.classList.toggle("nav-dock__add--clear", clearMode);
  if (isAddFlowActive()) {
    btn.setAttribute("aria-label", "Cancel adding route");
  } else if (addMenuOpen) {
    btn.setAttribute("aria-label", "Close add menu");
  } else if (focusedIds.length > 1) {
    btn.setAttribute("aria-label", "Clear selection");
  } else {
    btn.setAttribute("aria-label", "Add route");
  }
}

function isAddMenuOpen() {
  return addMenuOpen;
}

function openAddMenu() {
  closeAllSwipeRows();
  if (isFocusPanelVisible()) {
    exitFocus();
  }
  addMenuOpen = true;
  if (addMenuBackdropEl) {
    addMenuBackdropEl.hidden = false;
    addMenuBackdropEl.setAttribute("aria-hidden", "false");
  }
  if (addMenuEl) {
    addMenuEl.hidden = false;
  }
  requestAnimationFrame(() => {
    document.body.classList.add("add-menu-open");
  });
  syncDockButton();
}

function closeAddMenu({ immediate = false } = {}) {
  if (!addMenuOpen) return;
  addMenuOpen = false;
  document.body.classList.remove("add-menu-open");
  syncDockButton();

  const hide = () => {
    if (addMenuBackdropEl) {
      addMenuBackdropEl.hidden = true;
      addMenuBackdropEl.setAttribute("aria-hidden", "true");
    }
    if (addMenuEl) {
      addMenuEl.hidden = true;
    }
  };

  if (immediate) {
    hide();
  } else {
    window.setTimeout(hide, 280);
  }
}

function selectionKey(ids = focusedIds) {
  return ids.join("|");
}

function buildApproachPulseForRoute(estimate, nowMs, placement) {
  if (!estimate) return null;
  const pulse = resolveApproachPulse(estimate, nowMs, placement);
  if (!pulse || pulse.toCum - pulse.fromCum < 1) return null;

  const points = slicePolylineBetween(
    estimate.polyline,
    pulse.fromCum,
    pulse.toCum
  );
  if (points.length < 2) return null;

  return {
    points,
    progress: pulse.progress,
    remainingM: Math.max(0, pulse.toCum - pulse.busCum),
  };
}

function applyBusAndPulseToMap(
  routeId,
  estimate,
  colorIndex,
  { dual = false, dtMs = 16, motionNowMs = performance.now() } = {}
) {
  const now = trackingNowMs(estimate);
  const bus = positionSmoother.getPosition(routeId, now, motionNowMs);
  if (bus) {
    updateBusMarker(routeId, { lat: bus.lat, lng: bus.lng });
  } else {
    updateBusMarker(routeId, null);
  }

  const pulse = resolveApproachPulse(estimate, now, bus);
  if (!pulse || pulse.toCum - pulse.fromCum < 1) {
    fadeOutActiveSegment(routeId);
    return Boolean(bus);
  }

  const points = slicePolylineBetween(
    estimate.polyline,
    pulse.fromCum,
    pulse.toCum
  );
  if (points.length < 2) {
    fadeOutActiveSegment(routeId);
    return Boolean(bus);
  }

  ensureActiveSegmentGeometry(routeId, { points, colorIndex, dual });
  updateActiveSegmentMotion(routeId, {
    progress: pulse.progress,
    remainingM: Math.max(0, pulse.toCum - pulse.busCum),
    dtMs,
  });
  return true;
}

function stopBusAnimation() {
  if (animFrame) {
    cancelAnimationFrame(animFrame);
    animFrame = null;
  }
  lastBusAnimAt = 0;
}

function startBusAnimations(estimatesById, token = focusToken) {
  stopBusAnimation();
  if (document.visibilityState !== "visible") return;

  const tracks = [];
  for (const [id, estimate] of estimatesById) {
    if (!estimate?.polyline?.length || !estimate.boardEtaMs) continue;
    if (estimate.reason === "seq-1" || estimate.reason === "no-eta") continue;
    tracks.push({ id, estimate });
  }

  if (!tracks.length) return;

  const dual = focusedIds.length >= 2;

  const tick = (now) => {
    if (
      token !== focusToken ||
      !isFocusPanelVisible() ||
      focusedIds.length === 0
    ) {
      return;
    }

    const dtMs = lastBusAnimAt ? Math.max(0, now - lastBusAnimAt) : 16;
    lastBusAnimAt = now;
    const motionNowMs = performance.now();

    let keepRunning = false;
    let needsHandoffRefresh = false;

    for (const track of tracks) {
      if (!focusedIds.includes(track.id)) continue;
      const estimate = focusEstimates.get(track.id) ?? track.estimate;
      const colorIndex = focusedIds.indexOf(track.id) % ROUTE_COLORS.length;

      const trackingNow = trackingNowMs(estimate);
      const minsLeft = (estimate.boardEtaMs - trackingNow) / 60_000;

      if (minsLeft <= 0) {
        positionSmoother.clear(track.id);
        fadeOutActiveSegment(track.id);
        updateBusMarker(track.id, null);
        needsHandoffRefresh = true;
        continue;
      }

      if (applyBusAndPulseToMap(track.id, estimate, colorIndex, { dual, dtMs, motionNowMs })) {
        keepRunning = true;
      }
    }

    if (keepRunning) {
      animFrame = requestAnimationFrame(tick);
    } else if (needsHandoffRefresh && token === focusToken) {
      refreshFocusedEstimate({ refreshUpstream: true });
    }
  };

  animFrame = requestAnimationFrame(tick);
}

function apiStopSequence(value) {
  if (typeof value !== "number" && typeof value !== "string") return null;
  const sequence = Number(value);
  return Number.isInteger(sequence) && sequence > 0 ? sequence : null;
}

function applyLightweightFocusEtaUpdate(results) {
  let needsHandoff = false;

  for (const { id, result } of results) {
    if (!focusedIds.includes(id)) continue;
    const estimate = focusEstimates.get(id);
    if (!estimate || result?.error) continue;

    const { active, handedOff } = resolveActiveBoardingEta(result);
    const activeSeq = apiStopSequence(active?.seq);
    const boardingSeq = apiStopSequence(estimate.boardingStop?.apiSeq);
    // Losing or gaining sequence evidence can change which loop visit is known.
    const occurrenceChanged = activeSeq !== boardingSeq;
    if (handedOff || occurrenceChanged || !active?.eta) {
      positionSmoother.clear(id);
      updateBusMarker(id, null);
      fadeOutActiveSegment(id);
      needsHandoff = true;
      continue;
    }

    const boardEtaMs = new Date(active.eta).getTime();

    const nowMs = trackingNowMs(estimate);
    const minsLeft = (boardEtaMs - nowMs) / 60_000;

    if (minsLeft == null || minsLeft <= 0) {
      needsHandoff = true;
      continue;
    }

    // Keep the previous model intact until its displayed position is sampled.
    const etaChain = estimate.etaChain?.map((point, i, points) =>
      i === points.length - 1 && point.stopId === estimate.boardingStop?.stopId
        ? { ...point, etaMs: boardEtaMs } : point
    );
    const updated = {
      ...estimate,
      snapshotMs: result.snapshotMs ?? null,
      receivedAtMs: result.receivedAtMs ?? null,
      boardEtaMs,
      minutesToBoard: minsLeft,
      busChanged: false,
      sourceEtaKey: etaModelKey(result),
      etaChain: etaChain ? sanitizeEtaChain(etaChain) : etaChain,
    };
    positionSmoother.setEstimate(id, updated, nowMs, performance.now());
    focusEstimates.set(id, updated);
  }

  if (needsHandoff) {
    refreshFocusedEstimate({ refreshUpstream: true });
  } else if (!animFrame && focusedIds.length > 0) {
    startBusAnimations(focusEstimates, focusToken);
  }
}

function needsFullFocusRefresh(results) {
  if (focusedIds.length === 0 || focusEstimates.size === 0) return false;

  const focusedResults = results.filter(({ id, result }) => focusedIds.includes(id) && !result?.error);
  if (!focusedResults.length) return false;
  const modelChanged = focusedResults.some(({ id, result: eta }) => {
    const estimate = focusEstimates.get(id);
    if (!estimate) return true;
    const { handedOff } = resolveActiveBoardingEta(eta);
    return handedOff || etaModelKey(eta) !== estimate.sourceEtaKey;
  });

  const intervalElapsed =
    Date.now() - lastFocusFullRefreshAt >= FOCUS_REFRESH_INTERVAL_MS;

  return modelChanged || intervalElapsed;
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

  const etaPromise = fetchEta(entry.route, entry.stopId, entry.direction);

  try {
    const eta = await etaPromise;
    commitEntryResult(entry.id, { ...eta, error: null });
    const latest = lastEtaById.get(entry.id);
    const source = latest && !latest.error ? latest : eta;
    const estimate = await estimateBusPosition(entry, source, {
      denseUpstream: true,
      refreshUpstream: true,
    });
    return {
      ...estimate,
      sourceEtaKey: etaModelKey(source),
      boardingStop: estimate.boardingStop
        ? {
            ...boardingStop,
            ...estimate.boardingStop,
            nameEn:
              estimate.boardingStop.nameEn || boardingStop?.nameEn || undefined,
          }
        : boardingStop,
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
  const motionNowMs = performance.now();
  return ids.map((id, colorIndex) => {
    const estimate = estimatesById.get(id);
    const now = estimate ? trackingNowMs(estimate) : Date.now();
    const bus = estimate ? positionSmoother.getPosition(id, now, motionNowMs) : null;
    return {
      id,
      colorIndex: colorIndex % ROUTE_COLORS.length,
      boardingStop: estimate?.boardingStop ?? null,
      busLatLng: bus ? { lat: bus.lat, lng: bus.lng } : null,
      activeSegment: buildApproachPulseForRoute(estimate, now, bus),
      polyline: estimate?.polyline ?? [],
      routePolyline: estimate?.routePolyline ?? [],
      stops: estimate?.stops ?? [],
    };
  });
}

function acceptFocusEstimates(estimatesById) {
  for (const id of focusedIds) {
    if (!estimatesById.has(id)) positionSmoother.clear(id);
  }
  const motionNowMs = performance.now();
  for (const [id, estimate] of estimatesById) {
    if (document.visibilityState === "visible") {
      positionSmoother.setEstimate(id, estimate, trackingNowMs(estimate), motionNowMs);
    } else {
      positionSmoother.clear(id);
    }
  }
  focusEstimates = estimatesById;
}

async function syncFocusMap({ refit = true } = {}) {
  const token = ++focusToken;
  const refreshGeneration = focusRefreshGeneration;
  const ids = [...focusedIds];
  const key = selectionKey(ids);
  setFocusedRows(ids);
  stopBusAnimation();
  focusEstimates.clear();
  positionSmoother.clearAll();
  refreshScheduler?.notifyEntriesChanged();

  if (ids.length === 0) {
    hideFocusPanel({ youLatLng: getLastPosition() });
    return;
  }

  const youLatLng = getLastPosition();

  const quickRoutes = await Promise.all(
    ids.map(async (id, colorIndex) => {
      const entry = watchlist.find((e) => e.id === id);
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
        colorIndex: colorIndex % ROUTE_COLORS.length,
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

  startGeolocation().then((you) => {
    if (token !== focusToken || selectionKey() !== key) return;
    if (focusedIds.length === 0) return;
    const pos = you ?? getLastPosition();
    if (pos) updateYouMarker(pos, { refit: true });
  });

  const estimates = await Promise.all(
    ids.map(async (id) => {
      const entry = watchlist.find((e) => e.id === id);
      if (!entry) return [id, null];
      const estimate = await loadEstimateForEntry(entry);
      return [id, estimate];
    })
  );

  if (token !== focusToken || selectionKey() !== key || refreshGeneration !== focusRefreshGeneration) return;
  if (estimates.some(([id, estimate]) => estimate?.sourceEtaKey != null &&
    estimate.sourceEtaKey !== etaModelKey(lastEtaById.get(id)))) {
    return refreshFocusedEstimate({ refreshUpstream: true });
  }

  const estimatesById = new Map(estimates.filter(([, e]) => e));
  acceptFocusEstimates(estimatesById);
  lastFocusFullRefreshAt = Date.now();

  updateFocusOverlays({
    routes: routesFromEstimates(ids, estimatesById),
    youLatLng: getLastPosition(),
    refit,
  });

  startBusAnimations(estimatesById, token);
}

function exitFocus() {
  focusToken += 1;
  focusedIds = [];
  refreshScheduler?.notifyEntriesChanged();
  focusEstimates.clear();
  positionSmoother.clearAll();
  lastFocusFullRefreshAt = 0;
  stopBusAnimation();
  setFocusedRows([]);
  hideFocusPanel({ youLatLng: getLastPosition() });
}

async function toggleFocus(entryId) {
  if (isAddFlowActive()) return;

  const entry = watchlist.find((e) => e.id === entryId);
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

  focusedIds = [...focusedIds, entryId];
  await syncFocusMap({ refit: true });
}

async function refreshFocusedEstimate({ refreshUpstream = true } = {}) {
  if (focusedIds.length === 0) return;

  const generation = ++focusRefreshGeneration;
  const token = focusToken;
  const ids = [...focusedIds];
  const key = selectionKey(ids);
  const sourceKeys = new Map();

  try {
    const estimates = await Promise.all(
      ids.map(async (id) => {
        const entry = watchlist.find((e) => e.id === id);
        const eta = lastEtaById.get(id);
        if (!entry || !eta) return [id, focusEstimates.get(id) ?? null];
        sourceKeys.set(id, etaModelKey(eta));
        try {
          const estimate = await estimateBusPosition(entry, eta, {
            denseUpstream: true,
            refreshUpstream,
          });
          return [id, { ...estimate, sourceEtaKey: sourceKeys.get(id) }];
        } catch {
          return [id, focusEstimates.get(id) ?? null];
        }
      })
    );

    if (generation !== focusRefreshGeneration || token !== focusToken || selectionKey() !== key) return;
    if ([...sourceKeys].some(([id, sourceKey]) => sourceKey !== etaModelKey(lastEtaById.get(id)))) {
      return refreshFocusedEstimate({ refreshUpstream });
    }

    const estimatesById = new Map(estimates.filter(([, estimate]) => estimate));
    acceptFocusEstimates(estimatesById);
    lastFocusFullRefreshAt = Date.now();

    updateFocusOverlays({
      routes: routesFromEstimates(ids, estimatesById),
      youLatLng: getLastPosition(),
      refit: false,
    });
    startBusAnimations(estimatesById, token);
  } catch (err) {
    console.warn("Focus refresh failed:", err);
  }
}

async function loadEntry(entry) {
  try {
    const { first, second, generatedAt, snapshotMs, receivedAtMs } =
      await fetchEta(entry.route, entry.stopId, entry.direction);
    return {
      first,
      second,
      generatedAt,
      snapshotMs,
      receivedAtMs,
      error: null,
    };
  } catch (err) {
    return {
      first: null,
      second: null,
      generatedAt: null,
      snapshotMs: null,
      receivedAtMs: null,
      error: err.message,
    };
  }
}

function commitEntryResult(id, result) {
  if (!watchlist.some((entry) => entry.id === id)) return null;
  const previous = lastEtaById.get(id);
  if (!result.error) {
    if (previous && !previous.error && previous.receivedAtMs > result.receivedAtMs) {
      result = previous;
    }
    lastEtaById.set(id, result);
  } else if (!previous || previous.error) {
    lastEtaById.set(id, result);
  }
  // Failed transport checks show an error but supply no evidence that the
  // previously observed bus disappeared. Keep its source until ETA expiry.
  const row = cardsEl.querySelector(`[data-id="${id}"]`);
  if (row) renderRow(row, result);
  return result;
}

function scheduleIdle(fn) {
  if (typeof requestIdleCallback === "function") {
    requestIdleCallback(() => fn(), { timeout: 2500 });
  } else {
    setTimeout(fn, 800);
  }
}

async function prefetchRouteCatalog() {
  try {
    if (!routeCatalog.length) {
      routeCatalog = await fetchRoutes();
    }
  } catch {
    // ignore prefetch failures
  }
}

function hideRouteSuggestions() {
  if (suggestionBlurTimer) {
    clearTimeout(suggestionBlurTimer);
    suggestionBlurTimer = null;
  }
  addRouteSuggestionsEl.hidden = true;
  addRouteSuggestionsEl.innerHTML = "";
  addFlowStackEl?.classList.remove("add-flow-stack--suggestions-open");
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderRouteSuggestions(matches) {
  if (!matches.length) {
    hideRouteSuggestions();
    return;
  }

  addRouteSuggestionsEl.innerHTML = matches
    .map((r) => {
      const route = escapeHtml(r.route);
      const dest = escapeHtml(r.destEn || "");
      return `<li role="option" class="add-flow__suggestion" data-route="${route}" tabindex="-1">${route}<span class="add-flow__suggestion-dest">${dest}</span></li>`;
    })
    .join("");
  addRouteSuggestionsEl.hidden = false;
  addFlowStackEl?.classList.add("add-flow-stack--suggestions-open");
}

async function updateRouteSuggestions(query) {
  const q = query.trim().toUpperCase();
  if (!q) {
    hideRouteSuggestions();
    return;
  }

  await prefetchRouteCatalog();
  if (!isAddFlowActive()) return;

  const matches = [];
  for (const r of routeCatalog) {
    if (!r.route.toUpperCase().startsWith(q)) continue;
    matches.push(r);
    if (matches.length >= MAX_ROUTE_SUGGESTIONS) break;
  }
  renderRouteSuggestions(matches);
}

function selectRouteSuggestion(route) {
  if (!route) return;
  if (suggestionBlurTimer) {
    clearTimeout(suggestionBlurTimer);
    suggestionBlurTimer = null;
  }
  suggestionTouch = null;
  hideRouteSuggestions();
  addRouteInputEl.value = route;
  validateAndLoadRoute(route);
}

function yieldToPaint() {
  return new Promise((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}

async function prefetchStopsIndex() {
  try {
    await ensureStopsIndex();
  } catch {
    // ignore prefetch failures
  }
}

async function prefetchWatchlistGeometry() {
  if (didPrefetch) return;
  didPrefetch = true;

  await prefetchLeaflet();
  await prefetchRouteCatalog();
  prefetchStopsIndex();

  for (const entry of watchlist) {
    try {
      const coords = await prefetchRouteGeometry(entry);
      if (coords.length > 1) {
        await roadSnapStopsChunked(coords);
      }
    } catch {
      // ignore prefetch failures
    }
  }
}

async function refreshEntries(ids) {
  const entries = [...new Set(ids)]
    .map((id) => watchlist.find((entry) => entry.id === id))
    .filter(Boolean);
  if (!entries.length) return;
  ensureRows();
  for (const entry of entries) {
    cardsEl.querySelector(`[data-id="${entry.id}"]`)?.classList.add("row--loading");
  }

  const received = await Promise.all(
    entries.map(async (entry) => ({
      id: entry.id,
      result: await loadEntry(entry),
    }))
  );
  // A removed row must not be restored by a request that started before removal.
  const results = received.map(({ id, result }) => ({ id, result: commitEntryResult(id, result) }))
    .filter(({ result }) => result);

  if (results.length) {
    const scope = results.every(({ id }) => focusedIds.includes(id)) && results.length < watchlist.length
      ? " focused" : "";
    lastRefreshEl.textContent = `Checked${scope} ${formatTime(new Date().toISOString())}`;
  }
  paintNextRefreshCountdown();

  if (results.some(({ id }) => focusedIds.includes(id))) {
    if (needsFullFocusRefresh(results)) {
      refreshFocusedEstimate({ refreshUpstream: true });
    } else {
      applyLightweightFocusEtaUpdate(results);
    }
  }

  scheduleIdle(prefetchWatchlistGeometry);
}

async function requestRefresh() {
  return refreshScheduler?.refreshNow();
}

function paintNextRefreshCountdown() {
  if (!nextRefreshEl) return;
  const { mode, nextAtMs } = countdownState;

  if (mode === "refreshing") {
    nextRefreshEl.hidden = false;
    nextRefreshEl.textContent = "refreshing…";
    return;
  }

  if (nextAtMs == null) {
    nextRefreshEl.hidden = true;
    nextRefreshEl.textContent = "";
    return;
  }

  const secs = Math.max(0, Math.ceil((nextAtMs - Date.now()) / 1000));
  nextRefreshEl.hidden = false;
  nextRefreshEl.textContent =
    secs === 0 ? "checking soon…" : `next check ${secs}s`;
}

function startCountdownTick() {
  if (countdownTimer) clearInterval(countdownTimer);
  paintNextRefreshCountdown();
  countdownTimer = setInterval(paintNextRefreshCountdown, 250);
}

function initRefreshScheduler() {
  refreshScheduler = createRefreshScheduler({
    getEntryIds: () => watchlist.map((entry) => entry.id),
    getFocusedIds: () => focusedIds,
    onRefresh: refreshEntries,
    isActive: () => document.visibilityState === "visible",
    onCountdown: ({ mode, nextAtMs }) => {
      countdownState = { mode, nextAtMs };
      paintNextRefreshCountdown();
    },
  });
  refreshScheduler.start();
  startCountdownTick();
}

function setAddError(message) {
  if (!message) {
    addFlowErrorEl.hidden = true;
    addFlowErrorEl.textContent = "";
    return;
  }
  addFlowErrorEl.hidden = false;
  addFlowErrorEl.textContent = message;
}

function setDirectionButtons(direction) {
  addDirOutboundEl.classList.toggle(
    "add-flow__dir-btn--active",
    direction === "O"
  );
  addDirInboundEl.classList.toggle(
    "add-flow__dir-btn--active",
    direction === "I"
  );
}

function updateDirectionLabels(meta) {
  if (!meta) {
    addDirOutboundEl.textContent = "Outbound";
    addDirInboundEl.textContent = "Inbound";
    return;
  }
  addDirOutboundEl.textContent = `${meta.origEn} → ${meta.destEn}`;
  addDirInboundEl.textContent = `${meta.destEn} → ${meta.origEn}`;
}

function formatNearbyRadiusLabel() {
  return NEARBY_STOP_RADIUS_M >= 1000
    ? `${NEARBY_STOP_RADIUS_M / 1000} km`
    : `${NEARBY_STOP_RADIUS_M} m`;
}

function filterNearbyStops(index, origin) {
  return index
    .map((stop) => ({
      ...stop,
      distanceM: haversineMeters(origin, stop),
    }))
    .filter((stop) => stop.distanceM <= NEARBY_STOP_RADIUS_M)
    .sort((a, b) => a.distanceM - b.distanceM);
}

function paintAddFlowStep() {
  const step = addState.step;
  addFlowStepRouteEl.hidden = step !== "route";
  addFlowStepDirectionEl.hidden = step !== "direction";
  if (addFlowStepNearbyEl) {
    addFlowStepNearbyEl.hidden = step !== "nearby-loading";
  }
  if (addFlowStepStopRoutesEl) {
    addFlowStepStopRoutesEl.hidden = step !== "stop-routes";
  }

  addFlowEl.hidden =
    step === "picking" || step === "nearby-picking" || step === "idle";
  addPickHintEl.hidden = step !== "picking" && step !== "nearby-picking";

  if (addPickHintEl) {
    if (step === "nearby-picking") {
      addPickHintEl.textContent = "Tap a nearby bus stop";
    } else if (step === "picking") {
      addPickHintEl.textContent = "Tap your boarding stop on the map";
    }
  }

  if (step === "direction" && addState.route) {
    addFlowRouteSummaryEl.textContent = addState.route;
  }

  document.body.classList.toggle("add-flow-active", step !== "idle");
  syncDockButton();
}

function isAddFlowActive() {
  return addState.step !== "idle";
}

function resetAddState() {
  addState = {
    step: "idle",
    mode: "nearby",
    route: "",
    direction: null,
    routeMeta: null,
    selectedStop: null,
    stopRoutes: [],
    loadToken: addState.loadToken + 1,
  };
  addRouteInputEl.value = "";
  hideRouteSuggestions();
  setDirectionButtons(null);
  updateDirectionLabels(null);
  if (isAddPickActive()) {
    exitAddPickMode({ youLatLng: getLastPosition() });
  }
  setAddError("");
  if (addFlowStopRoutesEl) addFlowStopRoutesEl.innerHTML = "";
  addFlowEl.hidden = true;
  if (addPickHintEl) addPickHintEl.hidden = true;
  paintAddFlowStep();
}

function cancelAddFlow() {
  closeAddMenu();
  resetAddState();
}

function showAddToast(message) {
  if (!addToastEl) return;
  if (addToastTimer) {
    clearTimeout(addToastTimer);
    addToastTimer = null;
  }
  addToastEl.textContent = message;
  addToastEl.hidden = false;
  addToastEl.classList.remove("add-toast--visible");
  requestAnimationFrame(() => {
    addToastEl.classList.add("add-toast--visible");
  });
  addToastTimer = window.setTimeout(() => {
    addToastEl.classList.remove("add-toast--visible");
    addToastTimer = window.setTimeout(() => {
      addToastEl.hidden = true;
      addToastTimer = null;
    }, 250);
  }, ADD_TOAST_MS);
}

async function startNearbyFlow() {
  closeAddMenu({ immediate: true });
  resetAddState();
  addState.mode = "nearby";
  addState.step = "nearby-loading";
  if (addFlowNearbyStatusEl) {
    addFlowNearbyStatusEl.textContent = "Finding nearby stops…";
  }
  paintAddFlowStep();

  startGeolocation();
  prefetchRouteCatalog();
  prefetchStopsIndex();
  await loadNearbyStops();
}

async function startManualFlow() {
  closeAddMenu({ immediate: true });
  resetAddState();
  addState.mode = "route";
  addState.step = "route";
  paintAddFlowStep();

  startGeolocation();
  prefetchRouteCatalog();

  await yieldToPaint();
  if (!isAddFlowActive()) return;
  addRouteInputEl.focus();
}

async function loadNearbyStops() {
  const token = ++addState.loadToken;
  setAddError("");

  try {
    const pos = await startGeolocation();
    const origin = pos ?? LOCATION;
    if (token !== addState.loadToken || !isAddFlowActive()) return;

    const index = await ensureStopsIndex();
    if (token !== addState.loadToken || !isAddFlowActive()) return;

    const nearby = filterNearbyStops(index, origin);
    if (!nearby.length) {
      addState.step = "nearby-loading";
      if (addFlowNearbyStatusEl) {
        addFlowNearbyStatusEl.textContent = `No stops within ${formatNearbyRadiusLabel()}`;
      }
      setAddError("Tap × and choose Enter manually");
      paintAddFlowStep();
      return;
    }

    addState.step = "nearby-picking";
    paintAddFlowStep();

    await yieldToPaint();
    if (token !== addState.loadToken || !isAddFlowActive()) return;

    await enterAddPickMode({
      stops: nearby,
      youLatLng: origin,
      instantSelect: true,
      onSelect: (stop) => {
        if (token !== addState.loadToken || addState.step !== "nearby-picking") {
          return;
        }
        selectNearbyStop(stop, token);
      },
      onPositionChange,
      isStale: () => token !== addState.loadToken || !isAddFlowActive(),
    });
  } catch (err) {
    if (token !== addState.loadToken) return;
    addState.step = "nearby-loading";
    if (addFlowNearbyStatusEl) {
      addFlowNearbyStatusEl.textContent = "Could not load nearby stops";
    }
    setAddError(err.message || "Failed to load nearby stops");
    paintAddFlowStep();
  }
}

async function selectNearbyStop(stop, token = addState.loadToken) {
  addState.selectedStop = stop;
  setAddError("");

  if (isAddPickActive()) {
    exitAddPickMode({ youLatLng: getLastPosition() });
  }

  addState.step = "stop-routes";
  if (addFlowStopSummaryEl) {
    addFlowStopSummaryEl.textContent = stop.nameEn || "Stop";
  }
  if (addFlowStopRoutesEl) {
    addFlowStopRoutesEl.innerHTML =
      '<li class="add-flow__summary">Loading routes…</li>';
  }
  paintAddFlowStep();

  try {
    const routes = await fetchStopRoutes(stop.stopId);
    if (token !== addState.loadToken || addState.step !== "stop-routes") return;

    if (!routes.length) {
      setAddError("No routes serve this stop");
      if (addFlowStopRoutesEl) addFlowStopRoutesEl.innerHTML = "";
      return;
    }

    addState.stopRoutes = routes;
    await renderStopRoutes(routes);
  } catch (err) {
    if (token !== addState.loadToken) return;
    setAddError(err.message || "Failed to load routes");
    if (addFlowStopRoutesEl) addFlowStopRoutesEl.innerHTML = "";
  }
}

async function renderStopRoutes(routes) {
  const uniqueRoutes = [...new Set(routes.map((r) => r.route))];
  const metaByRoute = new Map();
  await Promise.all(
    uniqueRoutes.map(async (route) => {
      try {
        const meta = await fetchRouteMeta(route);
        metaByRoute.set(route, meta);
      } catch {
        // ignore per-route meta failures
      }
    })
  );

  if (!isAddFlowActive() || addState.step !== "stop-routes" || !addFlowStopRoutesEl) {
    return;
  }

  addFlowStopRoutesEl.innerHTML = routes
    .map((item) => {
      const meta = metaByRoute.get(item.route);
      const dest = routeDestForDirection(meta, item.direction);
      const dirLabel = item.direction === "I" ? "In" : "Out";
      const route = escapeHtml(item.route);
      const destHtml = escapeHtml(dest || "—");
      return `<li role="option"><button type="button" class="add-flow__route-item" data-route="${route}" data-direction="${item.direction}"><span class="add-flow__route-item-num">${route}</span><span class="add-flow__route-item-dest">${destHtml}</span><span class="add-flow__route-item-dir">${dirLabel}</span></button></li>`;
    })
    .join("");
}

async function selectStopRoute(route, direction) {
  if (!route || !direction || !addState.selectedStop) return;

  addState.route = route;
  addState.direction = direction;
  try {
    addState.routeMeta = await fetchRouteMeta(route);
  } catch {
    addState.routeMeta = null;
  }
  confirmAddEntry();
}

async function backToNearbyPicking() {
  addState.selectedStop = null;
  addState.stopRoutes = [];
  addState.route = "";
  addState.direction = null;
  addState.routeMeta = null;
  if (addFlowStopRoutesEl) addFlowStopRoutesEl.innerHTML = "";
  setAddError("");
  addState.step = "nearby-loading";
  if (addFlowNearbyStatusEl) {
    addFlowNearbyStatusEl.textContent = "Finding nearby stops…";
  }
  paintAddFlowStep();
  await loadNearbyStops();
}

async function validateAndLoadRoute(routeValue) {
  const token = ++validateRouteToken;
  const route = routeValue.trim().toUpperCase();
  hideRouteSuggestions();

  if (!route) {
    if (token !== validateRouteToken || !isAddFlowActive()) return;
    addState.route = "";
    addState.routeMeta = null;
    addState.direction = null;
    addState.selectedStop = null;
    addState.stopRoutes = [];
    addState.step = "route";
    setDirectionButtons(null);
    updateDirectionLabels(null);
    setAddError("");
    paintAddFlowStep();
    return;
  }

  setAddError("");
  try {
    const meta = await fetchRouteMeta(route);
    if (token !== validateRouteToken || !isAddFlowActive()) return;
    addState.mode = "route";
    addState.route = meta.route;
    addState.routeMeta = meta;
    addState.direction = null;
    addState.selectedStop = null;
    addState.stopRoutes = [];
    addState.step = "direction";
    updateDirectionLabels(meta);
    setDirectionButtons(null);
    paintAddFlowStep();
  } catch {
    if (token !== validateRouteToken || !isAddFlowActive()) return;
    addState.route = "";
    addState.routeMeta = null;
    addState.direction = null;
    addState.selectedStop = null;
    addState.stopRoutes = [];
    addState.step = "route";
    setDirectionButtons(null);
    updateDirectionLabels(null);
    setAddError(`Route ${route} not found`);
    paintAddFlowStep();
  }
}

async function loadAddPickForDirection(direction) {
  if (!addState.route || !direction) return;

  const token = ++addState.loadToken;
  addState.direction = direction;
  addState.selectedStop = null;
  addState.step = "picking";
  setDirectionButtons(direction);
  setAddError("");
  paintAddFlowStep();

  try {
    const routeStops = await fetchRouteStops(addState.route, direction);
    const stops = await resolveRouteStopCoords(routeStops);
    if (token !== addState.loadToken) return;

    if (!stops.length) {
      addState.step = "direction";
      setAddError("No stops found for this direction");
      paintAddFlowStep();
      return;
    }

    await yieldToPaint();
    if (token !== addState.loadToken || !isAddFlowActive()) return;

    const youLatLng = getLastPosition();

    await enterAddPickMode({
      stops,
      youLatLng,
      onSelect: (stop) => {
        if (token !== addState.loadToken || addState.step !== "picking") return;
        addState.selectedStop = stop;
        setAddPickSelection(stop.stopId);
        setAddError("");
      },
      onConfirm: () => {
        if (token !== addState.loadToken || addState.step !== "picking") return;
        confirmAddEntry();
      },
      onPositionChange,
      isStale: () => token !== addState.loadToken || !isAddFlowActive(),
    });

    if (token !== addState.loadToken || !isAddFlowActive()) return;

    if (stops.length > 1) {
      try {
        const roadPath = await roadSnapStopsChunked(stops);
        if (token !== addState.loadToken || !isAddFlowActive()) return;
        if (roadPath?.length > 1) {
          updateAddPickPath(roadPath);
        }
      } catch (err) {
        console.warn("Add-pick road snap failed:", err);
      }
    }
  } catch (err) {
    if (token !== addState.loadToken) return;
    addState.step = "direction";
    setAddError(err.message || "Failed to load stops");
    exitAddPickMode({ youLatLng: getLastPosition() });
    paintAddFlowStep();
  }
}

function routeDestForDirection(meta, direction) {
  if (!meta) return "";
  return direction === "I" ? meta.origEn : meta.destEn;
}

async function confirmAddEntry() {
  const { route, direction, routeMeta, selectedStop } = addState;
  if (!route || !direction || !selectedStop) return;

  const entry = {
    id: makeEntryId(route, direction, selectedStop.stopId),
    route,
    stopId: selectedStop.stopId,
    direction,
    label: buildLabel(
      route,
      routeDestForDirection(routeMeta, direction),
      selectedStop.nameEn
    ),
  };

  const { entries, added, reason } = addEntry(watchlist, entry);
  if (!added) {
    if (reason === "duplicate") {
      showAddToast("Already on your list");
    }
    return;
  }

  watchlist = entries;
  watchlistIndex = buildWatchlistIndex(watchlist);
  stopCoordsById.set(selectedStop.stopId, {
    lat: selectedStop.lat,
    lng: selectedStop.lng,
  });

  const toastMessage = `Added ${route} · ${selectedStop.nameEn}`;
  cancelAddFlow();
  rebuildRows();
  await requestRefresh();
  showAddToast(toastMessage);

  const pos = getLastPosition();
  if (pos) {
    applyListOrder(pos);
    applyWalkability(pos);
  }
}

function confirmRemoveEntry(id) {
  const entry = watchlist.find((e) => e.id === id);
  if (!entry) return;

  const label = routeText(entry);
  if (!window.confirm(`Remove ${label} from your list?`)) return;

  if (focusedIds.includes(id)) {
    focusedIds = focusedIds.filter((fid) => fid !== id);
    if (focusedIds.length === 0) {
      exitFocus();
    } else {
      syncFocusMap({ refit: true });
    }
  }

  const { entries, removed } = removeEntry(watchlist, id);
  if (!removed) return;

  watchlist = entries;
  watchlistIndex = buildWatchlistIndex(watchlist);
  lastEtaById.delete(id);
  rebuildRows();
  requestRefresh();

  const pos = getLastPosition();
  if (pos) {
    applyListOrder(pos);
    applyWalkability(pos);
  }
}

function setRowSwipeX(row, x) {
  if (!row) return;
  const clamped = Math.max(-SWIPE_ACTION_WIDTH, Math.min(0, x));
  const progress = Math.min(1, Math.abs(clamped) / SWIPE_ACTION_WIDTH);
  row.style.setProperty("--row-swipe-x", `${clamped}px`);
  row.style.setProperty("--row-swipe-progress", String(progress));
  return clamped;
}

function clearRowSwipeProps(row) {
  row.style.removeProperty("--row-swipe-x");
  row.style.removeProperty("--row-swipe-progress");
}

function closeSwipeRow(row) {
  if (!row) return;
  const slide = row.querySelector(".row__slide");
  const wasOpen =
    row.classList.contains("row--swipe-open") ||
    row.classList.contains("row--swiping");

  row.classList.remove("row--swiping");
  if (openSwipeRow === row) openSwipeRow = null;

  if (!wasOpen) {
    row.classList.remove("row--swipe-open");
    clearRowSwipeProps(row);
    return;
  }

  // Keep swipe-open so transform still applies while we animate back to 0,
  // then drop transform entirely so backdrop-filter matches main again.
  row.classList.add("row--swipe-open");
  setRowSwipeX(row, 0);

  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    row.classList.remove("row--swipe-open", "row--swiping");
    clearRowSwipeProps(row);
    slide?.removeEventListener("transitionend", onEnd);
  };
  const onEnd = (event) => {
    if (event.target !== slide || event.propertyName !== "transform") return;
    finish();
  };
  slide?.addEventListener("transitionend", onEnd);
  setTimeout(finish, 280);
}

function openRowSwipe(row) {
  if (!row) return;
  if (openSwipeRow && openSwipeRow !== row) closeSwipeRow(openSwipeRow);
  row.classList.remove("row--swiping");
  row.classList.add("row--swipe-open");
  setRowSwipeX(row, -SWIPE_ACTION_WIDTH);
  openSwipeRow = row;
}

function closeAllSwipeRows() {
  cardsEl
    .querySelectorAll(".row--swipe-open, .row--swiping")
    .forEach((row) => closeSwipeRow(row));
  openSwipeRow = null;
}

ensureRows();
initTheme();
initMapStage({
  center: LOCATION,
  youLatLng: getLastPosition(),
})
  .then(() => {
    const pos = getLastPosition();
    if (pos) followYouInActiveArea(pos, { animate: false });
  })
  .catch((err) => console.warn("Map init failed", err));
initRefreshScheduler();
initNearestOrder();

onPositionChange((pos) => {
  if (!pos) return;
  if (focusedIds.length === 0) {
    followYouInActiveArea(pos, { animate: true });
  } else if (focusedIds.length > 0 && isFocusPanelVisible()) {
    updateYouMarker(pos, { refit: false });
  }
  applyWalkability(pos);
  scheduleListReorder(pos);
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    for (const [id, estimate] of focusEstimates) {
      positionSmoother.setEstimate(id, estimate, trackingNowMs(estimate), performance.now(), { reset: true });
    }
    if (focusedIds.length > 0) startBusAnimations(focusEstimates, focusToken);
    refreshScheduler?.resume();
  } else {
    stopBusAnimation();
    positionSmoother.clearAll();
    refreshScheduler?.pause();
  }
});

document.addEventListener("themechange", () => {
  if (focusedIds.length > 0) {
    setFocusedRows(focusedIds);
  }
});

document.getElementById("add-route-btn")?.addEventListener("click", (event) => {
  event.stopPropagation();
  if (isAddFlowActive()) {
    cancelAddFlow();
    return;
  }
  if (addMenuOpen) {
    closeAddMenu();
    return;
  }
  if (focusedIds.length > 1) {
    exitFocus();
    return;
  }
  openAddMenu();
});

addMenuBackdropEl?.addEventListener("click", () => {
  closeAddMenu();
});

addMenuNearbyEl?.addEventListener("click", (event) => {
  event.stopPropagation();
  startNearbyFlow();
});

addMenuManualEl?.addEventListener("click", (event) => {
  event.stopPropagation();
  startManualFlow();
});

addFlowBackNearbyEl?.addEventListener("click", () => {
  backToNearbyPicking();
});

addFlowStopRoutesEl?.addEventListener("click", (event) => {
  const btn = event.target.closest(".add-flow__route-item");
  if (!btn) return;
  selectStopRoute(btn.getAttribute("data-route"), btn.getAttribute("data-direction"));
});

addRouteInputEl?.addEventListener("input", () => {
  updateRouteSuggestions(addRouteInputEl.value);
});

addRouteInputEl?.addEventListener("focus", () => {
  if (suggestionBlurTimer) {
    clearTimeout(suggestionBlurTimer);
    suggestionBlurTimer = null;
  }
  if (addRouteInputEl.value.trim()) {
    updateRouteSuggestions(addRouteInputEl.value);
  }
});

addRouteInputEl?.addEventListener("change", () => {
  validateAndLoadRoute(addRouteInputEl.value);
});

addRouteInputEl?.addEventListener("focusout", (event) => {
  if (event.relatedTarget?.closest?.(".add-flow__suggestion")) return;
  suggestionBlurTimer = setTimeout(() => {
    suggestionBlurTimer = null;
    const suggestionsVisible = !addRouteSuggestionsEl.hidden;
    hideRouteSuggestions();
    if (!suggestionsVisible) {
      validateAndLoadRoute(addRouteInputEl.value);
    }
  }, SUGGESTION_BLUR_MS);
});

addRouteInputEl?.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    hideRouteSuggestions();
    validateAndLoadRoute(addRouteInputEl.value);
  } else if (event.key === "Escape") {
    hideRouteSuggestions();
  }
});

addRouteSuggestionsEl?.addEventListener("touchstart", (event) => {
  if (suggestionBlurTimer) {
    clearTimeout(suggestionBlurTimer);
    suggestionBlurTimer = null;
  }
  const item = event.target.closest(".add-flow__suggestion");
  if (!item) {
    suggestionTouch = null;
    return;
  }
  const touch = event.touches[0];
  if (!touch) return;
  suggestionTouch = {
    route: item.getAttribute("data-route"),
    x: touch.clientX,
    y: touch.clientY,
  };
}, { passive: true });

addRouteSuggestionsEl?.addEventListener("touchmove", (event) => {
  if (!suggestionTouch) return;
  const touch = event.touches[0];
  if (!touch) return;
  const dx = touch.clientX - suggestionTouch.x;
  const dy = touch.clientY - suggestionTouch.y;
  if (Math.abs(dx) > 12 || Math.abs(dy) > 12) {
    suggestionTouch = null;
  }
}, { passive: true });

addRouteSuggestionsEl?.addEventListener("touchend", (event) => {
  if (!suggestionTouch?.route) return;
  const route = suggestionTouch.route;
  suggestionTouch = null;
  suggestionSelectedViaTouch = true;
  event.preventDefault();
  selectRouteSuggestion(route);
}, { passive: false });

addRouteSuggestionsEl?.addEventListener("pointerdown", (event) => {
  if (!event.target.closest(".add-flow__suggestion")) return;
  if (event.pointerType === "mouse") {
    // Keep mousedown from blurring the input before click; do not block touch scroll.
    event.preventDefault();
  }
});

addRouteSuggestionsEl?.addEventListener("click", (event) => {
  if (suggestionSelectedViaTouch) {
    suggestionSelectedViaTouch = false;
    event.preventDefault();
    return;
  }
  const item = event.target.closest(".add-flow__suggestion");
  if (!item) return;
  selectRouteSuggestion(item.getAttribute("data-route"));
});

addDirOutboundEl?.addEventListener("click", () => {
  loadAddPickForDirection("O");
});

addDirInboundEl?.addEventListener("click", () => {
  loadAddPickForDirection("I");
});

addFlowEl?.addEventListener("click", (event) => {
  event.stopPropagation();
});

cardsEl.addEventListener("click", (event) => {
  if (isAddFlowActive()) return;

  const deleteBtn = event.target.closest(".row__delete");
  if (deleteBtn) {
    event.stopPropagation();
    const row = deleteBtn.closest(".row");
    if (row) confirmRemoveEntry(row.dataset.id);
    closeAllSwipeRows();
    return;
  }

  const row = event.target.closest(".row");
  if (!row) return;
  event.stopPropagation();

  if (suppressRowClick) {
    suppressRowClick = false;
    return;
  }

  // Tap an open swipe to close instead of toggling focus.
  if (row.classList.contains("row--swipe-open")) {
    closeSwipeRow(row);
    return;
  }

  if (openSwipeRow && openSwipeRow !== row) {
    closeSwipeRow(openSwipeRow);
  }

  toggleFocus(row.dataset.id);
});

cardsEl.addEventListener("keydown", (event) => {
  if (isAddFlowActive()) return;
  if (event.key !== "Enter" && event.key !== " ") return;
  const row = event.target.closest(".row");
  if (!row) return;
  event.preventDefault();
  closeAllSwipeRows();
  toggleFocus(row.dataset.id);
});

cardsEl.addEventListener("pointerdown", (event) => {
  if (event.pointerType === "mouse" && event.button !== 0) return;
  if (isAddFlowActive()) return;

  const deleteBtn = event.target.closest(".row__delete");
  if (deleteBtn) return;

  const row = event.target.closest(".row");
  if (!row) return;

  const startX = event.clientX;
  const startY = event.clientY;
  const opened = row.classList.contains("row--swipe-open");
  const startTx = opened ? -SWIPE_ACTION_WIDTH : 0;

  if (openSwipeRow && openSwipeRow !== row) {
    closeSwipeRow(openSwipeRow);
  }

  swipeState = {
    row,
    pointerId: event.pointerId,
    startX,
    startY,
    startTx,
    axis: null,
    dragged: false,
  };
});

cardsEl.addEventListener("pointermove", (event) => {
  const state = swipeState;
  if (!state || event.pointerId !== state.pointerId) return;

  const dx = event.clientX - state.startX;
  const dy = event.clientY - state.startY;

  if (!state.axis) {
    if (
      Math.abs(dx) < SWIPE_AXIS_THRESHOLD &&
      Math.abs(dy) < SWIPE_AXIS_THRESHOLD
    ) {
      return;
    }
    if (Math.abs(dx) > Math.abs(dy)) {
      state.axis = "x";
      state.row.classList.add("row--swiping");
      state.row.classList.remove("row--swipe-open");
      try {
        state.row.setPointerCapture(event.pointerId);
      } catch {
        // ignore
      }
    } else {
      state.axis = "y";
      swipeState = null;
      return;
    }
  }

  if (state.axis !== "x") return;

  event.preventDefault();
  state.dragged = true;
  suppressRowClick = true;
  state.lastX = setRowSwipeX(state.row, state.startTx + dx);
});

function endSwipe(event) {
  const state = swipeState;
  if (!state || (event && event.pointerId !== state.pointerId)) return;
  swipeState = null;

  const row = state.row;
  row.classList.remove("row--swiping");

  if (state.axis !== "x") {
    if (!state.dragged) suppressRowClick = false;
    return;
  }

  const currentX = state.lastX ?? state.startTx;
  const shouldOpen = currentX <= -SWIPE_ACTION_WIDTH * SWIPE_OPEN_RATIO;

  if (shouldOpen) {
    openRowSwipe(row);
  } else {
    closeSwipeRow(row);
  }

  if (state.dragged) {
    suppressRowClick = true;
    setTimeout(() => {
      suppressRowClick = false;
    }, 0);
  }
}

cardsEl.addEventListener("pointerup", endSwipe);
cardsEl.addEventListener("pointercancel", endSwipe);

document.getElementById("map-stage")?.addEventListener("click", (event) => {
  event.stopPropagation();
});

document.getElementById("theme-toggle")?.addEventListener("click", (event) => {
  event.stopPropagation();
});

document.getElementById("app").addEventListener("click", (event) => {
  if (!event.target.closest(".row")) {
    closeAllSwipeRows();
  }

  if (
    event.target.closest(".row") ||
    event.target.closest("#map-stage") ||
    event.target.closest(".add-anchor") ||
    event.target.closest(".add-menu-backdrop") ||
    event.target.closest(".add-toast")
  ) {
    return;
  }
  requestRefresh();
});

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (isAddFlowActive()) {
    cancelAddFlow();
    return;
  }
  if (addMenuOpen) {
    closeAddMenu();
  }
});
