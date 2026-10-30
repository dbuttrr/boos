export const WATCHLIST = [
  {
    id: "8x-ssw-happy-valley",
    route: "8X",
    stopId: "002972",
    direction: "I",
    label: "8X → Siu Sai Wan · Happy Valley (Upper)",
  },
  {
    id: "1m-exhibition-woodland",
    route: "1M",
    stopId: "002546",
    direction: "I",
    label: "1M → Exhibition Centre · Woodland Heights",
  },
  {
    id: "788-ssw-wan-chai-ferry",
    route: "788",
    stopId: "002559",
    direction: "I",
    label: "788 → Siu Sai Wan · Wan Chai Ferry Pier",
  },
  {
    id: "6-central-woodland",
    route: "6",
    stopId: "002546",
    direction: "I",
    label: "6 → Central · Woodland Heights",
  },
  {
    id: "66-central-woodland",
    route: "66",
    stopId: "002546",
    direction: "I",
    label: "66 → Central · Woodland Heights",
  },
  {
    id: "788-central-tsui-wan",
    route: "788",
    stopId: "001344",
    direction: "O",
    label: "788 → Central · Tsui Wan Estate",
  },
  {
    id: "789-admiralty-tsui-wan",
    route: "789",
    stopId: "001344",
    direction: "O",
    label: "789 → Admiralty · Tsui Wan Estate",
  },
  {
    id: "8p-exhibition-lok-hin",
    route: "8P",
    stopId: "001227",
    direction: "O",
    label: "8P → Exhibition Centre · Lok Hin Terrace",
  },
];

export const LOCATION = {
  lat: 22.3193,
  lng: 114.1694,
  timezone: "Asia/Hong_Kong",
};

/** Optional browser-visible CARTO Basemaps key; empty uses OpenStreetMap tiles. */
export const CARTO_BASEMAP_API_KEY = "cb1_4y64_1_ea1d9d68f5e63c7f8d22ea21";

/** Selected watchlist entries are checked independently of Citybus timestamps. */
export const FOCUSED_ETA_REFRESH_INTERVAL_MS = 12_000;

/** Unselected watchlist entries are checked about once a minute. */
export const WATCHLIST_REFRESH_INTERVAL_MS = 60_000;

/** Bound an ETA request so a stalled connection cannot hold a polling slot. */
export const ETA_REQUEST_TIMEOUT_MS = 8_000;

/** Full focus-map re-estimate (upstream ETAs + repaint) at most this often. */
export const FOCUS_REFRESH_INTERVAL_MS = 60_000;

/** Ease accepted position corrections along the route over this interval. */
export const BUS_POSITION_BLEND_MS = 5_000;

/** Large ETA changes may identify another bus; reset presentation continuity. */
export const BUS_POSITION_MAX_ETA_SHIFT_MS = 5 * 60_000;

/** Upstream stop ETA cache TTL during focus tracking. */
export const UPSTREAM_ETA_CACHE_TTL_MS = 60_000;

/**
 * Stops whose straight-line distance already exceeds this walking time
 * are treated as definitely not walkable (actual paths are longer).
 */
export const MAX_WALK_MINUTES = 20;

/** Typical urban walking speed (~4.8 km/h). */
export const WALK_SPEED_M_PER_MIN = 80;

/** Max upstream stops to sample for live-derived bus speed. */
export const UPSTREAM_ETA_SAMPLE_SIZE = 4;

/** Clamp live-derived bus speed (m/min) to a sane urban band (~5–36 km/h). */
export const MIN_BUS_SPEED_M_PER_MIN = 80;
export const MAX_BUS_SPEED_M_PER_MIN = 600;

/** Fallback speed when upstream ETA matching fails (~15 km/h). */
export const DEFAULT_BUS_SPEED_M_PER_MIN = 250;

/** Reference map zoom for dash length, gaps, and visual travel speed. */
export const PULSE_ZOOM_REF = 15;

/** Clamp zoom-based dash sizing and speed scale (min / max). */
export const PULSE_ZOOM_SCALE_MIN = 0.65;
export const PULSE_ZOOM_SCALE_MAX = 1.45;

/** Rounded dash stroke width and travel speed at the reference zoom. */
export const PULSE_DASH_WIDTH_PX = 3.5;
export const PULSE_DASH_SPEED_PX_PER_SEC = 28;

/** Individual dash lengths, excluding round caps: shorter near the next stop. */
export const PULSE_DASH_NEAR_LENGTH_PX = 3;
export const PULSE_DASH_FAR_LENGTH_PX = 18;

/** Visible gaps between round caps: tighter near the next stop. */
export const PULSE_DASH_NEAR_GAP_PX = 3;
export const PULSE_DASH_FAR_GAP_PX = 10;

/** Remaining road distances defining the near/far spacing endpoints. */
export const PULSE_DASH_NEAR_DISTANCE_M = 20;
export const PULSE_DASH_FAR_DISTANCE_M = 300;

/** Hide the stream when too little screen distance remains to read it. */
export const PULSE_MIN_REMAINING_PX = 16;

/** Fade-in duration (ms) when the final-leg pulse appears. */
export const PULSE_FADE_IN_MS = 250;

/** Fade-out duration (ms) before pulse layers are removed. */
export const PULSE_FADE_OUT_MS = 200;

/**
 * Idle GPS follow window as a fraction of the top-half active area (0–1).
 * Marker always moves; map recenters only when you leave this soft region
 * (Maps/Uber-style), measured from the top-half visual center.
 */
export const IDLE_FOLLOW_WINDOW = 0.45;

/** Radius (meters) for nearby-stop discovery when adding a route. */
export const NEARBY_STOP_RADIUS_M = 500;
