import assert from "node:assert/strict";
import test from "node:test";
import { inferEtaSequenceOffset } from "../js/estimate.js";

function observation(stopId, seq, firstSeq, secondSeq) {
  return {
    stopId,
    seq,
    eta: {
      first: firstSeq === undefined ? null : { seq: firstSeq },
      second: secondSeq === undefined ? null : { seq: secondSeq },
    },
  };
}

for (const offset of [15, 0, -2]) {
  test(`two distinct anchors consistently establish offset ${offset}`, () => {
    const observations = [
      observation("A", 4, 4 + offset, 4 + offset),
      observation("B", 9, 9 + offset, 9 + offset),
    ];
    assert.equal(inferEtaSequenceOffset(observations), offset);
  });
}

test("one physical anchor is insufficient even with two arrivals", () => {
  assert.equal(inferEtaSequenceOffset([observation("A", 4, 19, 19)]), null);
});

test("empty, missing, and incomplete observation lists cannot establish an offset", () => {
  for (const observations of [
    [],
    null,
    undefined,
    [null, undefined],
    [{ stopId: "A", seq: 4, eta: null }, { stopId: "B", seq: 9 }],
    [observation("A", 4, 19), observation("B", 9, undefined)],
  ]) {
    assert.equal(inferEtaSequenceOffset(observations), null);
  }
});

test("different offsets across distinct anchors reject calibration", () => {
  assert.equal(inferEtaSequenceOffset([
    observation("A", 4, 19),
    observation("B", 9, 25),
  ]), null);
});

test("conflicting first and second arrival sequences reject calibration", () => {
  assert.equal(inferEtaSequenceOffset([
    observation("A", 4, 19, 20),
    observation("B", 9, 24, 24),
  ]), null);
});

test("duplicate observations of the same stop never count as two anchors", () => {
  const anchor = observation("A", 4, 19, 19);
  assert.equal(inferEtaSequenceOffset([anchor, structuredClone(anchor)]), null);
});

test("duplicate agreeing observations can accompany a genuinely distinct anchor", () => {
  const anchor = observation("A", 4, 19, 19);
  assert.equal(inferEtaSequenceOffset([
    anchor,
    structuredClone(anchor),
    observation("B", 9, 24),
  ]), 15);
});

test("duplicate physical IDs with conflicting canonical positions reject calibration", () => {
  assert.equal(inferEtaSequenceOffset([
    observation("A", 4, 19),
    observation("A", 5, 19),
    observation("B", 9, 24),
  ]), null);
});

test("numeric strings are normalized for canonical and API sequences", () => {
  assert.equal(inferEtaSequenceOffset([
    observation("A", "4", "19", 19),
    observation("B", 9, "24", " 24 "),
  ]), 15);
});

test("remark-only records provide sequence metadata without an ETA timestamp", () => {
  const observations = [
    { stopId: "A", seq: 4, eta: { first: { seq: 19, eta: null, rmk_en: "Scheduled" } } },
    { stopId: "B", seq: 9, eta: { second: { seq: 24, rmk_en: "No scheduled service" } } },
  ];
  assert.equal(inferEtaSequenceOffset(observations), 15);
});

test("malformed API sequences are ignored rather than contributing an offset", () => {
  const malformed = [null, "", " ", NaN, Infinity, -Infinity, 0, -1, 1.5, "bad", "1.5"];
  for (const value of malformed) {
    assert.equal(inferEtaSequenceOffset([
      observation("A", 4, 19),
      observation("B", 9, value),
    ]), null, `invalid second anchor sequence ${String(value)}`);
  }
});

test("malformed extra records do not override two consistent valid anchors", () => {
  assert.equal(inferEtaSequenceOffset([
    observation("A", 4, 19, ""),
    observation("B", 9, null, 24),
    observation("C", 12, "bad", NaN),
  ]), 15);
});

test("the ETA rank field is not substituted for a missing route-stop sequence", () => {
  assert.equal(inferEtaSequenceOffset([
    observation("A", 4, 19),
    { stopId: "B", seq: 9, eta: { first: { eta_seq: 24 } } },
  ]), null);
});

test("calibration does not mutate observations or arrival metadata", () => {
  const observations = [observation("A", "4", "19", 19), observation("B", 9, "24")];
  const original = structuredClone(observations);
  for (const entry of observations) {
    if (entry.eta.first) Object.freeze(entry.eta.first);
    if (entry.eta.second) Object.freeze(entry.eta.second);
    Object.freeze(entry.eta);
    Object.freeze(entry);
  }
  Object.freeze(observations);

  assert.equal(inferEtaSequenceOffset(observations), 15);
  assert.deepEqual(observations, original);
});
