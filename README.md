# HK Citybus ETA

A minimal mobile-first web app showing real-time Citybus arrival times for routes you care about.

**Product requirements:** [docs/PRD.md](docs/PRD.md)

## Quick start

**Option A — local server (recommended)**

ES modules require serving over HTTP (not `file://`):

```bash
npx serve .
```

Then open the URL shown (usually `http://localhost:3000`).

**Option B — any static host**

Deploy the folder to GitHub Pages, Netlify, etc.

## Deploy to GitHub Pages

1. Create a **public** repo on GitHub (e.g. `bus`) — do not add a README or `.gitignore`.
2. Push this project:

   ```bash
   cd /Users/daryl.sim/bus
   git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPO_NAME.git
   git push -u origin main
   ```

3. In the repo: **Settings → Pages → Deploy from branch → `main` / `/ (root)` → Save**.

Your bookmarkable URL:

```
https://YOUR_USERNAME.github.io/YOUR_REPO_NAME/
```

Changes to `js/config.js` take effect after you push and GitHub Pages redeploys (usually within a minute).

## Customize routes

### In the app

Tap **+** above the watchlist to add a route: choose **Find nearby** (stops within 500 m on the map) or **Enter manually** (type route → direction → tap stop). Swipe a row left and tap Delete to remove it. Changes are saved in your browser's localStorage.

### Via config (optional seed)

Edit [`js/config.js`](js/config.js) to set the default watchlist for first-time visitors (or after clearing site data). Each entry is one stop + direction:

```js
{
  id: "unique-id",
  route: "11",           // route number
  stopId: "001145",      // 6-digit stop ID
  direction: "O",        // "O" = outbound, "I" = inbound (optional but recommended)
  label: "Route 11 → Jardine's Lookout",
}
```

Reload the page after config changes (only affects browsers without a saved watchlist).

## Map tiles and CARTO key

The checked-in configuration uses a CARTO Basemaps key for native light/dark map styles. Clear `CARTO_BASEMAP_API_KEY` in `js/config.js` to use standard OpenStreetMap tiles without a key. The OpenStreetMap fallback applies a dark-mode filter only to the base tiles; route lines, markers, and stop-name bubbles keep their own colors.

To configure your own CARTO key:

1. Open [Get your CARTO Basemaps API key](https://carto.com/basemaps/apikey/), enter your email and usage details, accept the terms, and request the emailed key. No CARTO platform account or card is needed. Personal/non-commercial use is [free up to 5 million tile requests per month](https://docs.carto.com/faqs/carto-basemaps).
2. Set `CARTO_BASEMAP_API_KEY` in [`js/config.js`](js/config.js):

   ```js
   export const CARTO_BASEMAP_API_KEY = "your-basemaps-key";
   ```

3. Reload the page. Leave the value empty to use OpenStreetMap.

The basemap key is visible in the browser. Use [website restrictions in the CARTO dashboard](https://docs.carto.com/faqs/carto-basemaps): create a local-development key listing `localhost` and `127.0.0.1` (no ports), and a separate key for your deployed hostname. CARTO does not allow local and public hosts on the same restricted key. Keep the map attribution visible.

## Stop catalog (nearby add-flow)

Nearby stop discovery uses a bundled file [`data/stops-index.json`](data/stops-index.json) (~2.5k CTB stops). To refresh after route/stop changes on data.gov.hk:

```bash
node scripts/build-stops-index.mjs
```

Commit the updated JSON with your deploy.

## Finding stop IDs (manual / config editing)

1. **List stops on a route** — replace `{route}` and `{direction}` (`inbound` or `outbound`):

   ```
   https://rt.data.gov.hk/v2/transport/citybus/route-stop/CTB/{route}/{direction}
   ```

   Example: [Route 11 outbound stops](https://rt.data.gov.hk/v2/transport/citybus/route-stop/CTB/11/outbound)

   Each item has `seq` (order along route) and `stop` (6-digit ID). Pick the stop where you board.

2. **Look up stop name** (optional):

   ```
   https://rt.data.gov.hk/v2/transport/citybus/stop/{stop_id}
   ```

3. **Test ETA** before adding to config:

   ```
   https://rt.data.gov.hk/v2/transport/citybus/eta/CTB/{stop_id}/{route}
   ```

## How it works

See [docs/PRD.md](docs/PRD.md) for full product behavior. Summary:

- Fetches ETAs from the [Citybus V2 API](http://citybus.com.hk/datagovhk/bus_eta_api_specifications.pdf) (`rt.data.gov.hk`)
- Add/remove routes in-app (+ button); default nearby-stop picker within 500 m; route-number entry as fallback; watchlist persists in localStorage
- Shows the next 1–2 upcoming arrivals per watchlisted stop + direction
- Checks every focused route entry every 12 seconds and the other entries every 60 seconds, with independent request-start deadlines and no learned interval that can stretch after missed updates. Newly focused entries refresh immediately; repeated in-flight requests are coalesced. Pauses while the tab is hidden; returning or tapping empty watch-sheet padding checks all entries. The status identifies focused-only checks and shows the next check or `refreshing…`; ETA requests have an 8-second timeout.
- Sorts by distance when geolocation is available; dims stops beyond ~20 min walk
- Full-bleed map: idle GPS follow is Maps/Uber-style (marker moves; camera recenters only when you leave a soft top-half window); tap rows to fit you, stops, bus markers, and approach nerve pulses there (any number of routes) — colored bus marker on the approach line; uniform pearl dashes flow steadily from the bus toward the next stop over a dim track. Each dash is longer farther from the stop, then shortens and moves closer to its neighbors as the bus approaches.
- Bus marker and pulse share one position derived from a validated upstream ETA chain, with speed fallback when insufficient chain data remains. Upstream ETA fetching and road-path position tracking continue through the final minute before boarding, without snapping the marker to the stop. Tracking uses current device time; API timestamps indicate data freshness. Bus association and path geometry remain approximate.
- New ETA estimates ease into the displayed bus position along the road over five seconds, with the pulse following the same position. Revisions during a transition start from the current display. Detected handoffs, large ETA changes, changed route geometry or stop visits, unavailable estimates, and background resume reset the transition. Smoothing affects the display only; corrections may move backward.
- Ordered route geometry preserves later visits to the same road or stop coordinates, including on long routes. The approach uses a prefix of the same full route drawn on the map. Unique physical stops map directly; repeated visits require sequence calibration from at least two unambiguous stops because Citybus endpoints can number stops differently. If a boarding visit cannot be resolved, the map keeps the route and physical stop pin while hiding the estimated bus. OSRM's driving profile does not identify a vehicle or confirm its actual path or traffic conditions.
- Empty or missing upstream ETA responses mean unknown, not that the bus has passed the stop; they add no minimum-position constraint. Valid matched ETAs drive progress, with speed fallback when no usable chain remains.
- CARTO base tiles use a configured Basemaps key for native light/dark styles; clearing the key selects the OpenStreetMap fallback
- Light/dark theme (auto by HK sunrise/sunset, or sun/moon control top-right)
- Home-screen / tab icon is the blue map bus marker (`favicon.svg`, `apple-touch-icon.png`)

## Validation

Run the regression checks with Node.js; no dependencies or build step are needed:

```bash
node --test tests/*.test.mjs
```

## CORS

The data.gov.hk API allows cross-origin requests (`Access-Control-Allow-Origin: *`), so the app calls it directly from the browser with no backend.

If you ever hit CORS issues in a restricted environment, serve the app over HTTP (not `file://`) using `npx serve .`.

## Data source

Real-time ETA data provided by [Citybus Limited](https://www.citybus.com.hk) via [data.gov.hk](https://data.gov.hk).
