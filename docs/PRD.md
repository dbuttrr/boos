# HK Citybus ETA — Product Requirements

At a glance, see which of my usual Citybus options is worth leaving for.

## Problem

I take the same Citybus routes regularly. Before leaving, I need to know which option is arriving soon enough to be worth walking to — without opening multiple apps or digging through full route timetables.

## User

Personal use: mobile, Hong Kong, checking ETAs before leaving home or office.

## Jobs to be done

1. See the next 1–2 arrivals for each watchlisted stop + direction.
2. Know which options are realistically walkable (stops beyond ~20 min crow-flies are dimmed).
3. Compare 1–2 routes on a map with estimated bus position along the road.
4. Refresh automatically and on tap; resume when returning to the tab.

## Current behavior (shipped)

### Watchlist editing

- Bottom floating dock **+** opens add sheet: enter route → pick direction → tap stop on map.
- Sheet paints immediately; route catalog stays in memory (idle-prefetched). Typing shows up to 8 prefix-matched suggestions — no full-route datalist in the DOM.
- Map shows route polyline, all stops on that direction, and your location when available.
- Added routes persist in browser localStorage; `js/config.js` seeds the list on first visit.
- Long-press a row to show remove (×); confirm before delete.

### ETA list

- Watchlist from localStorage, seeded from `js/config.js` on first visit.
- Each row shows route label, primary ETA, and secondary ETA when available.
- Remarks (e.g. "No scheduled service") shown when API returns no upcoming ETA.
- Errors shown inline per row.
- Auto-refresh every 5 seconds (`REFRESH_INTERVAL_MS`).
- Tap outside rows / header to refresh manually.
- Refreshes when tab becomes visible again.

### Location-aware sorting

- Requests browser geolocation on load.
- Sorts rows by straight-line distance to boarding stop (debounced 2 s on position updates).
- Rows beyond `MAX_WALK_MINUTES` (20) crow-flies distance get `row--far` styling.

### Focus map

- Tap a row to open map panel with boarding stop pin.
- Single focus: shows "you" marker when geolocation available; road-following route polyline; estimated bus position with smooth animation between polls.
- Dual focus (up to 2 routes): side-by-side route comparison; no "you" marker.
- Third selection clears focus; deselecting last row closes panel.
- Bus position derived from upstream stop ETAs + OSRM road-snapped polylines.
- Focus map syncs tracking clock to Citybus `data_timestamp` / `generated_timestamp` (not raw device time).
- Focus map fetches ETAs at all upstream approach stops and interpolates position along the active stop-to-stop segment.
- ETA chains are sanitized for time-vs-distance monotonicity so terminus schedule noise does not pin the bus marker at the origin.
- Placement is floored at upstream stops the bus has already passed, so missing mid-route ETAs cannot snap the marker back to the terminus.
- Lightweight boarding ETA updates re-sanitize the cached ETA chain between full focus refreshes.
- Row refresh (5 s) updates boarding ETA on the map estimate in place; full map re-estimate + repaint runs when Citybus `snapshotMs` changes or every `FOCUS_REFRESH_INTERVAL_MS` (60 s).
- Upstream stop ETAs cached for `UPSTREAM_ETA_CACHE_TTL_MS` (60 s) between full focus refreshes.
- Bus marker animates continuously via rAF between full re-estimates (not driven by 5 s row poll).
- Background prefetch of route geometry, OSRM cache, Leaflet, and route catalog after idle.

### Theme

- Light/dark mode via toggle in the bottom floating dock (with **+**); auto-schedules by Hong Kong sunrise/sunset when no manual preference saved.
- Map tiles and row focus colors follow theme.

### Data & caching

- Citybus V2 API (`rt.data.gov.hk`) called directly from browser.
- In-memory and localStorage caches for stops, routes, route geometry, ETAs, OSRM routes.
- OSRM (`router.project-osrm.org`) for road-snapped polylines.
- Leaflet + CARTO basemap for map rendering.

## Constraints

- Static site only — no backend, no build step, no framework.
- Citybus (CTB) only via data.gov.hk API.
- Watchlist in localStorage; `js/config.js` provides defaults on first visit.
- Geolocation optional — app works without it (config order, no walkability dimming).
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
- [ ] Clearer empty state when geolocation denied

### Later

- [ ] Offline / last-known ETA display from cache
- [ ] Walking time via OSRM instead of crow-flies cutoff for `row--far`

## Open questions

- Is dual-route compare (max 2) the right limit?
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
