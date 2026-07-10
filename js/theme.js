import { LOCATION } from "./config.js";

const DAY_MS = 86400000;
const J1970 = 2440588;
const J0 = 0.0009;
const RAD = Math.PI / 180;
const SUN_ANGLE = -0.833;

let themeTimer = null;

function toJulian(date) {
  return date.valueOf() / DAY_MS - 0.5 + J1970;
}

function fromJulian(j) {
  return new Date((j + 0.5 - J1970) * DAY_MS);
}

function toDays(date) {
  return toJulian(date) - J2000;
}

const J2000 = 2451545;

function solarMeanAnomaly(d) {
  return RAD * (357.5291 + 0.98560028 * d);
}

function eclipticLongitude(M) {
  const C = RAD * (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M));
  const P = RAD * 102.9372;
  return M + C + P + Math.PI;
}

function declination(L, B) {
  return Math.asin(
    Math.sin(B) * Math.cos(RAD * 23.4397) +
      Math.cos(B) * Math.sin(RAD * 23.4397) * Math.sin(L)
  );
}

function hourAngle(h, phi, d) {
  return Math.acos(
    (Math.sin(h) - Math.sin(phi) * Math.sin(d)) / (Math.cos(phi) * Math.cos(d))
  );
}

function julianCycle(d, lw) {
  return Math.round(d - J0 - lw / (2 * Math.PI));
}

function approxTransit(Ht, lw, n) {
  return J0 + lw / (2 * Math.PI) + n + Ht / (2 * Math.PI);
}

function solarTransitJ(ds, M, L) {
  return J2000 + ds + 0.0053 * Math.sin(M) - 0.0069 * Math.sin(2 * L);
}

function getSunTimes(date, lat, lng) {
  const lw = RAD * -lng;
  const phi = RAD * lat;
  const d = toDays(date);
  const n = julianCycle(d, lw);
  const ds = approxTransit(0, lw, n);
  const M = solarMeanAnomaly(ds);
  const L = eclipticLongitude(M);
  const dec = declination(L, 0);
  const Jnoon = solarTransitJ(ds, M, L);
  const h = hourAngle(SUN_ANGLE * RAD, phi, dec);

  return {
    sunrise: fromJulian(Jnoon - h / (2 * Math.PI)),
    sunset: fromJulian(Jnoon + h / (2 * Math.PI)),
  };
}

function hkDateParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: LOCATION.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);

  const get = (type) => parts.find((p) => p.type === type).value;
  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
  };
}

function hkDateAtNoon(date = new Date()) {
  const { year, month, day } = hkDateParts(date);
  return new Date(Date.UTC(year, month - 1, day, 4, 0, 0));
}

function isNightInHK(date = new Date()) {
  const times = getSunTimes(hkDateAtNoon(date), LOCATION.lat, LOCATION.lng);
  const now = date.getTime();
  return now >= times.sunset.getTime() || now < times.sunrise.getTime();
}

function nextTransition(date = new Date()) {
  const times = getSunTimes(hkDateAtNoon(date), LOCATION.lat, LOCATION.lng);
  const now = date.getTime();

  if (now < times.sunrise.getTime()) return times.sunrise;
  if (now < times.sunset.getTime()) return times.sunset;

  const tomorrow = new Date(date.getTime() + DAY_MS);
  const tomorrowTimes = getSunTimes(
    hkDateAtNoon(tomorrow),
    LOCATION.lat,
    LOCATION.lng
  );
  return tomorrowTimes.sunrise;
}

const PREF_KEY = "bus-theme";

function readPreference() {
  try {
    const value = localStorage.getItem(PREF_KEY);
    if (value === "light" || value === "dark") return value;
  } catch {
    // ignore private mode / blocked storage
  }
  return null;
}

function writePreference(theme) {
  try {
    localStorage.setItem(PREF_KEY, theme);
  } catch {
    // ignore private mode / blocked storage
  }
}

function clearThemeTimer() {
  if (themeTimer) {
    clearTimeout(themeTimer);
    themeTimer = null;
  }
}

function syncToggle(theme) {
  const root = document.getElementById("theme-toggle");
  if (!root) return;
  const dark = theme === "dark";
  for (const btn of root.querySelectorAll("[data-theme-choice]")) {
    const choice = btn.getAttribute("data-theme-choice");
    const active = choice === theme;
    btn.setAttribute("aria-pressed", active ? "true" : "false");
  }
  root.dataset.themeActive = theme;
  root.setAttribute(
    "aria-label",
    dark ? "Color theme, dark selected" : "Color theme, light selected"
  );
}

function applyTheme() {
  const pref = readPreference();
  const dark = pref ? pref === "dark" : isNightInHK();
  const theme = dark ? "dark" : "light";

  document.documentElement.dataset.theme = theme;

  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) {
    meta.content = dark ? "#0c1016" : "#eef1f6";
  }

  syncToggle(theme);
  document.dispatchEvent(new CustomEvent("themechange", { detail: { theme } }));
}

function scheduleThemeUpdate() {
  clearThemeTimer();
  if (readPreference()) return;

  const transition = nextTransition();
  const delay = Math.max(transition.getTime() - Date.now() + 1000, 1000);

  themeTimer = setTimeout(() => {
    applyTheme();
    scheduleThemeUpdate();
  }, delay);
}

function setTheme(next) {
  if (next !== "light" && next !== "dark") return;
  writePreference(next);
  clearThemeTimer();
  applyTheme();
}

function toggleTheme() {
  const current =
    document.documentElement.dataset.theme === "dark" ? "dark" : "light";
  setTheme(current === "dark" ? "light" : "dark");
}

export function initTheme() {
  applyTheme();
  scheduleThemeUpdate();

  const root = document.getElementById("theme-toggle");
  if (!root) return;

  root.addEventListener("click", (event) => {
    const btn = event.target.closest("[data-theme-choice]");
    if (!btn || !root.contains(btn)) return;
    setTheme(btn.getAttribute("data-theme-choice"));
  });
}
