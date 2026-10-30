import assert from "node:assert/strict";
import test from "node:test";

const NOW = Date.UTC(2026, 9, 30, 6);
const iso = (ms) => new Date(ms).toISOString();
const freshApi = (name) => import(`../js/api.js?refresh-test=${name}`);

async function flush() {
  for (let i = 0; i < 15; i++) await Promise.resolve();
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fakeTimeouts(t) {
  let now = NOW;
  let nextId = 1;
  const timers = new Map();
  t.mock.method(Date, "now", () => now);
  t.mock.method(globalThis, "setTimeout", (callback, delay) => {
    const id = nextId++;
    timers.set(id, { at: now + delay, callback });
    return id;
  });
  t.mock.method(globalThis, "clearTimeout", (id) => timers.delete(id));
  return {
    get size() { return timers.size; },
    async advance(ms) {
      const target = now + ms;
      while (true) {
        const next = [...timers].filter(([, timer]) => timer.at <= target)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        const [id, timer] = next;
        timers.delete(id);
        now = timer.at;
        timer.callback();
        await flush();
      }
      now = target;
      await flush();
    },
  };
}

function payload() {
  const arrival = (seq, minute, dir = "I") => ({
    seq, dir,
    eta: iso(NOW + minute * 60_000),
    data_timestamp: iso(NOW - 5_000),
  });
  return {
    generated_timestamp: iso(NOW),
    data: [arrival(1, 2), arrival(5, 3), arrival(2, 4, "O"), arrival(1, 6), arrival(5, 7)],
  };
}

test("concurrent direction and occurrence reads share one payload while keeping filtered caches separate", async (t) => {
  const timers = fakeTimeouts(t);
  const body = deferred();
  let requests = 0;
  let bodyReads = 0;
  t.mock.method(globalThis, "fetch", async () => {
    requests++;
    return { ok: true, json: () => { bodyReads++; return body.promise; } };
  });
  const { fetchEta } = await freshApi("shared-filtered-payload");
  const pending = [
    fetchEta("route", "stop", "I"),
    fetchEta("route", "stop", "I", { stopSeq: 1 }),
    fetchEta("route", "stop", "I", { stopSeq: "5" }),
    fetchEta("route", "stop", "O", { stopSeq: 2 }),
  ];
  await flush();
  assert.equal(requests, 1);
  assert.equal(bodyReads, 1);
  assert.equal(timers.size, 1, "all filtered readers share the same bounded raw request");
  body.resolve(payload());
  const [unfiltered, firstVisit, laterVisit, outbound] = await Promise.all(pending);
  assert.deepEqual([unfiltered.first.seq, unfiltered.second.seq], [1, 5]);
  assert.deepEqual([firstVisit.first.seq, firstVisit.second.seq], [1, 1]);
  assert.deepEqual([laterVisit.first.seq, laterVisit.second.seq], [5, 5]);
  assert.equal(outbound.first.dir, "O");
  assert.equal(outbound.first.seq, 2);
  assert.equal(outbound.second, null);
  assert.equal(timers.size, 0);
  assert.equal(await fetchEta("route", "stop", "I", { useCache: true }), unfiltered);
  assert.equal(await fetchEta("route", "stop", "I", { useCache: true, stopSeq: 1 }), firstVisit);
  assert.equal(await fetchEta("route", "stop", "I", { useCache: true, stopSeq: 5 }), laterVisit);
  assert.equal(await fetchEta("route", "stop", "O", { useCache: true, stopSeq: 2 }), outbound);
  assert.equal(requests, 1, "one filter's cache never replaces another filter's selected arrivals");
  await fetchEta("route", "stop", "I", { useCache: true, stopSeq: 9 });
  assert.equal(requests, 2, "an unrequested filter must not borrow another occurrence's cached result");
});

test("different physical stops or routes use independent raw requests and abort signals", async (t) => {
  fakeTimeouts(t);
  const seen = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    seen.push({ url, signal: options.signal });
    return { ok: true, json: async () => payload() };
  });
  const { fetchEta } = await freshApi("independent-urls");
  await Promise.all([
    fetchEta("route-a", "stop-a", "I"),
    fetchEta("route-a", "stop-b", "I"),
    fetchEta("route-b", "stop-a", "I"),
  ]);
  assert.equal(new Set(seen.map((item) => item.url)).size, 3);
  assert.equal(new Set(seen.map((item) => item.signal)).size, 3);
});

test("a failed shared request clears in-flight state so a later check can retry", async (t) => {
  const timers = fakeTimeouts(t);
  const failed = deferred();
  let requests = 0;
  t.mock.method(globalThis, "fetch", () => {
    requests++;
    if (requests === 1) return failed.promise;
    return Promise.resolve({ ok: true, json: async () => payload() });
  });
  const { fetchEta } = await freshApi("failure-retry");
  const results = Promise.allSettled([
    fetchEta("route", "stop", "I"),
    fetchEta("route", "stop", "I", { stopSeq: 5 }),
  ]);
  assert.equal(requests, 1);
  failed.reject(new Error("network down"));
  for (const result of await results) {
    assert.equal(result.status, "rejected");
    assert.match(result.reason.message, /network down/);
  }
  assert.equal(timers.size, 0);
  const retried = await fetchEta("route", "stop", "I");
  assert.equal(retried.first.seq, 1);
  assert.equal(requests, 2);
});

for (const phase of ["connection", "successful body", "error body"]) {
  test(`the 8-second ETA timeout covers a stalled ${phase} and permits a fresh retry`, async (t) => {
    const timers = fakeTimeouts(t);
    let signal;
    let requests = 0;
    const abortableWait = () => new Promise((resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("aborted by signal")), { once: true });
    });
    t.mock.method(globalThis, "fetch", async (url, options) => {
      requests++;
      if (requests > 1) return { ok: true, json: async () => payload() };
      signal = options.signal;
      if (phase === "connection") return abortableWait();
      return { ok: phase === "successful body", status: 503, json: abortableWait };
    });
    const { fetchEta } = await freshApi(`timeout-${phase.replaceAll(" ", "-")}`);
    let settled = false;
    const results = Promise.allSettled([
      fetchEta("route", "stop", "I"),
      fetchEta("route", "stop", "O"),
    ]).then((value) => { settled = true; return value; });
    await flush();
    assert.equal(requests, 1);
    assert.equal(timers.size, 1);
    assert.equal(signal.aborted, false);
    await timers.advance(7_999);
    assert.equal(signal.aborted, false);
    assert.equal(settled, false);
    await timers.advance(1);
    assert.equal(signal.aborted, true);
    for (const result of await results) {
      assert.equal(result.status, "rejected");
      assert.match(result.reason.message, /ETA request timed out/);
    }
    assert.equal(timers.size, 0);
    const recovered = await fetchEta("route", "stop", "I");
    assert.equal(recovered.first.seq, 1);
    assert.equal(requests, 2);
  });
}

test("a successful ETA response clears its timeout instead of aborting after completion", async (t) => {
  const timers = fakeTimeouts(t);
  let signal;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    signal = options.signal;
    return { ok: true, json: async () => payload() };
  });
  const { fetchEta } = await freshApi("success-clears-timeout");
  await fetchEta("route", "stop", "I");
  assert.equal(timers.size, 0);
  await timers.advance(20_000);
  assert.equal(signal.aborted, false);
});

test("stop metadata keeps its existing request behavior without an ETA timeout signal", async (t) => {
  const timers = fakeTimeouts(t);
  let options;
  t.mock.method(globalThis, "fetch", async (url, passedOptions) => {
    options = passedOptions;
    assert.match(url, /\/stop\/metadata-stop$/);
    return { ok: true, json: async () => ({ data: { stop: "metadata-stop", name_en: "Test stop", lat: "22.3", long: "114.1" } }) };
  });
  const { fetchStop } = await freshApi("metadata-unaffected");
  assert.deepEqual(await fetchStop("metadata-stop"), {
    id: "metadata-stop", nameEn: "Test stop", lat: 22.3, lng: 114.1,
  });
  assert.equal(options, undefined);
  assert.equal(timers.size, 0);
});

function sourceBundle() {
  return {
    snapshotMs: NOW - 5_000,
    receivedAtMs: NOW,
    generatedAt: iso(NOW),
    error: null,
    first: { eta: iso(NOW + 120_000), seq: 5, dir: "I", dest_en: "Central" },
    second: { eta: iso(NOW + 600_000), seq: 5, dir: "I", dest_en: "Central" },
  };
}

test("source identity remains stable across repeated 12-second receipts of the same ETA data", async () => {
  const { etaModelKey } = await freshApi("model-key-repeat-receipts");
  const initial = sourceBundle();
  const key = etaModelKey(initial);
  for (let check = 1; check <= 20; check++) {
    const sameSource = structuredClone(initial);
    sameSource.receivedAtMs += check * 12_000;
    sameSource.generatedAt = iso(NOW + check * 12_000);
    sameSource.error = check % 2 ? "unrelated UI metadata" : null;
    sameSource.first.eta_seq = check;
    sameSource.first.rmk_en = `receipt ${check}`;
    assert.equal(etaModelKey(sameSource), key,
      "fresh receipt metadata must not reject or restart geometry work for an unchanged source");
  }
});

test("source identity changes for every position-relevant revision, including the second arrival", async () => {
  const { etaModelKey } = await freshApi("model-key-source-revisions");
  const initial = sourceBundle();
  const key = etaModelKey(initial);
  const changes = [
    ["source snapshot", (value) => { value.snapshotMs++; }],
    ["first ETA", (value) => { value.first.eta = iso(NOW + 121_000); }],
    ["first occurrence", (value) => { value.first.seq++; }],
    ["first direction", (value) => { value.first.dir = "O"; }],
    ["first destination", (value) => { value.first.dest_en = "Admiralty"; }],
    ["second ETA", (value) => { value.second.eta = iso(NOW + 601_000); }],
    ["second occurrence", (value) => { value.second.seq++; }],
    ["second direction", (value) => { value.second.dir = "O"; }],
    ["second destination", (value) => { value.second.dest_en = "Admiralty"; }],
    ["removed first arrival", (value) => { value.first = null; }],
    ["removed second arrival", (value) => { value.second = null; }],
    ["arrival handoff", (value) => { [value.first, value.second] = [value.second, value.first]; }],
  ];
  for (const [label, change] of changes) {
    const revised = structuredClone(initial);
    change(revised);
    assert.notEqual(etaModelKey(revised), key, `${label} must invalidate pending geometry's source identity`);
  }
});

test("missing ETA bundles and absent arrival fields have safe deterministic source identities", async () => {
  const { etaModelKey } = await freshApi("model-key-missing-bundles");
  const emptyKey = etaModelKey(undefined);
  assert.equal(typeof emptyKey, "string");
  for (const empty of [null, {}, { first: null, second: null }, { snapshotMs: null, first: undefined }]) {
    assert.equal(etaModelKey(empty), emptyKey);
  }
  const remarkOnly = { first: { rmk_en: "No scheduled service" }, second: null };
  assert.equal(etaModelKey(remarkOnly), etaModelKey({ first: {}, second: undefined }));
  assert.notEqual(etaModelKey({ snapshotMs: NOW }), emptyKey,
    "a source snapshot remains relevant even when no arrival is currently provided");
});
