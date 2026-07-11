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

export const REFRESH_INTERVAL_MS = 5_000;

/** Full focus-map re-estimate (upstream ETAs + repaint) at most this often. */
export const FOCUS_REFRESH_INTERVAL_MS = 60_000;

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

/** Treat buses with ETA under this many minutes as arriving at the stop. */
export const ARRIVING_THRESHOLD_MIN = 1;

/** Clamp live-derived bus speed (m/min) to a sane urban band (~5–36 km/h). */
export const MIN_BUS_SPEED_M_PER_MIN = 80;
export const MAX_BUS_SPEED_M_PER_MIN = 600;

/** Fallback speed when upstream ETA matching fails (~15 km/h). */
export const DEFAULT_BUS_SPEED_M_PER_MIN = 250;

/** Bus marker chase factor per frame toward target (0–1). */
export const BUS_MARKER_LERP = 0.08;

/** Duration to animate the bus along the route to a revised API prediction. */
export const BUS_REPOSITION_MS = 1_200;

/** Ignore prediction deltas smaller than this (meters) when starting a reposition. */
export const BUS_REPOSITION_MIN_M = 5;

/** Max meters a same-bus ETA revision may move the marker backward. */
export const MAX_BUS_REWIND_M = 400;

/**
 * Idle GPS follow window as a fraction of the top-half active area (0–1).
 * Marker always moves; map recenters only when you leave this soft region
 * (Maps/Uber-style), measured from the top-half visual center.
 */
export const IDLE_FOLLOW_WINDOW = 0.45;

/** Radius (meters) for nearby-stop discovery when adding a route. */
export const NEARBY_STOP_RADIUS_M = 500;
