# HK Citybus ETA — Product Requirements

At a glance, see which of my usual Citybus options is worth leaving for.

## Problem

I take the same Citybus routes regularly. Before leaving, I need to know which option is arriving soon enough to be worth walking to — without opening multiple apps or digging through full route timetables.

## User

Personal use: mobile, Hong Kong, checking ETAs before leaving home or office.

## Jobs to be done

1. See the next 1–2 arrivals for each watchlisted stop + direction.
2. Know which options are realistically walkable (stops beyond ~20 min crow-flies are dimmed).
3. Compare routes on a map with estimated bus position along the road.
4. Refresh automatically and on tap; resume when returning to the tab.

## Current behavior (shipped)

### Watchlist editing

- Circular **+** (floating above the watch-sheet, outside the sheet) opens a **choice menu**: blurred full-screen backdrop with two glass bubble buttons stacked above **+** — **Find nearby** or **Enter manually**. **+** rotates to **×** while the menu or add-flow is open (tap **×**, backdrop, or Escape to dismiss the menu). **Find nearby** → stops within **500 m** on the map (pins only); tap stop → route list → add. **Enter manually** → type route → direction → tap stop on map → **✓**. **Pick another stop** returns to nearby map from the route list. Watchlist rows are not interactive during add-flow. Success shows a short toast above the anchor. While **two or more** routes are focused, **+** becomes clear-all **×** (scale pulse + slight red tint); with zero or one focused it stays **+**.
- Stop catalog is a bundled static file (`data/stops-index.json`, ~2.5k CTB stops); regenerate via `node scripts/build-stops-index.mjs` when stops change. Routes at a stop come from data.gov.hk v1.1 `stop-route` (CTB only).
- Add-flow paints immediately; route catalog stays in memory (idle-prefetched). Typing shows up to 8 prefix-matched suggestions in a liquid-glass dropdown **above** the route input (inset to match input width) — no full-route datalist in the DOM.
- Main map shows OSRM road-snapped route polyline (stop-to-stop first, then upgraded), all stops on that direction, and your location when available; viewport auto-fits the path above the watch-sheet.
- Added routes persist in browser localStorage; `js/config.js` seeds the list on first visit.
- Swipe a row left to reveal Delete (iOS-style); tap Delete and confirm to remove. Only one row can be open at a time; vertical list scroll is preserved via axis lock.

### ETA list

- Watchlist from localStorage, seeded from `js/config.js` on first visit.
- Each row shows route label, primary ETA, and secondary ETA when available.
- Remarks (e.g. "No scheduled service") shown when API returns no upcoming ETA.
- Errors shown inline per row.
- Auto-refresh every 5 seconds (`REFRESH_INTERVAL_MS`); last-updated plus a countdown float over the top of the watch-sheet (plain text, no pill) — `backdrop-filter` blurs list rows only as they scroll underneath.
- Tap outside rows (empty watch-sheet padding) to refresh manually.
- Refreshes when tab becomes visible again.

### Location-aware sorting

- Requests browser geolocation on load.
- Sorts rows by straight-line distance to boarding stop (debounced 2 s on position updates).
- Rows beyond `MAX_WALK_MINUTES` (20) crow-flies distance get `row--far` styling.

### Focus map

- Full-bleed Leaflet map fills the viewport; watchlist sits in a more transparent liquid-glass sheet (`.watch-sheet`, `--watch-sheet-glass`) over the bottom half, inset equally on left/right/bottom (`0.75rem`; home-indicator safe-area ignored so the bottom gutter matches the sides). The sheet is scrollable list only; last-updated + “next Ns” countdown float as plain text (`.watch-sheet__status`) over the top — rows blur behind the text as they scroll under.
- Idle (no row selected): Maps/Uber-style GPS follow — the you marker always tracks GPS, but the map recenters into the **top-half** active area only when you leave a soft follow window (`IDLE_FOLLOW_WINDOW` in `config.js`). Falls back to `LOCATION` in `config.js` until a fix arrives. You marker is slightly larger (36px hit area) for glanceability.
- Tap a row to focus (tap again to deselect): map auto-fits your location, the boarding stop(s), and the estimated bus(es) into the top-half active area (asymmetric `fitBounds` padding / pan offset so the glass sheet does not cover framed markers) — deferred until layout settles so Leaflet has a real size. Each focused boarding stop shows a simple glass name bubble above the pin; text after the first comma wraps to a second, quieter line; if several focused routes share the same stop, only one label is shown.
- Any number of routes can be focused at once; row/map colors cycle through a 6-color `ROUTE_COLORS` palette (blue, yellow, green, coral, violet, teal).
- While **two or more** routes are focused, the **+** morphs into a clear **×** (rotate + scale pulse, slight red background); tapping it deselects all focused routes and returns to idle GPS follow. With a single focused route the control stays **+** (tap the row to deselect).
- Focus always shows the "you" marker when geolocation is available; road-following route polylines; estimated bus positions with smooth animation between polls. Multi-select uses slightly lower line opacity so overlapping paths stay readable.
- Deselecting the last focused row returns to idle GPS follow (map stays visible).
- Bus position derived from upstream stop ETAs + OSRM road-snapped polylines.
- Focus map syncs tracking clock to Citybus `data_timestamp` / `generated_timestamp` (not raw device time).
- Focus map fetches ETAs at all upstream approach stops and interpolates position along the active stop-to-stop segment.
- Upstream ETAs are matched to the boarding bus with travel-time plausibility (implied speed ≤ `MAX_BUS_SPEED_M_PER_MIN`) and the earliest-before-boarding candidate — not latest — so a following bus on busy routes (e.g. 8X) cannot park the marker far upstream.
- ETA chains are sanitized for time-vs-distance monotonicity so terminus schedule noise does not pin the bus marker at the origin.
- When still “before” the first chain ETA (often a stale terminus departure), placement also considers boarding ETA × clamped speed so the marker is not stuck at cumDist 0 while the bus is mid-route; implausible first→next segment speeds fall back to `DEFAULT_BUS_SPEED_M_PER_MIN`.
- Placement is floored at upstream stops the bus has already passed, so missing mid-route ETAs cannot snap the marker back to the terminus.
- When a fresh Citybus ETA revises the predicted position (earlier or later), the marker animates along the route polyline to the new spot over `BUS_REPOSITION_MS` (1.2 s), then resumes normal clock-based tracking — no freeze, teleport, or dissolve for same-bus revisions.
- Same-bus ETA revisions may rewind the marker at most `MAX_BUS_REWIND_M` (400 m) behind the furthest progress shown (`progressHighWaterCum`); repeated ETA slips cannot walk the marker back to the terminus.
- Lightweight boarding ETA updates re-sanitize the cached ETA chain between full focus refreshes; when boarding ETA drops to `ARRIVING_THRESHOLD_MIN` (1 min), the marker eases along the route onto the boarding stop via `beginArriveAtStop` / `startBusReposition` (same as the rAF loop) without waiting for the next full refresh.
- Lightweight updates must not rewind `trackingNowMs`: when Citybus `snapshotMs` is unchanged, `receivedAtMs` is left alone so the 5 s poll cannot reset the animation clock. Same-bus boarding ETA revisions update in place and may start a reposition animation; full refresh runs only on real handoff, `snapshotMs` change, or `FOCUS_REFRESH_INTERVAL_MS`.
- Row refresh (5 s) updates boarding ETA on the map estimate in place; full map re-estimate + repaint runs when Citybus `snapshotMs` changes or every `FOCUS_REFRESH_INTERVAL_MS` (60 s). Full refresh with an unchanged `snapshotMs` also preserves `receivedAtMs` so a timed re-estimate does not rewind the clock. Same-bus full refresh keeps the marker and animates to the new prediction.
- Upstream stop ETAs cached for `UPSTREAM_ETA_CACHE_TTL_MS` (60 s) between full focus refreshes.
- Bus marker animates continuously via rAF between full re-estimates (not driven by 5 s row poll); once ETA is under `ARRIVING_THRESHOLD_MIN`, the rAF loop eases the marker into the boarding stop along the polyline instead of teleporting.
- When the tracked bus’s boarding ETA is past the tracking clock, the marker freezes in place for a CSS Thanos-style sand dissolve (reposition/rewind cleared; position updates ignored while `focus-marker--dissolving`), then tracking hands off to the next upcoming ETA (`second`); if none, the marker clears. Soft-appear on the new bus.
- Background prefetch of route geometry, OSRM cache, Leaflet, and route catalog after idle.

### Theme

- Light/dark mode via a vertical sun/moon control in the map top-right (replaces the old zoom +/- slot); auto-schedules by Hong Kong sunrise/sunset when no manual preference saved. The centered **+** / clear **×** stays above the watch-sheet.
- Dark mode keeps a quieter top-left glass highlight (`--focus-glass-highlight`, `--glass-sheen`) so the watch-sheet and rows don’t look overly shiny.
- Map tiles and row focus colors follow theme.
- Home-screen / tab icon: blue bus matching the map marker (route color A) on light `#eef1f6` (`favicon.svg`, `favicon-32.png`, `apple-touch-icon.png`).

### Data & caching

- Citybus V2 API (`rt.data.gov.hk`) called directly from browser.
- In-memory and localStorage caches for stops, routes, route geometry, ETAs, OSRM routes.
- Bundled CTB stop catalog (`data/stops-index.json`) for nearby add-flow.
- OSRM (`router.project-osrm.org`) for road-snapped polylines.
- Leaflet + CARTO basemap for map rendering.

## Constraints

- Static site only — no backend, no build step, no framework.
- Citybus (CTB) only via data.gov.hk API.
- Watchlist in localStorage; `js/config.js` provides defaults on first visit.
- Geolocation optional — app works without it (config order, no walkability dimming; nearby add-flow falls back to `LOCATION`).
- Third-party: OSRM, Leaflet, CARTO tiles.

## Non-goals

- Multi-user accounts or sync
- KMB, NWFB, or other operators
- Full trip planning or multi-leg journeys
- Push notifications or background refresh
- Native mobile app wrapper

## Backlog

### Next

- [ ] Per-row stale/error indicator when API fails repeatedly
- [ ] Clearer empty state when geolocation denied (nearby add-flow shows config `LOCATION` fallback; dedicated denied UX still open)

### Later

- [ ] Offline / last-known ETA display from cache
- [ ] Walking time via OSRM instead of crow-flies cutoff for `row--far`

## Open questions

- Should refresh interval stay at 5 s or back off when tab hidden?
- Worth a public demo watchlist separate from personal `config.js`?

## Maintenance (for agents)

When shipping user-visible behavior or convention changes, update this file **in the same turn as the code** — do not wait for the user to ask.

1. Check off or remove backlog item; add bullets under **Current behavior**
2. Update **Constraints** if `js/config.js` defaults changed
3. Update the matching `.cursor/rules/*.mdc` (see [workflow.mdc](../.cursor/rules/workflow.mdc))

## Related docs

- Setup, deploy, stop IDs: [README.md](../README.md)
- Agent conventions: [AGENTS.md](../AGENTS.md)
- Ship checklist: [.cursor/rules/workflow.mdc](../.cursor/rules/workflow.mdc)
