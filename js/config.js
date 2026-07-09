export const SECTIONS = [
  {
    id: "home",
    title: "Home",
    routes: [
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
    ],
  },
  {
    id: "work",
    title: "Work",
    routes: [
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
    ],
  },
];

export const WATCHLIST = SECTIONS.flatMap((section) => section.routes);

export const LOCATION = {
  lat: 22.3193,
  lng: 114.1694,
  timezone: "Asia/Hong_Kong",
};

export const REFRESH_INTERVAL_MS = 30_000;
