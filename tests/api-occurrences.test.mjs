import test from "node:test";
import assert from "node:assert/strict";
import { fetchEta } from "../js/api.js";

const NOW = Date.UTC(2026, 9, 30, 4);
const MINUTE = 60_000;
let fixtureId = 0;

function arrival(seq, minutes, extra = {}) {
  return {
    seq,
    dir: "I",
    eta: new Date(NOW + minutes * MINUTE).toISOString(),
    data_timestamp: new Date(NOW - 10_000).toISOString(),
    ...extra,
  };
}

function fixture(t, entries) {
  const route = `occurrence-test-${fixtureId++}`;
  const stopId = "repeated-stop";
  let requests = 0;
  t.mock.method(Date, "now", () => NOW);
  t.mock.method(globalThis, "fetch", async input => {
    const url = new URL(input);
    assert.equal(url.origin, "https://rt.data.gov.hk");
    assert.equal(url.pathname, `/v2/transport/citybus/eta/CTB/${stopId}/${route}`);
    requests++;
    return {
      ok: true,
      json: async () => ({
        generated_timestamp: new Date(NOW).toISOString(),
        data: entries,
      }),
    };
  });
  return {
    read: options => fetchEta(route, stopId, "I", options),
    requests: () => requests,
  };
}

test("an occurrence is filtered before selecting its next two arrivals", async t => {
  const wantedFirst = arrival(8, 5);
  const wantedSecond = arrival(8, 6);
  const h = fixture(t, [
    arrival(2, 1, { data_timestamp: new Date(NOW - 50_000).toISOString() }),
    wantedSecond,
    arrival(8, -1),
    arrival(2, 2),
    arrival(8, 0.5, { dir: "O" }),
    wantedFirst,
  ]);

  const result = await h.read({ stopSeq: 8 });
  assert.equal(result.first, wantedFirst);
  assert.equal(result.second, wantedSecond);
  assert.equal(result.snapshotMs, NOW - 10_000,
    "freshness belongs to the selected occurrence, not another visit");
});

test("missing sequence data cannot match an explicitly requested occurrence", async t => {
  const h = fixture(t, [
    arrival(undefined, 1),
    arrival(null, 2),
    arrival("", 3),
    arrival(2, 4),
  ]);
  const result = await h.read({ stopSeq: 8 });
  assert.equal(result.first, null);
  assert.equal(result.second, null);
});

test("numeric and string sequence values identify the same occurrence and cache", async t => {
  const first = arrival("08", 2);
  const second = arrival(8, 3);
  const h = fixture(t, [arrival(2, 1), second, first]);

  const fromString = await h.read({ stopSeq: "08", useCache: true });
  const fromNumber = await h.read({ stopSeq: 8, useCache: true });
  assert.equal(fromString.first, first);
  assert.equal(fromString.second, second);
  assert.equal(fromNumber, fromString);
  assert.equal(h.requests(), 1);
});

test("occurrence-specific caches cannot pollute another occurrence or unfiltered reads", async t => {
  const a1 = arrival(2, 1);
  const a2 = arrival(2, 8);
  const b1 = arrival(8, 5);
  const b2 = arrival(8, 10);
  const h = fixture(t, [b2, a2, b1, a1]);

  const a = await h.read({ stopSeq: 2, useCache: true });
  const b = await h.read({ stopSeq: 8, useCache: true });
  const unfiltered = await h.read({ useCache: true });
  assert.equal(h.requests(), 3);
  assert.deepEqual([a.first, a.second], [a1, a2]);
  assert.deepEqual([b.first, b.second], [b1, b2]);
  assert.deepEqual([unfiltered.first, unfiltered.second], [a1, b1]);

  assert.equal(await h.read({ stopSeq: 2, useCache: true }), a);
  assert.equal(await h.read({ stopSeq: 8, useCache: true }), b);
  assert.equal(await h.read({ useCache: true }), unfiltered);
  assert.equal(h.requests(), 3);
});

test("an unfiltered cached result cannot satisfy a later occurrence-specific read", async t => {
  const wanted = arrival(8, 5);
  const h = fixture(t, [arrival(2, 1), arrival(2, 2), wanted]);
  const unfiltered = await h.read({ useCache: true });
  assert.equal(unfiltered.first.seq, 2);

  const selected = await h.read({ stopSeq: 8, useCache: true });
  assert.equal(selected.first, wanted);
  assert.equal(selected.second, null);
  assert.equal(h.requests(), 2);
});

test("omitting sequence preserves the existing unfiltered arrival behavior", async t => {
  const noSequence = arrival(undefined, 1);
  const repeatedVisit = arrival(8, 2);
  const h = fixture(t, [arrival(2, 3), repeatedVisit, noSequence]);

  const result = await h.read();
  assert.equal(result.first, noSequence);
  assert.equal(result.second, repeatedVisit);
  const cached = await h.read({ stopSeq: null, useCache: true });
  assert.equal(cached, result, "null sequence also means an unfiltered read");
  assert.equal(h.requests(), 1);
});

test("an occurrence-specific remark does not borrow another visit's ETA or remark", async t => {
  const wantedRemark = arrival(8, 1, { eta: null, rmk_en: "No scheduled service" });
  const h = fixture(t, [
    arrival(2, 1),
    arrival(2, 2, { eta: null, rmk_en: "Another visit's remark" }),
    wantedRemark,
  ]);

  const result = await h.read({ stopSeq: 8 });
  assert.equal(result.first, wantedRemark);
  assert.equal(result.second, null);
});
