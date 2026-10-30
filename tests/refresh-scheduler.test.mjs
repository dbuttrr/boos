import assert from "node:assert/strict";
import test from "node:test";
import { createRefreshScheduler } from "../js/refreshScheduler.js";

const ORIGIN = Date.UTC(2026, 9, 30, 6);
const FOCUSED_MS = 12_000;
const WATCHLIST_MS = 60_000;

async function flush() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fakeClock(t) {
  let now = ORIGIN;
  let nextId = 1;
  const timers = new Map();
  t.mock.method(Date, "now", () => now);
  t.mock.method(globalThis, "setTimeout", (callback, delay = 0) => {
    const id = nextId++;
    timers.set(id, { callback, at: now + Math.max(0, delay) });
    return id;
  });
  t.mock.method(globalThis, "clearTimeout", (id) => timers.delete(id));
  return {
    get elapsed() { return now - ORIGIN; },
    get pendingTimers() { return timers.size; },
    async advance(ms) {
      const target = now + ms;
      await flush();
      let iterations = 0;
      while (true) {
        const next = [...timers.entries()]
          .filter(([, timer]) => timer.at <= target)
          .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!next) break;
        assert.ok(++iterations < 1_000, "scheduler must not hot-loop overdue or in-flight IDs");
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

function harness(t, { entries = ["focused", "other"], focused = ["focused"], onRefresh = async () => [] } = {}) {
  const clock = fakeClock(t);
  let entryIds = [...entries];
  let focusedIds = [...focused];
  let active = true;
  const calls = [];
  const countdowns = [];
  const scheduler = createRefreshScheduler({
    getEntryIds: () => entryIds,
    getFocusedIds: () => focusedIds,
    onRefresh: (ids) => {
      calls.push({ at: clock.elapsed, ids: [...ids] });
      return onRefresh(ids);
    },
    isActive: () => active,
    onCountdown: (state) => countdowns.push(state),
  });
  t.after(() => scheduler.pause());
  return {
    scheduler, clock, calls, countdowns,
    times: (id) => calls.filter((call) => call.ids.includes(id)).map((call) => call.at),
    setEntries: (ids) => { entryIds = [...ids]; },
    setFocused: (ids) => { focusedIds = [...ids]; },
    setActive: (value) => { active = value; },
    get countdown() { return countdowns.at(-1); },
  };
}

test("focused entries check every 12 seconds while all other entries stay on minute deadlines", async (t) => {
  const h = harness(t, { entries: ["a", "b", "c"], focused: ["a", "b"] });
  h.scheduler.start();
  await h.clock.advance(3 * WATCHLIST_MS);
  const focusedTimes = Array.from({ length: 16 }, (_, i) => i * FOCUSED_MS);
  assert.deepEqual(h.times("a"), focusedTimes);
  assert.deepEqual(h.times("b"), focusedTimes);
  assert.deepEqual(h.times("c"), [0, 60_000, 120_000, 180_000]);
  const minuteBatch = h.calls.find((call) => call.at === 60_000);
  assert.deepEqual(new Set(minuteBatch.ids), new Set(["a", "b", "c"]));
});

test("unfocused checks never learn a longer interval from missed or inconsistent snapshots", async (t) => {
  let published = ORIGIN;
  const h = harness(t, {
    focused: [],
    onRefresh: async () => {
      published += 120_000;
      return [published, null, published + 45_000];
    },
  });
  h.scheduler.start();
  await h.clock.advance(4 * WATCHLIST_MS);
  assert.deepEqual(h.times("focused"), [0, 60_000, 120_000, 180_000, 240_000]);
  assert.deepEqual(h.times("other"), [0, 60_000, 120_000, 180_000, 240_000]);
});

test("request duration does not shift the next focused deadline from its request start", async (t) => {
  const first = deferred();
  let initial = true;
  const h = harness(t, {
    onRefresh: () => {
      if (initial) { initial = false; return first.promise; }
      return Promise.resolve();
    },
  });
  h.scheduler.start();
  await h.clock.advance(8_000);
  assert.deepEqual(h.times("focused"), [0]);
  first.resolve();
  await flush();
  await h.clock.advance(3_999);
  assert.deepEqual(h.times("focused"), [0]);
  await h.clock.advance(1);
  assert.deepEqual(h.times("focused"), [0, 12_000]);
  assert.deepEqual(h.times("other"), [0]);
});

test("promoting another focused entry checks it immediately without resetting existing deadlines", async (t) => {
  const h = harness(t);
  h.scheduler.start();
  await h.clock.advance(5_000);
  h.setFocused(["focused", "other"]);
  h.scheduler.notifyEntriesChanged();
  await flush();
  assert.deepEqual(h.times("focused"), [0]);
  assert.deepEqual(h.times("other"), [0, 5_000]);
  await h.clock.advance(12_000);
  assert.deepEqual(h.times("focused"), [0, 12_000]);
  assert.deepEqual(h.times("other"), [0, 5_000, 17_000]);
});

test("demotion returns an entry to a minute from its last check without delaying unrelated routes", async (t) => {
  const h = harness(t);
  h.scheduler.start();
  await h.clock.advance(13_000);
  h.setFocused([]);
  h.scheduler.notifyEntriesChanged();
  await h.clock.advance(59_000);
  assert.deepEqual(h.times("focused"), [0, 12_000, 72_000]);
  assert.deepEqual(h.times("other"), [0, 60_000]);
});

test("new entries check immediately and removed entries never run again", async (t) => {
  const h = harness(t, { entries: ["a"], focused: ["a"] });
  h.scheduler.start();
  await h.clock.advance(5_000);
  h.setEntries(["a", "b"]);
  h.scheduler.notifyEntriesChanged();
  await flush();
  assert.deepEqual(h.times("b"), [5_000]);
  await h.clock.advance(1_000);
  h.setEntries(["b"]);
  h.setFocused([]);
  h.scheduler.notifyEntriesChanged();
  await h.clock.advance(59_000);
  assert.deepEqual(h.times("a"), [0]);
  assert.deepEqual(h.times("b"), [5_000, 65_000]);
});

test("an empty watchlist has no timer and an orphan focus ID is never fetched", async (t) => {
  const h = harness(t, { entries: [], focused: ["orphan"] });
  h.scheduler.start();
  await h.clock.advance(180_000);
  assert.deepEqual(h.calls, []);
  assert.equal(h.clock.pendingTimers, 0);
  assert.equal(h.countdown.nextAtMs, null);
  h.setEntries(["new"]);
  h.setFocused(["orphan", "new"]);
  h.scheduler.notifyEntriesChanged();
  await h.clock.advance(12_000);
  assert.deepEqual(h.times("new"), [180_000, 192_000]);
  assert.deepEqual(h.times("orphan"), []);
});

test("manual refresh resets only newly started request deadlines", async (t) => {
  const h = harness(t);
  h.scheduler.start();
  await h.clock.advance(5_000);
  await h.scheduler.refreshNow();
  await h.clock.advance(12_000);
  assert.deepEqual(h.times("focused"), [0, 5_000, 17_000]);
  assert.deepEqual(h.times("other"), [0, 5_000]);
  await h.clock.advance(48_000);
  assert.deepEqual(h.times("other"), [0, 5_000, 65_000]);
});

test("manual refresh joins an existing request without an overlapping or queued duplicate", async (t) => {
  const pending = deferred();
  let hold = true;
  const h = harness(t, { onRefresh: () => hold ? pending.promise : Promise.resolve() });
  h.scheduler.start();
  await h.clock.advance(5_000);
  let settled = false;
  const manual = h.scheduler.refreshNow().then(() => { settled = true; });
  await flush();
  assert.equal(settled, false);
  assert.equal(h.calls.length, 1);
  hold = false;
  pending.resolve();
  await manual;
  await h.clock.advance(0);
  assert.equal(h.calls.length, 1, "completion must not queue another copy of the manual request");
  await h.clock.advance(7_000);
  assert.deepEqual(h.times("focused"), [0, 12_000]);
});

test("a pending focused request cannot block due checks for a disjoint entry", async (t) => {
  const pending = deferred();
  let hold = true;
  const h = harness(t, {
    onRefresh: (ids) => ids.length === 1 && ids[0] === "focused" && hold
      ? pending.promise : Promise.resolve(),
  });
  h.scheduler.start();
  await h.clock.advance(60_000);
  assert.deepEqual(h.times("focused"), [0, 12_000]);
  assert.deepEqual(h.times("other"), [0, 60_000]);
  assert.ok(h.clock.pendingTimers <= 1, "an in-flight overdue ID must not create a hot timer");
  hold = false;
  pending.resolve();
  await h.clock.advance(0);
  assert.deepEqual(h.times("focused"), [0, 12_000, 60_000], "only one overdue check runs after completion");
  await h.clock.advance(12_000);
  assert.deepEqual(h.times("focused"), [0, 12_000, 60_000, 72_000]);
});

test("promoting an in-flight entry coalesces the current check and adopts the short deadline", async (t) => {
  const pending = deferred();
  let hold = true;
  const h = harness(t, { focused: [], onRefresh: () => hold ? pending.promise : Promise.resolve() });
  h.scheduler.start();
  await h.clock.advance(5_000);
  h.setFocused(["focused"]);
  h.scheduler.notifyEntriesChanged();
  await flush();
  assert.equal(h.calls.length, 1);
  hold = false;
  pending.resolve();
  await h.clock.advance(7_000);
  assert.deepEqual(h.times("focused"), [0, 12_000]);
  assert.deepEqual(h.times("other"), [0]);
});

test("pause stops dispatch and resume checks current entries immediately without replaying missed ticks", async (t) => {
  const h = harness(t);
  h.scheduler.start();
  await h.clock.advance(5_000);
  h.setActive(false);
  h.scheduler.pause();
  assert.equal(h.clock.pendingTimers, 0);
  assert.equal(h.countdown.nextAtMs, null);
  await h.clock.advance(120_000);
  assert.equal(h.calls.length, 1);
  h.setActive(true);
  h.scheduler.resume();
  await h.clock.advance(12_000);
  assert.deepEqual(h.times("focused"), [0, 125_000, 137_000]);
  assert.deepEqual(h.times("other"), [0, 125_000]);
});

test("completion after pause cannot resurrect a timer or dispatch hidden requests", async (t) => {
  const pending = deferred();
  const h = harness(t, { onRefresh: () => pending.promise });
  h.scheduler.start();
  await h.clock.advance(5_000);
  h.setActive(false);
  h.scheduler.pause();
  await h.clock.advance(120_000);
  pending.resolve();
  await h.clock.advance(120_000);
  assert.equal(h.calls.length, 1);
  assert.equal(h.clock.pendingTimers, 0);
  assert.equal(h.countdown.nextAtMs, null);
});

test("resume joins a still-running request without duplicating it or shifting its deadline", async (t) => {
  const pending = deferred();
  let hold = true;
  const h = harness(t, { onRefresh: () => hold ? pending.promise : Promise.resolve() });
  h.scheduler.start();
  await h.clock.advance(5_000);
  h.setActive(false);
  h.scheduler.pause();
  await h.clock.advance(2_000);
  h.setActive(true);
  h.scheduler.resume();
  await flush();
  assert.equal(h.calls.length, 1);
  await h.clock.advance(1_000);
  hold = false;
  pending.resolve();
  await h.clock.advance(4_000);
  assert.deepEqual(h.times("focused"), [0, 12_000]);
  assert.deepEqual(h.times("other"), [0]);
});

test("removed pending entries cannot keep the scheduler busy or overwrite new entry deadlines", async (t) => {
  const old = deferred();
  const h = harness(t, { entries: ["old"], focused: ["old"], onRefresh: (ids) => ids.includes("old") ? old.promise : Promise.resolve() });
  h.scheduler.start();
  await h.clock.advance(5_000);
  h.setEntries([]);
  h.setFocused([]);
  h.scheduler.notifyEntriesChanged();
  await flush();
  assert.equal(h.clock.pendingTimers, 0);
  assert.equal(h.countdown.nextAtMs, null);
  h.setEntries(["new"]);
  h.setFocused(["new"]);
  h.scheduler.notifyEntriesChanged();
  await flush();
  old.resolve();
  await h.clock.advance(12_000);
  assert.deepEqual(h.times("old"), [0]);
  assert.deepEqual(h.times("new"), [5_000, 17_000]);
});

for (const failure of ["synchronous", "rejected"]) {
  test(`a ${failure} refresh failure recovers at the fixed deadline without a retry loop`, async (t) => {
    t.mock.method(console, "warn", () => {});
    let first = true;
    const h = harness(t, {
      onRefresh: () => {
        if (!first) return Promise.resolve();
        first = false;
        if (failure === "synchronous") throw new Error("offline");
        return Promise.reject(new Error("offline"));
      },
    });
    h.scheduler.start();
    await h.clock.advance(12_000);
    assert.deepEqual(h.times("focused"), [0, 12_000]);
    assert.deepEqual(h.times("other"), [0]);
    assert.equal(h.clock.pendingTimers, 1);
  });
}

test("countdown uses the earliest selected deadline and clears when paused", async (t) => {
  const pending = deferred();
  const h = harness(t, { onRefresh: () => pending.promise });
  h.scheduler.start();
  await flush();
  assert.equal(h.countdown.mode, "refreshing");
  pending.resolve();
  await flush();
  assert.equal(h.countdown.mode, "idle");
  assert.equal(h.countdown.nextAtMs, ORIGIN + 12_000);
  h.setFocused([]);
  h.scheduler.notifyEntriesChanged();
  await flush();
  assert.equal(h.countdown.nextAtMs, ORIGIN + 60_000);
  h.scheduler.pause();
  assert.equal(h.countdown.nextAtMs, null);
});

test("inactive documents do not dispatch startup or manual refresh requests", async (t) => {
  const h = harness(t);
  h.setActive(false);
  h.scheduler.start();
  await h.scheduler.refreshNow();
  await h.clock.advance(120_000);
  assert.deepEqual(h.calls, []);
  assert.equal(h.clock.pendingTimers, 0);
});

test("unchanged membership notifications preserve every entry's existing deadline", async (t) => {
  const h = harness(t);
  h.scheduler.start();
  for (let second = 0; second < 65; second++) {
    await h.clock.advance(1_000);
    h.scheduler.notifyEntriesChanged();
    await flush();
  }
  assert.deepEqual(h.times("focused"), [0, 12_000, 24_000, 36_000, 48_000, 60_000]);
  assert.deepEqual(h.times("other"), [0, 60_000]);
});

test("removing and re-adding an in-flight ID joins the same request without an immediate repeat", async (t) => {
  const pending = deferred();
  let hold = true;
  const h = harness(t, { entries: ["a"], focused: ["a"], onRefresh: () => hold ? pending.promise : Promise.resolve() });
  h.scheduler.start();
  await h.clock.advance(3_000);
  h.setEntries([]);
  h.scheduler.notifyEntriesChanged();
  h.setEntries(["a"]);
  h.scheduler.notifyEntriesChanged();
  await flush();
  assert.deepEqual(h.times("a"), [0]);
  hold = false;
  pending.resolve();
  await h.clock.advance(0);
  assert.deepEqual(h.times("a"), [0]);
  await h.clock.advance(9_000);
  assert.deepEqual(h.times("a"), [0, 12_000]);
});

test("pause or removal before asynchronous dispatch prevents starting obsolete network work", async (t) => {
  const h = harness(t);
  h.scheduler.start();
  h.scheduler.pause();
  await flush();
  assert.deepEqual(h.calls, []);
  h.scheduler.resume();
  h.setEntries([]);
  h.scheduler.notifyEntriesChanged();
  await flush();
  assert.deepEqual(h.calls, []);
  assert.equal(h.clock.pendingTimers, 0);
});
