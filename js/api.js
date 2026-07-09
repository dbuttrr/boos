const BASE_URL = "https://rt.data.gov.hk/v2/transport/citybus";

function pickArrivals(entries, direction) {
  let filtered = entries;

  if (direction) {
    filtered = entries.filter((e) => e.dir === direction);
  }

  const upcoming = filtered
    .filter((e) => e.eta && new Date(e.eta).getTime() > Date.now())
    .sort((a, b) => new Date(a.eta).getTime() - new Date(b.eta).getTime());

  if (upcoming.length > 0) {
    return {
      first: upcoming[0],
      second: upcoming[1] ?? null,
    };
  }

  const remarkOnly = filtered.find((e) => !e.eta && e.rmk_en);
  if (remarkOnly) {
    return { first: remarkOnly, second: null };
  }

  return { first: null, second: null };
}

export function formatArrivalDisplay(entry) {
  if (!entry) {
    return { text: "—", variant: "none" };
  }

  if (entry.rmk_en && !entry.eta) {
    return { text: entry.rmk_en, variant: "remark" };
  }

  if (!entry.eta) {
    return { text: "—", variant: "none" };
  }

  return { text: formatTime(entry.eta), variant: "default" };
}

export async function fetchEta(route, stopId, direction) {
  const url = `${BASE_URL}/eta/CTB/${stopId}/${route}`;
  const response = await fetch(url);

  if (!response.ok) {
    let message = `HTTP ${response.status}`;
    try {
      const body = await response.json();
      if (body.message) message = body.message;
    } catch {
      // ignore parse errors
    }
    throw new Error(message);
  }

  const payload = await response.json();
  const entries = payload.data ?? [];
  const { first, second } = pickArrivals(entries, direction);

  return {
    first,
    second,
    generatedAt: payload.generated_timestamp ?? null,
  };
}

export function formatTime(isoString) {
  if (!isoString) return "";
  return new Date(isoString).toLocaleTimeString("en-HK", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}
