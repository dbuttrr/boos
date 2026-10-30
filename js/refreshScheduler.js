import {
  FOCUSED_ETA_REFRESH_INTERVAL_MS,
  WATCHLIST_REFRESH_INTERVAL_MS,
} from "./config.js";

/**
 * Independent request-start deadlines for each watchlist entry. Focused entries
 * are checked more often; response timestamps never change either cadence.
 * In-flight entries are excluded from timers until their request settles.
 */
export function createRefreshScheduler({
  getEntryIds,
  getFocusedIds,
  onRefresh,
  isActive,
  onCountdown,
}) {
  const entries = new Map();
  const inFlight = new Map();
  let enabled = false;
  let timerId = null;

  function canRun() {
    return enabled && isActive();
  }

  function clearTimer() {
    if (timerId != null) {
      clearTimeout(timerId);
      timerId = null;
    }
  }

  function publishCountdown(mode, nextAtMs) {
    onCountdown?.({ mode, nextAtMs });
  }

  function reconcile(nowMs) {
    const ids = new Set(getEntryIds());
    const focused = new Set(getFocusedIds());
    for (const id of entries.keys()) {
      if (!ids.has(id)) entries.delete(id);
    }
    for (const id of ids) {
      const intervalMs = focused.has(id)
        ? FOCUSED_ETA_REFRESH_INTERVAL_MS : WATCHLIST_REFRESH_INTERVAL_MS;
      const entry = entries.get(id);
      if (!entry) {
        // Re-adding an ID while its earlier check is still pending joins that
        // request too, rather than immediately repeating it on completion.
        const lastStartedAtMs = inFlight.get(id)?.startedAtMs ?? null;
        entries.set(id, {
          intervalMs,
          nextAtMs: lastStartedAtMs == null ? nowMs : lastStartedAtMs + intervalMs,
          lastStartedAtMs,
        });
      } else if (entry.intervalMs !== intervalMs) {
        if (intervalMs < entry.intervalMs && !inFlight.has(id)) {
          // Selecting a route checks it immediately without delaying any other.
          entry.nextAtMs = nowMs;
        } else {
          // An ongoing check already covers a promotion. Demotion gets a full
          // minute from its last request start, rather than another fast check.
          entry.nextAtMs = (entry.lastStartedAtMs ?? nowMs) + intervalMs;
        }
        entry.intervalMs = intervalMs;
      }
    }
  }

  function scheduleNext() {
    clearTimer();
    if (!canRun()) {
      publishCountdown("idle", null);
      return;
    }

    let nextAtMs = null;
    let refreshing = false;
    for (const [id, entry] of entries) {
      if (inFlight.has(id)) {
        refreshing = true;
      } else if (nextAtMs == null || entry.nextAtMs < nextAtMs) {
        nextAtMs = entry.nextAtMs;
      }
    }

    if (nextAtMs != null) {
      timerId = setTimeout(() => {
        timerId = null;
        tick();
      }, Math.max(0, nextAtMs - Date.now()));
    }
    publishCountdown(refreshing ? "refreshing" : "idle",
      refreshing ? Date.now() : nextAtMs);
  }

  function launch(ids, nowMs) {
    const batch = { promise: null, startedAtMs: nowMs };
    for (const id of ids) {
      const entry = entries.get(id);
      entry.lastStartedAtMs = nowMs;
      entry.nextAtMs = nowMs + entry.intervalMs;
      inFlight.set(id, batch);
    }

    // Register every ID before invoking application code, including callbacks
    // that throw synchronously or request another refresh themselves.
    batch.promise = Promise.resolve()
      .then(() => {
        if (!canRun()) return;
        const currentIds = new Set(getEntryIds());
        const requestedIds = ids.filter((id) => currentIds.has(id));
        if (requestedIds.length) return onRefresh(requestedIds);
      })
      .catch((err) => {
        console.warn("Refresh failed:", err);
      })
      .finally(() => {
        for (const id of ids) {
          if (inFlight.get(id) === batch) inFlight.delete(id);
        }
        // Pause is authoritative. A late response must not resurrect a timer.
        if (canRun()) tick();
        else scheduleNext();
      });
    return batch.promise;
  }

  function tick() {
    const nowMs = Date.now();
    reconcile(nowMs);
    if (!canRun()) {
      scheduleNext();
      return Promise.resolve();
    }
    const due = [...entries]
      .filter(([id, entry]) => !inFlight.has(id) && entry.nextAtMs <= nowMs)
      .map(([id]) => id);
    const promise = due.length ? launch(due, nowMs) : Promise.resolve();
    scheduleNext();
    return promise;
  }

  function refreshNow() {
    if (!canRun()) return Promise.resolve([]);
    const nowMs = Date.now();
    reconcile(nowMs);
    for (const [id, entry] of entries) {
      if (!inFlight.has(id)) entry.nextAtMs = nowMs;
    }
    tick();
    // Manual checks join existing work instead of queuing a duplicate request.
    const pending = new Set([...entries.keys()]
      .map((id) => inFlight.get(id)?.promise).filter(Boolean));
    return Promise.all(pending);
  }

  function pause() {
    enabled = false;
    clearTimer();
    publishCountdown("idle", null);
  }

  function resume() {
    enabled = true;
    return refreshNow();
  }

  return {
    start: resume,
    pause,
    resume,
    refreshNow,
    notifyEntriesChanged: tick,
  };
}
