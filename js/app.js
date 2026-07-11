import { initTheme } from "./theme.js";
import {
  LOCATION,
  REFRESH_INTERVAL_MS,
  FOCUS_REFRESH_INTERVAL_MS,
  ARRIVING_THRESHOLD_MIN,
  MAX_WALK_MINUTES,
  WALK_SPEED_M_PER_MIN,
  BUS_REPOSITION_MS,
  BUS_REPOSITION_MIN_M,
  MAX_BUS_REWIND_M,
} from "./config.js";
import {
  fetchEta,
  fetchStop,
  fetchRoutes,
  fetchRouteMeta,
  fetchRouteStops,
  resolveRouteStopCoords,
  formatArrivalDisplay,
  formatTime,
  prefetchRouteGeometry,
  trackingNowMs,
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
  pointAtCumDist,
  positionFromEtaChain,
  sanitizeEtaChain,
  resolveActiveBoardingEta,
  haversineMeters,
} from "./estimate.js";
import {
  startGeolocation,
  getLastPosition,
  onPositionChange,
} from "./geo.js";
import {
  ROUTE_COLORS,
  initMapStage,
  showFocusPanel,
  hideFocusPanel,
  updateYouMarker,
  updateBusMarker,
  dissolveBusMarker,
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
const addFlowStepRouteEl = document.getElementById("add-flow-step-route");
const addFlowStepDirectionEl = document.getElementById("add-flow-step-direction");
const addFlowStepPickingEl = document.getElementById("add-flow-step-picking");
const addFlowStepConfirmEl = document.getElementById("add-flow-step-confirm");
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
const addConfirmLabelEl = document.getElementById("add-confirm-label");
const addConfirmBtnEl = document.getElementById("add-confirm-btn");
const addToastEl = document.getElementById("add-toast");
const SORT_DEBOUNCE_MS = 2_000;
const SWIPE_ACTION_WIDTH = 76;
const SWIPE_AXIS_THRESHOLD = 12;
const SWIPE_OPEN_RATIO = 0.4;

let watchlist = loadWatchlist();
let watchlistIndex = buildWatchlistIndex(watchlist);

let refreshTimer = null;
let countdownTimer = null;
let nextRefreshAt = 0;
let isRefreshing = false;
let focusedIds = [];
let focusToken = 0;
let lastEtaById = new Map();
let animFrame = null;
let didPrefetch = false;
let stopCoordsById = new Map();
let sortTimer = null;
let lastSortedOrderKey = "";
/** @type {Map<string, object>} */
let focusEstimates = new Map();
let lastFocusFullRefreshAt = 0;

let routeCatalog = [];
let suggestionBlurTimer = null;
let addState = {
  step: "idle",
  route: "",
  direction: null,
  routeMeta: null,
  selectedStop: null,
  loadToken: 0,
};
let addToastTimer = null;
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
  const clearMode = isAddFlowActive() || focusedIds.length > 1;
  btn.classList.toggle("nav-dock__add--clear", clearMode);
  if (isAddFlowActive()) {
    btn.setAttribute("aria-label", "Cancel adding route");
  } else if (focusedIds.length > 1) {
    btn.setAttribute("aria-label", "Clear selection");
  } else {
    btn.setAttribute("aria-label", "Add route");
  }
}

function selectionKey(ids = focusedIds) {
  return ids.join("|");
}

function clearBusReposition(estimate) {
  if (!estimate) return;
  estimate.repositionFromCum = null;
  estimate.repositionToCum = null;
  estimate.repositionStartedAt = null;
}

/** Raise furthest same-bus progress shown (never decreases until handoff). */
function bumpProgressHighWater(estimate) {
  if (!estimate || estimate.busCumDist == null) return;
  const prev = estimate.progressHighWaterCum;
  estimate.progressHighWaterCum =
    prev == null ? estimate.busCumDist : Math.max(prev, estimate.busCumDist);
}

/**
 * Placement floor: passed-stop floor plus capped rewind behind high water.
 * Prevents repeated ETA slips from walking the marker back to the terminus.
 */
function trackingFloor(estimate) {
  const passed = estimate?.minCumDist ?? 0;
  const highWater =
    estimate?.progressHighWaterCum ?? estimate?.busCumDist ?? 0;
  return Math.max(passed, highWater - MAX_BUS_REWIND_M);
}

function startBusReposition(estimate, toCum) {
  if (!estimate || toCum == null || estimate.busCumDist == null) return false;
  const fromCum = estimate.busCumDist;
  if (Math.abs(toCum - fromCum) < BUS_REPOSITION_MIN_M) return false;
  estimate.repositionFromCum = fromCum;
  estimate.repositionToCum = toCum;
  estimate.repositionStartedAt = performance.now();
  return true;
}

/**
 * Mark the bus as arriving and ease along the polyline onto the boarding stop
 * instead of teleporting. Returns true while a reposition animation is running.
 */
function beginArriveAtStop(estimate) {
  if (!estimate) return false;
  const stop = estimate.boardingStop;
  const boardingCum =
    estimate.boardingCumDist ??
    stop?.cumDist ??
    estimate.polyline?.[estimate.polyline.length - 1]?.cumDist;

  estimate.reason = "arriving";
  estimate.speedMPerMin = null;

  if (!stop || boardingCum == null) return false;

  // Already easing toward the boarding stop.
  if (
    estimate.repositionStartedAt != null &&
    estimate.repositionToCum != null &&
    Math.abs(estimate.repositionToCum - boardingCum) < BUS_REPOSITION_MIN_M
  ) {
    return true;
  }

  if (estimate.busCumDist != null && estimate.polyline?.length) {
    if (startBusReposition(estimate, boardingCum)) return true;
  }

  clearBusReposition(estimate);
  estimate.busCumDist = boardingCum;
  estimate.busLatLng = { lat: stop.lat, lng: stop.lng };
  bumpProgressHighWater(estimate);
  return false;
}

function easeOutCubic(t) {
  return 1 - (1 - t) ** 3;
}

/** Lerp along the polyline while a reposition animation is active. */
function tickBusReposition(estimate) {
  if (
    estimate.repositionStartedAt == null ||
    estimate.repositionFromCum == null ||
    estimate.repositionToCum == null ||
    !estimate.polyline?.length
  ) {
    return null;
  }

  const elapsed = performance.now() - estimate.repositionStartedAt;
  const t = Math.min(1, elapsed / BUS_REPOSITION_MS);
  const cum =
    estimate.repositionFromCum +
    (estimate.repositionToCum - estimate.repositionFromCum) * easeOutCubic(t);
  const point = pointAtCumDist(estimate.polyline, cum);
  if (t >= 1) clearBusReposition(estimate);
  return point;
}

/**
 * Predicted cumDist from current ETA chain / speed (tracking floor applied).
 */
function predictedCumForEstimate(estimate, nowMs) {
  if (!estimate?.polyline?.length) return null;
  const boardingCum =
    estimate.boardingCumDist ??
    estimate.boardingStop?.cumDist ??
    estimate.polyline[estimate.polyline.length - 1].cumDist;
  if (boardingCum == null) return null;

  const floor = trackingFloor(estimate);

  if (estimate.etaChain?.length >= 2) {
    const point = positionFromEtaChain(
      estimate.etaChain,
      estimate.polyline,
      nowMs,
      boardingCum,
      floor
    );
    return point?.cumDist ?? null;
  }

  if (estimate.speedMPerMin && estimate.boardEtaMs != null) {
    const minsLeft = (estimate.boardEtaMs - nowMs) / 60_000;
    if (minsLeft <= 0) return boardingCum;
    return Math.max(
      floor,
      Math.min(boardingCum, boardingCum - estimate.speedMPerMin * minsLeft)
    );
  }

  return null;
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
    if (!estimate?.polyline?.length || estimate.busCumDist == null) continue;
    if (estimate.reason === "seq-1") continue;

    const polyline = estimate.polyline;
    const boardingCum =
      estimate.boardingCumDist ??
      estimate.boardingStop?.cumDist ??
      polyline[polyline.length - 1].cumDist;

    // Keep animating arriving buses until they finish easing onto the stop.
    if (estimate.reason === "arriving") {
      const atStop =
        estimate.repositionStartedAt == null &&
        Math.abs(estimate.busCumDist - boardingCum) < BUS_REPOSITION_MIN_M;
      if (atStop) continue;
      tracks.push({ id, mode: "arrive", estimate, boardingCum });
      continue;
    }

    if (estimate.etaChain?.length >= 2) {
      tracks.push({ id, mode: "segment", estimate, boardingCum });
      continue;
    }

    if (!estimate.speedMPerMin || !estimate.boardEtaMs) continue;
    if (
      estimate.reason !== "ok" &&
      estimate.reason !== "default-speed" &&
      estimate.reason !== "segment"
    ) {
      continue;
    }

    tracks.push({
      id,
      mode: "speed",
      estimate,
      boardingCum,
      speedMPerMin: estimate.speedMPerMin,
    });
  }

  if (!tracks.length) return;

  const tick = () => {
    if (
      token !== focusToken ||
      !isFocusPanelVisible() ||
      focusedIds.length === 0
    ) {
      return;
    }

    let keepRunning = false;
    let needsHandoffRefresh = false;

    for (const track of tracks) {
      if (!focusedIds.includes(track.id)) continue;
      const estimate = focusEstimates.get(track.id) ?? track.estimate;
      const { boardingCum } = track;
      let point = null;

      const now = trackingNowMs(estimate);
      const minsLeft = (estimate.boardEtaMs - now) / 60_000;

      if (minsLeft <= 0) {
        clearBusReposition(estimate);
        needsHandoffRefresh = true;
        continue;
      }

      // Ease into the stop when under the arriving threshold (or already arriving).
      if (
        track.mode === "arrive" ||
        minsLeft <= ARRIVING_THRESHOLD_MIN ||
        estimate.reason === "arriving"
      ) {
        const stop = estimate.boardingStop;
        const animating = beginArriveAtStop(estimate);
        if (animating) {
          const repositionPoint = tickBusReposition(estimate);
          if (repositionPoint) {
            estimate.busCumDist = repositionPoint.cumDist;
            estimate.busLatLng = {
              lat: repositionPoint.lat,
              lng: repositionPoint.lng,
            };
            bumpProgressHighWater(estimate);
            updateBusMarker(track.id, {
              lat: repositionPoint.lat,
              lng: repositionPoint.lng,
            });
            keepRunning = true;
          } else if (stop) {
            estimate.busCumDist = boardingCum;
            estimate.busLatLng = { lat: stop.lat, lng: stop.lng };
            bumpProgressHighWater(estimate);
            updateBusMarker(track.id, { lat: stop.lat, lng: stop.lng });
          }
        } else if (stop && estimate.busLatLng) {
          updateBusMarker(track.id, {
            lat: estimate.busLatLng.lat,
            lng: estimate.busLatLng.lng,
          });
        }
        continue;
      }

      // Animate along the route to a revised API prediction, then resume tracking.
      const repositionPoint = tickBusReposition(estimate);
      if (repositionPoint) {
        estimate.busCumDist = repositionPoint.cumDist;
        estimate.busLatLng = {
          lat: repositionPoint.lat,
          lng: repositionPoint.lng,
        };
        bumpProgressHighWater(estimate);
        updateBusMarker(track.id, {
          lat: repositionPoint.lat,
          lng: repositionPoint.lng,
        });
        keepRunning = true;
        continue;
      }

      // Tracking floor: passed stops + capped rewind behind high water.
      const floor = trackingFloor(estimate);

      if (track.mode === "segment") {
        point = positionFromEtaChain(
          estimate.etaChain,
          estimate.polyline,
          now,
          boardingCum,
          floor
        );
        if (point && point.cumDist < boardingCum - 1) {
          keepRunning = true;
        }
      } else {
        const cum = Math.max(
          floor,
          Math.min(boardingCum, boardingCum - track.speedMPerMin * minsLeft)
        );
        point = pointAtCumDist(estimate.polyline, cum);
        if (cum < boardingCum - 1) keepRunning = true;
      }

      if (point) {
        estimate.busCumDist = point.cumDist;
        estimate.busLatLng = { lat: point.lat, lng: point.lng };
        bumpProgressHighWater(estimate);
        updateBusMarker(track.id, { lat: point.lat, lng: point.lng });
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

function applyLightweightFocusEtaUpdate(results) {
  let needsHandoff = false;
  let startedReposition = false;

  for (const { id, result } of results) {
    if (!focusedIds.includes(id)) continue;
    const estimate = focusEstimates.get(id);
    if (!estimate || result?.error) continue;

    const { active, handedOff } = resolveActiveBoardingEta(result);
    if (handedOff || !active?.eta) {
      clearBusReposition(estimate);
      needsHandoff = true;
      continue;
    }

    const boardEtaMs = new Date(active.eta).getTime();

    // Preserve tracking clock when snapshot is unchanged — resetting
    // receivedAtMs would rewind trackingNowMs by ~poll interval.
    if (
      result.snapshotMs != null &&
      result.snapshotMs !== estimate.snapshotMs
    ) {
      estimate.snapshotMs = result.snapshotMs;
      estimate.receivedAtMs = result.receivedAtMs;
    }

    // Same-bus ETA revision: update in place (full refresh only on handoff).
    estimate.boardEtaMs = boardEtaMs;

    const nowMs = trackingNowMs(estimate);
    const minsLeft = (boardEtaMs - nowMs) / 60_000;
    estimate.minutesToBoard = minsLeft > 0 ? minsLeft : null;

    if (minsLeft == null || minsLeft <= 0) {
      clearBusReposition(estimate);
      needsHandoff = true;
      continue;
    }

    if (minsLeft <= ARRIVING_THRESHOLD_MIN) {
      const stop = estimate.boardingStop;
      if (beginArriveAtStop(estimate)) {
        startedReposition = true;
      } else if (stop && estimate.busLatLng) {
        updateBusMarker(id, {
          lat: estimate.busLatLng.lat,
          lng: estimate.busLatLng.lng,
        });
      }
      continue;
    }

    if (estimate.etaChain?.length) {
      const boardingStopId = estimate.boardingStop?.stopId;
      for (const point of estimate.etaChain) {
        if (point.stopId === boardingStopId) {
          point.etaMs = boardEtaMs;
        }
      }
      estimate.etaChain = sanitizeEtaChain(estimate.etaChain);
    }

    const predicted = predictedCumForEstimate(estimate, nowMs);
    if (predicted != null && startBusReposition(estimate, predicted)) {
      startedReposition = true;
    }
  }

  if (needsHandoff) {
    refreshFocusedEstimate({ refreshUpstream: true });
  } else if (startedReposition && !animFrame) {
    startBusAnimations(focusEstimates, focusToken);
  }
}

function needsFullFocusRefresh(results) {
  if (focusedIds.length === 0 || focusEstimates.size === 0) return false;

  const snapshotChanged = focusedIds.some((id) => {
    const eta = results.find((r) => r.id === id)?.result;
    const estimate = focusEstimates.get(id);
    if (!eta || eta.error || !estimate) return true;
    return eta.snapshotMs !== estimate.snapshotMs;
  });

  const intervalElapsed =
    Date.now() - lastFocusFullRefreshAt >= FOCUS_REFRESH_INTERVAL_MS;

  return snapshotChanged || intervalElapsed;
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
  const etaPromise =
    cached?.first?.eta && cached.snapshotMs != null
      ? Promise.resolve(cached)
      : fetchEta(entry.route, entry.stopId, entry.direction);

  try {
    const eta = await etaPromise;
    const estimate = await estimateBusPosition(entry, eta, {
      denseUpstream: true,
      refreshUpstream: true,
    });
    return {
      ...estimate,
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
  return ids.map((id, colorIndex) => {
    const estimate = estimatesById.get(id);
    return {
      id,
      colorIndex: colorIndex % ROUTE_COLORS.length,
      boardingStop: estimate?.boardingStop ?? null,
      busLatLng: estimate?.busLatLng ?? null,
      busAppearing: Boolean(estimate?.busAppearing),
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

  if (token !== focusToken || selectionKey() !== key) return;

  const estimatesById = new Map(estimates.filter(([, e]) => e));
  focusEstimates = estimatesById;
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
  focusEstimates.clear();
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

  const token = focusToken;
  const ids = [...focusedIds];
  const key = selectionKey(ids);

  try {
    const estimates = await Promise.all(
      ids.map(async (id) => {
        const entry = watchlist.find((e) => e.id === id);
        const eta = lastEtaById.get(id);
        if (!entry || !eta) return [id, focusEstimates.get(id) ?? null];
        try {
          const estimate = await estimateBusPosition(entry, eta, {
            denseUpstream: true,
            refreshUpstream,
          });
          const prior = focusEstimates.get(id);
          const sameBus =
            prior?.busLatLng &&
            estimate &&
            !estimate.busChanged &&
            estimate.reason !== "no-eta";

          // Preserve tracking clock when snapshot is unchanged so a timed
          // full refresh does not rewind trackingNowMs.
          if (
            sameBus &&
            prior.snapshotMs != null &&
            estimate.snapshotMs === prior.snapshotMs &&
            prior.receivedAtMs != null
          ) {
            estimate.receivedAtMs = prior.receivedAtMs;
          }

          // Same bus: keep marker at prior spot and animate along the route
          // to the new prediction (forward or capped back) instead of teleporting.
          if (
            sameBus &&
            prior.busCumDist != null &&
            estimate.busCumDist != null
          ) {
            const rawTargetCum = estimate.busCumDist;
            const rawTargetLatLng = estimate.busLatLng;
            estimate.progressHighWaterCum = prior.progressHighWaterCum;
            estimate.busCumDist = prior.busCumDist;
            estimate.busLatLng = prior.busLatLng;
            bumpProgressHighWater(estimate);
            const targetCum = Math.max(
              trackingFloor(estimate),
              rawTargetCum
            );
            let targetLatLng = rawTargetLatLng;
            if (targetCum !== rawTargetCum && estimate.polyline?.length) {
              const p = pointAtCumDist(estimate.polyline, targetCum);
              if (p) targetLatLng = { lat: p.lat, lng: p.lng };
            }
            if (!startBusReposition(estimate, targetCum) && targetLatLng) {
              estimate.busCumDist = targetCum;
              estimate.busLatLng = targetLatLng;
              bumpProgressHighWater(estimate);
            }
          } else if (sameBus && !estimate.busLatLng && prior.busLatLng) {
            estimate.busLatLng = prior.busLatLng;
            estimate.busCumDist = prior.busCumDist;
            estimate.progressHighWaterCum = prior.progressHighWaterCum;
            bumpProgressHighWater(estimate);
            estimate.speedMPerMin =
              estimate.speedMPerMin ?? prior.speedMPerMin;
          }
          return [id, estimate];
        } catch {
          return [id, focusEstimates.get(id) ?? null];
        }
      })
    );

    if (token !== focusToken || selectionKey() !== key) return;

    const dissolveIds = [];
    const appearIds = new Set();
    for (const [id, estimate] of estimates) {
      if (!estimate) continue;
      const prior = focusEstimates.get(id);
      if (!prior?.busLatLng) {
        if (estimate.busChanged && estimate.busLatLng) appearIds.add(id);
        continue;
      }
      const cleared = !estimate.busLatLng;
      // Dissolve only on true bus handoff — ETA revisions keep the marker.
      const changed = Boolean(estimate.busChanged);
      if (cleared || changed) {
        dissolveIds.push(id);
        if (estimate.busLatLng) appearIds.add(id);
      }
    }

    if (dissolveIds.length) {
      stopBusAnimation();
      for (const id of dissolveIds) {
        clearBusReposition(focusEstimates.get(id));
      }
      await Promise.all(dissolveIds.map((id) => dissolveBusMarker(id)));
      if (token !== focusToken || selectionKey() !== key) return;
    }

    const estimatesById = new Map(
      estimates
        .filter(([, e]) => e)
        .map(([id, estimate]) => [
          id,
          appearIds.has(id)
            ? { ...estimate, busAppearing: true, busChanged: false }
            : { ...estimate, busChanged: false },
        ])
    );
    for (const estimate of estimatesById.values()) {
      bumpProgressHighWater(estimate);
    }
    focusEstimates = estimatesById;
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
  addFlowEl?.classList.remove("add-flow--suggestions-open");
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
      return `<li role="option"><button type="button" class="add-flow__suggestion" data-route="${route}">${route}<span class="add-flow__suggestion-dest">${dest}</span></button></li>`;
    })
    .join("");
  addRouteSuggestionsEl.hidden = false;
  addFlowEl?.classList.add("add-flow--suggestions-open");
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
  hideRouteSuggestions();
  addRouteInputEl.value = route;
  validateAndLoadRoute(route);
}

function yieldToPaint() {
  return new Promise((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}

async function prefetchWatchlistGeometry() {
  if (didPrefetch) return;
  didPrefetch = true;

  await prefetchLeaflet();
  await prefetchRouteCatalog();

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

async function refreshAll() {
  if (isRefreshing) return;
  isRefreshing = true;

  ensureRows();
  cardsEl.querySelectorAll(".row").forEach((row) => {
    row.classList.add("row--loading");
  });

  const results = await Promise.all(
    watchlist.map(async (entry) => ({
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
  paintNextRefreshCountdown();
  isRefreshing = false;

  if (focusedIds.length > 0) {
    if (needsFullFocusRefresh(results)) {
      refreshFocusedEstimate({ refreshUpstream: true });
    } else {
      applyLightweightFocusEtaUpdate(results);
    }
  }

  scheduleIdle(prefetchWatchlistGeometry);
}

function paintNextRefreshCountdown() {
  if (!nextRefreshEl) return;
  if (!nextRefreshAt) {
    nextRefreshEl.hidden = true;
    nextRefreshEl.textContent = "";
    return;
  }
  const secs = Math.max(0, Math.ceil((nextRefreshAt - Date.now()) / 1000));
  nextRefreshEl.hidden = false;
  nextRefreshEl.textContent = secs === 0 ? "refreshing…" : `next ${secs}s`;
}

function startCountdownTick() {
  if (countdownTimer) clearInterval(countdownTimer);
  paintNextRefreshCountdown();
  countdownTimer = setInterval(paintNextRefreshCountdown, 250);
}

function scheduleNextRefreshAt(fromMs = Date.now()) {
  nextRefreshAt = fromMs + REFRESH_INTERVAL_MS;
  paintNextRefreshCountdown();
}

function startAutoRefresh() {
  if (refreshTimer) clearInterval(refreshTimer);
  scheduleNextRefreshAt();
  startCountdownTick();
  refreshTimer = setInterval(() => {
    scheduleNextRefreshAt();
    refreshAll();
  }, REFRESH_INTERVAL_MS);
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

function updateConfirmLabel() {
  const { route, direction, routeMeta, selectedStop } = addState;
  if (!route || !direction || !selectedStop) {
    addConfirmLabelEl.textContent = "";
    addConfirmBtnEl.disabled = true;
    return;
  }

  const duplicate = hasEntry(watchlist, {
    route,
    stopId: selectedStop.stopId,
    direction,
  });

  if (duplicate) {
    addConfirmBtnEl.disabled = true;
    addConfirmLabelEl.textContent = `${selectedStop.nameEn} — already on your list`;
    return;
  }

  addConfirmBtnEl.disabled = false;
  const dest = routeDestForDirection(routeMeta, direction);
  addConfirmLabelEl.textContent = `${route} toward ${dest} · ${selectedStop.nameEn}`;
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

function paintAddFlowStep() {
  const step = addState.step;
  addFlowStepRouteEl.hidden = step !== "route";
  addFlowStepDirectionEl.hidden = step !== "direction";
  addFlowStepPickingEl.hidden = step !== "picking";
  addFlowStepConfirmEl.hidden = step !== "confirm";

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
    route: "",
    direction: null,
    routeMeta: null,
    selectedStop: null,
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
  updateConfirmLabel();
  addFlowEl.hidden = true;
  paintAddFlowStep();
}

function cancelAddFlow() {
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

async function startAddFlow() {
  closeAllSwipeRows();
  if (isFocusPanelVisible()) {
    exitFocus();
  }

  resetAddState();
  addState.step = "route";
  addFlowEl.hidden = false;
  paintAddFlowStep();

  await yieldToPaint();
  if (!isAddFlowActive()) return;

  addRouteInputEl.focus();
  startGeolocation();
  prefetchRouteCatalog();
}

async function validateAndLoadRoute(routeValue) {
  const route = routeValue.trim().toUpperCase();
  hideRouteSuggestions();

  if (!route) {
    addState.route = "";
    addState.routeMeta = null;
    addState.direction = null;
    addState.selectedStop = null;
    addState.step = "route";
    setDirectionButtons(null);
    updateDirectionLabels(null);
    setAddError("");
    updateConfirmLabel();
    paintAddFlowStep();
    return;
  }

  setAddError("");
  try {
    const meta = await fetchRouteMeta(route);
    if (!isAddFlowActive()) return;
    addState.route = meta.route;
    addState.routeMeta = meta;
    addState.direction = null;
    addState.selectedStop = null;
    addState.step = "direction";
    updateDirectionLabels(meta);
    setDirectionButtons(null);
    updateConfirmLabel();
    paintAddFlowStep();
  } catch {
    if (!isAddFlowActive()) return;
    addState.route = "";
    addState.routeMeta = null;
    addState.direction = null;
    addState.selectedStop = null;
    addState.step = "route";
    setDirectionButtons(null);
    updateDirectionLabels(null);
    setAddError(`Route ${route} not found`);
    updateConfirmLabel();
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
  updateConfirmLabel();
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
        addState.step = "confirm";
        setAddError("");
        updateConfirmLabel();
        paintAddFlowStep();
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
      setAddError("Already on your list");
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
  await refreshAll();
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
  refreshAll();

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
refreshAll();
startAutoRefresh();
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
    refreshAll();
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
  if (focusedIds.length > 1) {
    exitFocus();
    return;
  }
  startAddFlow();
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
    hideRouteSuggestions();
    validateAndLoadRoute(addRouteInputEl.value);
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

addRouteSuggestionsEl?.addEventListener("pointerdown", (event) => {
  const btn = event.target.closest(".add-flow__suggestion");
  if (!btn) return;
  event.preventDefault();
  selectRouteSuggestion(btn.dataset.route);
});

addDirOutboundEl?.addEventListener("click", () => {
  loadAddPickForDirection("O");
});

addDirInboundEl?.addEventListener("click", () => {
  loadAddPickForDirection("I");
});

addConfirmBtnEl?.addEventListener("click", () => {
  confirmAddEntry();
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
    event.target.closest(".add-toast")
  ) {
    return;
  }
  refreshAll();
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && isAddFlowActive()) {
    cancelAddFlow();
  }
});
