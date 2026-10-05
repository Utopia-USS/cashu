// Server timestamps (F7 FE1): an offset is honoured, a legacy naive value is UTC, a bare date is a local
// calendar day; the decided-signal "cofnij" link and the run time behave the same in Warsaw, UTC and New
// York. Node applies a runtime change of process.env.TZ, so each case runs in its own zone.
import assert from "node:assert/strict";
import { test } from "node:test";
import { addDays, hmLocal, localDay, parseServerTime, todayLocal } from "../src/time.ts";
import { canUndo, UNDO_WINDOW_MS } from "../src/modules/investments/undo.ts";
import { dm, hm } from "../src/modules/investments/labels.ts";
import { daysSince } from "../src/modules/investments/v2/logic.ts";

const inZone = (tz, fn) => {
  const prev = process.env.TZ;
  process.env.TZ = tz;
  try { fn(); } finally { if (prev === undefined) delete process.env.TZ; else process.env.TZ = prev; }
};
const ZONES = ["UTC", "Europe/Warsaw", "America/New_York"];
const AT = Date.UTC(2026, 9, 5, 10, 0, 0, 123);

test("offset, Z and naive server strings name the same instant in every zone", () => {
  for (const tz of ZONES) inZone(tz, () => {
    assert.equal(parseServerTime("2026-10-05T10:00:00.123456"), AT, tz);
    assert.equal(parseServerTime("2026-10-05T10:00:00.123456Z"), AT, tz);
    assert.equal(parseServerTime("2026-10-05T10:00:00.123+00:00"), AT, tz);
    assert.equal(parseServerTime("2026-10-05T12:00:00.123+02:00"), AT, tz);
    assert.equal(parseServerTime("2026-10-05 10:00:00.123"), AT, tz);
    assert.equal(parseServerTime("2026-10-05T12:00:00.123+0200"), AT, tz);
    assert.ok(Number.isNaN(parseServerTime("")));
    assert.ok(Number.isNaN(parseServerTime(null)));
    assert.ok(Number.isNaN(parseServerTime("wczoraj")));
  });
});

test("a bare date is the local calendar day, not UTC midnight", () => {
  inZone("America/New_York", () => {
    assert.equal(new Date(parseServerTime("2026-10-05")).getDate(), 5);
    assert.equal(localDay("2026-10-05"), "2026-10-05");
  });
});

test("the decided-signal undo link is offered one minute after the save in Warsaw, UTC and New York", () => {
  const saved = new Date(Date.now() - 60_000).toISOString().replace("Z", "");
  for (const tz of ZONES) inZone(tz, () => {
    assert.equal(canUndo({ id: 7, created_at: saved }), true, `naive, ${tz}`);
    assert.equal(canUndo({ id: 7, created_at: `${saved}Z` }), true, `Z, ${tz}`);
  });
  const old = new Date(Date.now() - 2 * 3600_000).toISOString().replace("Z", "");
  for (const tz of ZONES) inZone(tz, () => assert.equal(canUndo({ id: 7, created_at: old }), false, `2 h old, ${tz}`));
  assert.equal(canUndo({ id: 7, created_at: new Date(Date.now() - UNDO_WINDOW_MS + 5000).toISOString() }), true);
});

test("run time and day are shown in local time", () => {
  inZone("Europe/Warsaw", () => {
    assert.equal(hm("2026-10-05T08:00:00"), "10:00");
    assert.equal(hm("2026-10-05T08:00:00+00:00"), "10:00");
    assert.equal(hmLocal("2026-10-05"), "");
    // 23:30 UTC on 5 October is already 6 October in Poland.
    assert.equal(localDay("2026-10-05T23:30:00Z"), "2026-10-06");
    assert.equal(dm("2026-10-05T23:30:00"), "6.10");
    assert.equal(daysSince("2026-10-05T23:30:00", "2026-10-06T08:00:00Z"), 0);
  });
  inZone("UTC", () => assert.equal(hm("2026-10-05T08:00:00"), "08:00"));
});

test("today is the local calendar date around midnight", () => {
  inZone("Europe/Warsaw", () => {
    // 1 November 00:30 in Warsaw = 31 October 23:30 UTC.
    assert.equal(todayLocal(new Date(Date.UTC(2026, 9, 31, 23, 30))), "2026-11-01");
    assert.equal(addDays("2026-10-31", 1), "2026-11-01");
    assert.equal(addDays("2026-03-01", -1), "2026-02-28");
  });
});
