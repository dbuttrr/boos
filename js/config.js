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

export const REFRESH_INTERVAL_MS = 30_000;

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
