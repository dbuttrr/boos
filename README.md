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
- Auto-refreshes every 5 seconds (status row shows countdown to next refresh); tap empty watch-sheet padding (outside rows) to refresh manually
- Sorts by distance when geolocation is available; dims stops beyond ~20 min walk
- Full-bleed map: idle GPS follow is Maps/Uber-style (marker moves; camera recenters only when you leave a soft top-half window); tap rows to fit you, stops, and estimated buses there (any number of routes)
- Light/dark theme (auto by HK sunrise/sunset, or sun/moon control top-right)
- Home-screen / tab icon is the blue map bus marker (`favicon.svg`, `apple-touch-icon.png`)

## CORS

The data.gov.hk API allows cross-origin requests (`Access-Control-Allow-Origin: *`), so the app calls it directly from the browser with no backend.

If you ever hit CORS issues in a restricted environment, serve the app over HTTP (not `file://`) using `npx serve .`.

## Data source

Real-time ETA data provided by [Citybus Limited](https://www.citybus.com.hk) via [data.gov.hk](https://data.gov.hk).
