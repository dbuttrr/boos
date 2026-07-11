/**
 * Fetch CTB stop catalog from data.gov.hk and write data/stops-index.json.
 * Run after route/stop data changes: node scripts/build-stops-index.mjs
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const BASE = "https://rt.data.gov.hk/v2/transport/citybus";
const BATCH = 20;
const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "data", "stops-index.json");

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.json();
}

async function fetchRoutes() {
  const payload = await fetchJson(`${BASE}/route/CTB`);
  return (payload.data ?? []).map((item) => item.route);
}

async function fetchRouteStops(route, direction) {
  const dirPath = direction === "I" ? "inbound" : "outbound";
  const payload = await fetchJson(
    `${BASE}/route-stop/CTB/${encodeURIComponent(route)}/${dirPath}`
  );
  return (payload.data ?? []).map((item) => item.stop);
}

async function fetchStop(stopId) {
  const payload = await fetchJson(`${BASE}/stop/${stopId}`);
  const data = payload.data;
  if (!data) throw new Error(`Stop ${stopId} not found`);
  return {
    stopId: data.stop,
    nameEn: data.name_en,
    lat: Number(data.lat),
    lng: Number(data.long),
  };
}

async function main() {
  console.log("Fetching routes…");
  const routes = await fetchRoutes();
  console.log(`  ${routes.length} routes`);

  const stopIds = new Set();
  for (let i = 0; i < routes.length; i += BATCH) {
    const batch = routes.slice(i, i + BATCH);
    await Promise.all(
      batch.map(async (route) => {
        for (const dir of ["O", "I"]) {
          try {
            const ids = await fetchRouteStops(route, dir);
            for (const id of ids) stopIds.add(id);
          } catch (err) {
            console.warn(`  skip ${route} ${dir}: ${err.message}`);
          }
        }
      })
    );
    process.stdout.write(`  route-stops ${Math.min(i + BATCH, routes.length)}/${routes.length}\r`);
  }
  console.log(`\n  ${stopIds.size} unique stops`);

  const ids = [...stopIds];
  const stops = [];
  for (let i = 0; i < ids.length; i += BATCH) {
    const batch = ids.slice(i, i + BATCH);
    const resolved = await Promise.all(
      batch.map(async (id) => {
        try {
          return await fetchStop(id);
        } catch (err) {
          console.warn(`  skip stop ${id}: ${err.message}`);
          return null;
        }
      })
    );
    stops.push(...resolved.filter(Boolean));
    process.stdout.write(`  stop coords ${Math.min(i + BATCH, ids.length)}/${ids.length}\r`);
  }
  console.log(`\n  ${stops.length} stops with coords`);

  stops.sort((a, b) => a.stopId.localeCompare(b.stopId));

  const output = {
    generatedAt: new Date().toISOString(),
    count: stops.length,
    stops,
  };

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(output));
  console.log(`Wrote ${OUT} (${(JSON.stringify(output).length / 1024).toFixed(0)} KB)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
