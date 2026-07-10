import { WATCHLIST as DEFAULT_WATCHLIST } from "./config.js";

const STORAGE_KEY = "bus:watchlist";

function isValidEntry(entry) {
  return (
    entry &&
    typeof entry.id === "string" &&
    typeof entry.route === "string" &&
    typeof entry.stopId === "string" &&
    typeof entry.direction === "string" &&
    typeof entry.label === "string"
  );
}

function readStored() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    if (!parsed.every(isValidEntry)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeStored(entries) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
    return true;
  } catch {
    return false;
  }
}

export function loadWatchlist() {
  const stored = readStored();
  if (stored) return stored.map((entry) => ({ ...entry }));
  return DEFAULT_WATCHLIST.map((entry) => ({ ...entry }));
}

export function saveWatchlist(entries) {
  writeStored(entries);
}

export function entryKey(entry) {
  return `${entry.route}|${entry.stopId}|${entry.direction}`;
}

export function hasEntry(entries, { route, stopId, direction }) {
  const key = `${route}|${stopId}|${direction}`;
  return entries.some((e) => entryKey(e) === key);
}

export function makeEntryId(route, direction, stopId) {
  const dir = direction === "I" ? "i" : "o";
  return `${route.toLowerCase()}-${dir}-${stopId}`;
}

export function buildLabel(route, routeDest, stopName) {
  return `${route} → ${routeDest} · ${stopName}`;
}

export function addEntry(entries, entry) {
  if (hasEntry(entries, entry)) {
    return { entries, added: false, reason: "duplicate" };
  }
  const next = [...entries, entry];
  saveWatchlist(next);
  return { entries: next, added: true };
}

export function removeEntry(entries, id) {
  const next = entries.filter((e) => e.id !== id);
  if (next.length === entries.length) {
    return { entries, removed: false };
  }
  saveWatchlist(next);
  return { entries: next, removed: true };
}

export function resetToDefaults() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
  return DEFAULT_WATCHLIST.map((entry) => ({ ...entry }));
}
