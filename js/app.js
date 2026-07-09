import { initTheme } from "./theme.js";
import { SECTIONS, WATCHLIST, REFRESH_INTERVAL_MS } from "./config.js";
import { fetchEta, formatArrivalDisplay, formatTime } from "./api.js";

const cardsEl = document.getElementById("cards");
const lastRefreshEl = document.getElementById("last-refresh");

let refreshTimer = null;
let isRefreshing = false;

function routeText(entry) {
  return entry.label.split(" · ")[0];
}

function createRowElement(entry) {
  const row = document.createElement("article");
  row.className = "row";
  row.dataset.id = entry.id;
  row.innerHTML = `
    <div class="row__route"></div>
    <div class="row__times">
      <span class="row__eta"></span>
      <span class="row__next"></span>
    </div>
  `;
  row.querySelector(".row__route").textContent = routeText(entry);
  return row;
}

function createSectionElement(section) {
  const sectionEl = document.createElement("section");
  sectionEl.className = "section";
  sectionEl.dataset.section = section.id;
  sectionEl.innerHTML = `<h2 class="section__title"></h2><div class="section__rows"></div>`;
  sectionEl.querySelector(".section__title").textContent = section.title;
  const rowsEl = sectionEl.querySelector(".section__rows");
  for (const entry of section.routes) {
    rowsEl.appendChild(createRowElement(entry));
  }
  return sectionEl;
}

function applyEtaStyle(el, variant) {
  el.className = "row__eta";
  if (variant === "remark") {
    el.classList.add("row__eta--remark");
  } else if (variant === "none") {
    el.classList.add("row__eta--none");
  }
}

function renderRow(row, result) {
  const etaEl = row.querySelector(".row__eta");
  const nextEl = row.querySelector(".row__next");
  const existingError = row.querySelector(".row__error");
  existingError?.remove();

  row.classList.remove("row--loading");

  if (result.error) {
    etaEl.textContent = "—";
    etaEl.className = "row__eta row__eta--none";
    nextEl.textContent = "";
    nextEl.hidden = true;
    const err = document.createElement("p");
    err.className = "row__error";
    err.textContent = result.error;
    row.appendChild(err);
    return;
  }

  const first = formatArrivalDisplay(result.first);
  etaEl.textContent = first.text;
  applyEtaStyle(etaEl, first.variant);

  const second = formatArrivalDisplay(result.second);
  if (second.variant === "none" && second.text === "—") {
    nextEl.textContent = "";
    nextEl.hidden = true;
  } else {
    nextEl.textContent = second.text;
    nextEl.hidden = false;
    nextEl.className =
      second.variant === "remark" ? "row__next row__next--remark" : "row__next";
  }
}

function ensureSections() {
  if (cardsEl.children.length > 0) return;
  for (const section of SECTIONS) {
    cardsEl.appendChild(createSectionElement(section));
  }
}

async function loadEntry(entry) {
  try {
    const { first, second, generatedAt } = await fetchEta(
      entry.route,
      entry.stopId,
      entry.direction
    );
    return { first, second, generatedAt, error: null };
  } catch (err) {
    return { first: null, second: null, generatedAt: null, error: err.message };
  }
}

async function refreshAll() {
  if (isRefreshing) return;
  isRefreshing = true;

  ensureSections();
  cardsEl.querySelectorAll(".row").forEach((row) => {
    row.classList.add("row--loading");
  });

  const results = await Promise.all(
    WATCHLIST.map(async (entry) => ({
      id: entry.id,
      result: await loadEntry(entry),
    }))
  );

  for (const { id, result } of results) {
    const row = cardsEl.querySelector(`[data-id="${id}"]`);
    if (row) renderRow(row, result);
  }

  lastRefreshEl.textContent = `Updated ${formatTime(new Date().toISOString())}`;
  isRefreshing = false;
}

function startAutoRefresh() {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = setInterval(refreshAll, REFRESH_INTERVAL_MS);
}

ensureSections();
initTheme();
refreshAll();
startAutoRefresh();

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    refreshAll();
  }
});

document.getElementById("app").addEventListener("click", () => {
  refreshAll();
});
