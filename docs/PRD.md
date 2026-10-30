# HK Citybus ETA — Product Requirements

At a glance, see which of my usual Citybus options is worth leaving for.

## Problem

I take the same Citybus routes regularly. Before leaving, I need to know which option is arriving soon enough to be worth walking to — without opening multiple apps or digging through full route timetables.

## User

Personal use: mobile, Hong Kong, checking ETAs before leaving home or office.

## Jobs to be done

1. See the next 1–2 arrivals for each watchlisted stop + direction.
2. Know which options are realistically walkable (stops beyond ~20 min crow-flies are dimmed).
3. Compare routes on a map with a predicted bus marker plus a smooth nerve pulse on the bus's current leg.
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
- Tiered auto-refresh (`js/refreshScheduler.js`): every focused watchlist entry is checked every `FOCUSED_ETA_REFRESH_INTERVAL_MS` (12 s); other entries every `WATCHLIST_REFRESH_INTERVAL_MS` (60 s). Deadlines are measured from each request's start, independently of source timestamps, so missed snapshots cannot stretch the polling interval. Due entries are fetched together, with in-flight requests for the same entry coalesced. Newly added or focused entries are checked immediately; demotion returns an entry to its minute interval without delaying unrelated entries. Status overlay shows the earliest `next check Ns` while idle and `refreshing…` while requests run. A focused-only partial check is labeled `Checked focused HH:mm`; other batches use `Checked HH:mm`, so a focused refresh does not imply that every row was checked. Pauses while the tab is hidden; returning or manually refreshing checks all current entries immediately. ETA requests use `ETA_REQUEST_TIMEOUT_MS` (8 s); network and browser delays can affect completion times. Last-check label plus countdown float over the top of the watch-sheet as plain overlay text; `#cards` uses a scroll-aware `mask-image` edge fade (`--watch-sheet-scroll-fade`) — top crisp at rest, both edges mid-scroll, bottom crisp at end; no tint/blur frost behind the status.
- Tap outside rows (empty watch-sheet padding) to refresh manually.
- Refreshes when tab becomes visible again (scheduler resumes).

### Location-aware sorting

- Requests browser geolocation on load.
- Sorts rows by straight-line distance to boarding stop (debounced 2 s on position updates).
- Rows beyond `MAX_WALK_MINUTES` (20) crow-flies distance get `row--far` styling.

### Focus map

- Full-bleed Leaflet map fills the viewport; watchlist sits in a more transparent liquid-glass sheet (`.watch-sheet`, `--watch-sheet-glass`) over the bottom half, inset equally on left/right/bottom (`0.75rem`; home-indicator safe-area ignored so the bottom gutter matches the sides). The sheet is scrollable list only; last-updated + “next Ns” countdown float in `.watch-sheet__status` as plain overlay text over the list (no frost band).
- Idle (no row selected): Maps/Uber-style GPS follow — the you marker always tracks GPS, but the map recenters into the **top-half** active area only when you leave a soft follow window (`IDLE_FOLLOW_WINDOW` in `config.js`). Falls back to `LOCATION` in `config.js` until a fix arrives. You marker is slightly larger (36px hit area) for glanceability.
- Tap a row to focus (tap again to deselect): map auto-fits your location, the boarding stop(s), the bus marker(s), and the approach nerve pulse into the top-half active area (asymmetric `fitBounds` padding / pan offset so the glass sheet does not cover framed markers) — deferred until layout settles so Leaflet has a real size. Each focused boarding stop shows a simple glass name bubble above the pin; text after the first comma wraps to a second, quieter line; if several focused routes share the same stop, only one label is shown.
- Any number of routes can be focused at once; row/map colors cycle through a 6-color `ROUTE_COLORS` palette (blue, yellow, green, coral, violet, teal).
- While **two or more** routes are focused, the **+** morphs into a clear **×** (rotate + scale pulse, slight red background); tapping it deselects all focused routes and returns to idle GPS follow. With a single focused route the control stays **+** (tap the row to deselect).
- Focus always shows the "you" marker when geolocation is available; road-following route polylines; a **bus marker** at the predicted position along the approach line (ETA chain / speed fallback); and a **nerve pulse** on the **current stop-to-stop leg** whenever the bus is trackable: dim pearl fiber on the full leg with uniform bright dashes flowing steadily across the remaining bus-to-next-stop section. Multi-select uses slightly lower line opacity so overlapping paths stay readable.
- Deselecting the last focused row returns to idle GPS follow (map stays visible).
- Bus placement derived from upstream stop ETAs + OSRM road-snapped polylines — predicted position along the route, not a GPS fix.
- Full route geometry retains OSRM leg/step boundaries in stop order, including repeated roads and later visits to the same coordinates. Leg endpoints are checked within 2 m of their corresponding snapped waypoints to accommodate small OSRM discrepancies while retaining actual ordered step geometry. Each resolved stop occurrence maps to its own boundary index; the approach is the prefix of that same full route ending at the selected boarding occurrence. All waypoints remain present on long routes through overlapping chunks of at most 25 stops. A failed or malformed chunk falls back to straight segments between its ordered stops.
- A stop ID appearing once in the selected route direction maps directly to that physical stop, even when API ETA `seq` differs from route-stop `seq` or is missing. Repeated visits use canonical route-stop sequences internally. Their API sequence offset must first be calibrated from at least two distinct, unambiguous physical stop anchors; all valid sequence values in those observations must agree, including when the offset is zero. A unique boarding stop can be an anchor; up to two additional unique route stops may be requested for calibration. Extra calibration-only anchors do not enter the position chain.
- Repeated boarding visits require both a valid active ETA sequence and that verified offset. Missing or conflicting calibration leaves the full route and physical stop pin visible but hides the bus marker and pulse (`ambiguous-stop`); it never chooses the first visit or assumes raw API and canonical sequences match. Unresolved repeated upstream visits remain unknown and are excluded. The watchlist still stores route + stop ID + direction without an explicit occurrence choice. Missing coordinates at another stop do not shift a resolved boarding occurrence.
- If the resolved approach has no positive distance, including when all upstream coordinates are missing or every resolved stop shares one location, the bus marker and pulse are hidden instead of placing the bus at boarding.
- Marker and approach pulse share one bus placement. The pulse spans the **current physical stop-to-stop leg**, including stops whose ETAs are missing; an exact stop boundary starts the next leg. The bright dashed section starts at the displayed bus and ends at the next stop. Individual dashes shorten and their gaps tighten as the bus approaches that stop. Dash motion uses a separate animation clock.
- ETA revisions ease the displayed bus along the same ordered road geometry over `BUS_POSITION_BLEND_MS` (5 s). The new ETA model continues advancing during the transition; the display reaches that model exactly when the correction finishes. Another revision starts from the current displayed position, while an unchanged position model or metadata-only refresh keeps the existing transition. Initial full-refresh painting and rAF updates share this displayed placement with the pulse.
- Display continuity resets on detected bus handoff, an expired previous boarding ETA, an ETA revision of at least `BUS_POSITION_MAX_ETA_SHIFT_MS` (5 min), changed geometry or boarding occurrence, unavailable/ambiguous placement, deselection, or backgrounding/resume. Corrections stay within route bounds and may move backward. This presentation state does not alter ETA chains, passed-stop evidence, or raw position inference; vehicle association remains heuristic.
- `trackingNowMs()` uses the device's current wall time for absolute ETAs. Citybus `data_timestamp` / `generated_timestamp` describe source freshness; receiving an old or repeated snapshot does not reset the tracking clock or extend polling intervals. An accurate device clock is required.
- Focus map fetches ETAs at all upstream approach stops, including during the final minute before boarding; `resolveBusPlacement()` interpolates the validated ETA chain when at least two points remain, otherwise uses the speed fallback. The marker stays on the predicted road path through the final minute instead of snapping to the boarding stop's raw coordinates. There is no competing boarding-countdown position or mutable closing-speed state. `resolveApproachPulse()` receives that same placement.
- Upstream ETAs are matched to the boarding bus with travel-time plausibility (implied speed ≤ `MAX_BUS_SPEED_M_PER_MIN`) and the earliest-before-boarding candidate — not latest — so a following bus on busy routes (e.g. 8X) cannot anchor the chain far upstream.
- ETA chain validation keeps the longest physically plausible subsequence anchored at boarding. Cumulative distances must be finite, nonnegative, and strictly increasing; ETA times must be finite and strictly increasing. Every adjacent retained leg must respect `MAX_BUS_SPEED_M_PER_MIN` (600 m/min); slow traffic remains valid. Ties prefer downstream evidence.
- Before the first retained ETA, raw placement extrapolates upstream from that stop and cannot move beyond it while its ETA is still in the future. Implausible first→next segment speeds fall back to `DEFAULT_BUS_SPEED_M_PER_MIN`.
- Missing, empty, remark-only, failed, or rejected upstream ETAs leave the stop's status unknown and add no passed-stop constraint. The production lower bound stays at the route origin; validated matched ETAs determine progress, with speed fallback when no usable chain remains. Missing data supplies no vehicle identity or passage history.
- Existing estimation limits remain: upstream bus association is heuristic and no vehicle identity or bus GPS position is provided. OSRM uses a driving profile; its path does not confirm the bus's actual route, diversions, or traffic conditions.
- **Nerve pulse** (`js/pulse.js`): pearl-white fiber (`--focus-pulse-fiber` on `.focus-route-pulse-track`, weight 6, full current leg) beneath uniform rounded dashes (`.focus-route-pulse-comet`, `--focus-pulse-spark`) flowing bus → next stop (or boarding). Every dash in the stream has the same current length and gap. Individual geometric dash lengths interpolate from 18 px at 300 m or farther to 3 px at 20 m or nearer; visible gaps interpolate from 10 px to 3 px over the same range. Lengths and gaps scale with map zoom, with a minimum visible gap of 1.5 px and fixed 3.5 px stroke width. Round caps add the stroke width to the painted dash length. Dashes stay inside the remaining section, including their caps; very short remaining screen-pixel sections hide the stream. Physical leg bounds and predicted bus placement are unchanged.
- Dash motion advances at a steady 28 screen px/s at the reference zoom, scaled with map zoom. Each route preserves its phase within one dash spacing as lengths, gaps, or styling change. Full ETA overlay repaints retain the pulse layers and phase for unchanged active legs; dropped or unavailable routes clear their streams, and a new physical leg resets phase. Repaint applies current remaining metres without advancing animation time. Dashes enter at the bus and leave at the next stop; there is no whole-trail return or loop fade. Equal dash/gap pairs plus a final gap beyond the path prevent a repeated pattern behind the bus. Unclipped pulse polylines (`noClip: true`) keep panning from changing measured path length; geometry, actual map zoom, and projected SVG `d` path changes refresh measurements even when visual zoom scaling is clamped. Stable frames do not remeasure path length. `map.js` delegates to `createPulseController()` via `ensureActiveSegmentGeometry` and rAF `updateActiveSegmentMotion`. Appearance and handoff retain the existing layer fades. `prefers-reduced-motion` keeps the same dashed stream stationary.
- Lightweight boarding ETA updates re-sanitize the cached ETA chain between full focus refreshes.
- Lightweight updates retain the latest `snapshotMs` / `receivedAtMs` metadata, including receive time for a repeated snapshot, without affecting the wall-time tracking clock. Boarding ETA changes revalidate the cached chain; handoff triggers a full refresh. The occurrence-change guard compares incoming raw API sequences with `boardingStop.apiSeq`, keeping them separate from canonical route-stop sequence numbers. Changed sequences, including transitions between known and unknown values, trigger full re-estimation.
- Focused ETA checks update the boarding ETA and its fetch metadata promptly. A changed source snapshot, active boarding ETA time or sequence, handoff, or the `FOCUS_REFRESH_INTERVAL_MS` (60 s) fallback triggers a full upstream re-estimate; unchanged position data uses lightweight updates rather than fetching every upstream stop every 12 s. Partial batches do not treat unchecked focused entries as missing responses. Failed ETA checks show a row error while retaining the last successful source and displayed estimate until its boarding ETA expires. Initial and full async geometry results must still match the current position-relevant ETA source before painting; a repeated observation with only new receive/generated metadata does not invalidate ongoing geometry work. Full refresh retains the actual fetch metadata without preserving an artificial clock offset.
- Upstream stop ETAs cached for `UPSTREAM_ETA_CACHE_TTL_MS` (60 s) between full focus refreshes.
- Bus marker and nerve pulse update continuously via rAF between full re-estimates, independently of the ETA polling intervals.
- When the tracked bus’s boarding ETA is past the tracking clock, the pulse fades out and the bus marker clears; tracking hands off to the next upcoming ETA (`second`); if none, overlays clear.
- Background prefetch of route geometry, OSRM cache, Leaflet, and route catalog after idle.

### Theme

- Light/dark mode via a vertical sun/moon control in the map top-right (replaces the old zoom +/- slot); auto-schedules by Hong Kong sunrise/sunset when no manual preference saved. The centered **+** / clear **×** stays above the watch-sheet.
- Dark mode keeps a quieter top-left glass highlight (`--focus-glass-highlight`, `--glass-sheen`) so the watch-sheet and rows don’t look overly shiny.
- Map tiles and row focus colors follow theme. The configured CARTO base tiles use native light/dark styles; the keyless OpenStreetMap fallback uses a dark-mode filter applied only to the tile layer.
- Home-screen / tab icon: blue bus matching the map marker (route color A) on light `#eef1f6` (`favicon.svg`, `favicon-32.png`, `apple-touch-icon.png`).

### Data & caching

- Citybus V2 API (`rt.data.gov.hk`) called directly from browser.
- Stop/route metadata and OSRM routes use memory and localStorage caches. ETA responses use an in-memory cache keyed by route + stop ID + direction + optional raw API sequence, keeping filtered repeated visits and unfiltered unique-stop observations separate. Concurrent ETA requests for the same physical route + stop share one raw response; direction and occurrence filtering still run independently for each caller.
- Bundled CTB stop catalog (`data/stops-index.json`) for nearby add-flow.
- OSRM (`router.project-osrm.org`) for ordered road-snapped polylines. The `bus:osrm:v3` cache stores points plus one boundary index per input stop occurrence for seven days; old point-only cache entries are not reused. Only validated routed chunks are cached. Failed or malformed chunks retain ordered stop-to-stop fallback geometry and are retried on later requests.
- Leaflet with CARTO's native light/dark raster tiles using the configured `CARTO_BASEMAP_API_KEY` in `js/config.js`; tile requests include the encoded key. Clearing the key selects standard OpenStreetMap raster tiles without registration. Provider attribution stays visible and wraps above the watch-sheet.

## Constraints

- Static site only — no backend, no build step, no framework.
- Citybus (CTB) only via data.gov.hk API.
- Watchlist in localStorage; `js/config.js` provides defaults on first visit.
- Geolocation optional — app works without it (config order, no walkability dimming; nearby add-flow falls back to `LOCATION`).
- Third-party: OSRM, Leaflet, CARTO tiles with a browser-visible Basemaps key configured by default. An empty `CARTO_BASEMAP_API_KEY` selects the keyless OpenStreetMap fallback.

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
