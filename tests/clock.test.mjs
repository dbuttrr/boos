import assert from "node:assert/strict";
import test from "node:test";
import { fetchEta, trackingNowMs } from "../js/api.js";
import { resolveActiveBoardingEta } from "../js/estimate.js";

const ORIGIN = Date.UTC(2026, 9, 30, 4, 0, 0);
const iso = (ms) => new Date(ms).toISOString();

test("an old API snapshot does not delay the tracking clock", (t) => {
  const nowMs = ORIGIN + 45_000;
  t.mock.method(Date, "now", () => nowMs);

  assert.equal(
    trackingNowMs({ snapshotMs: ORIGIN, receivedAtMs: nowMs }),
    nowMs
  );
  assert.equal(trackingNowMs(), nowMs);
  assert.equal(trackingNowMs({}), nowMs);
});

test("a delayed newer snapshot cannot rewind tracking time", (t) => {
  let nowMs = ORIGIN + 99_000;
  t.mock.method(Date, "now", () => nowMs);

  const before = trackingNowMs({
    snapshotMs: ORIGIN,
    receivedAtMs: ORIGIN + 2_000,
  });
  nowMs += 1_000;
  const after = trackingNowMs({
    snapshotMs: ORIGIN + 60_000,
    receivedAtMs: nowMs,
  });

  assert.equal(before, ORIGIN + 99_000);
  assert.equal(after - before, 1_000);
});

test("polling the same snapshot cannot reset tracking time", (t) => {
  let nowMs = ORIGIN + 30_000;
  t.mock.method(Date, "now", () => nowMs);

  const firstPoll = trackingNowMs({
    snapshotMs: ORIGIN,
    receivedAtMs: ORIGIN + 2_000,
  });
  nowMs += 1_000;
  const secondPoll = trackingNowMs({
    snapshotMs: ORIGIN,
    receivedAtMs: nowMs,
  });

  assert.equal(secondPoll - firstPoll, 1_000);
});

test("cached ETA metadata remains intact while tracking uses current time", async (t) => {
  let nowMs = ORIGIN + 45_000;
  let requests = 0;
  t.mock.method(Date, "now", () => nowMs);
  t.mock.method(globalThis, "fetch", async () => {
    requests += 1;
    return {
      ok: true,
      json: async () => ({
        generated_timestamp: iso(ORIGIN + 1_000),
        data: [
          {
            dir: "I",
            eta: iso(ORIGIN + 120_000),
            data_timestamp: iso(ORIGIN),
          },
        ],
      }),
    };
  });

  const first = await fetchEta("clock-test-route", "clock-test-stop", "I");
  nowMs += 10_000;
  const cached = await fetchEta("clock-test-route", "clock-test-stop", "I", {
    useCache: true,
  });

  assert.equal(requests, 1);
  assert.equal(cached, first);
  assert.equal(cached.snapshotMs, ORIGIN);
  assert.equal(cached.generatedAt, iso(ORIGIN + 1_000));
  assert.equal(cached.receivedAtMs, ORIGIN + 45_000);
  assert.equal(trackingNowMs(cached), nowMs);
});

test("boarding handoff uses current time even when the source snapshot is old", (t) => {
  const nowMs = ORIGIN + 60_000;
  t.mock.method(Date, "now", () => nowMs);
  const first = { eta: iso(ORIGIN + 50_000) };
  const second = { eta: iso(ORIGIN + 120_000) };

  assert.deepEqual(
    resolveActiveBoardingEta({
      first,
      second,
      snapshotMs: ORIGIN,
      receivedAtMs: ORIGIN + 45_000,
    }),
    { active: second, handedOff: true, nowMs }
  );
});

test("an ETA equal to current time is expired for boarding handoff", (t) => {
  const nowMs = ORIGIN + 60_000;
  t.mock.method(Date, "now", () => nowMs);
  const second = { eta: iso(nowMs + 30_000) };

  assert.deepEqual(
    resolveActiveBoardingEta({ first: { eta: iso(nowMs) }, second }),
    { active: second, handedOff: true, nowMs }
  );
});

test("both expired arrivals clear tracking despite stale source metadata", (t) => {
  const nowMs = ORIGIN + 60_000;
  t.mock.method(Date, "now", () => nowMs);

  assert.deepEqual(
    resolveActiveBoardingEta({
      first: { eta: iso(ORIGIN + 50_000) },
      second: { eta: iso(ORIGIN + 55_000) },
      snapshotMs: ORIGIN,
      receivedAtMs: nowMs,
    }),
    { active: null, handedOff: true, nowMs }
  );
});
