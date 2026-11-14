import { D, parseDateTime } from "@cashu/domain";
import { market, toCurrency } from "@cashu/domain/investments";
import { describe, expect, it } from "vitest";
import { createProfile, setModules } from "../../core/commands.js";
import { watchQuery } from "../../query.js";
import { createAlert } from "../commands/alertWrites.js";
import { snoozeSignalCommand } from "../commands/signals.js";
import { applyRaw, raw, rawGid, stock, vault } from "../commands/testing/fixtures.js";
import { addToWatchlist } from "../commands/watchlist.js";
import { readAlertRows } from "./alertRows.js";
import { signalsOwnerCommands } from "./commands.js";
import { readSignalRows } from "./reads.js";
import { signalsQueries } from "./screen.js";

const args = {
  now: "2026-10-31T12:00:00Z",
  today: "2026-10-31",
  timeZone: "Europe/Warsaw",
  lang: "en" as const,
  privacy: false,
};
function fixture() {
  const v = vault({ holder: false });
  v.value(createProfile, { slug: "synthetic", name: "Synthetic", modules: ["investments"] });
  const instrument = stock(v, "TEST", "PL0000000001", {
    aliases: [{ namespace: "yahoo", value: "TEST.WA" }],
  });
  v.value(addToWatchlist, { target: { stored: instrument } });
  return { v, instrument, read: v.store.read.bind(v.store) };
}
describe("native Signals projection", () => {
  it("shares one position decision under every covered canonical episode and updates after undo", () => {
    const { v, instrument, read } = fixture();
    try {
      const a = rawGid(510),
        b = rawGid(511);
      applyRaw(v, [
        raw.signalOpened(a, "first", { instrument }),
        raw.signalOpened(b, "second", { instrument }),
      ]);
      const query = signalsQueries().screen;
      const snapshots: ReturnType<typeof query.run>[] = [];
      const stop = watchQuery(v.store, query, args, {
        onValue: (value) => snapshots.push(value),
        onError: (error) => {
          throw error;
        },
      });
      try {
        const saved = v.value(signalsOwnerCommands.positionDecision, {
          instrument,
          signals: [a, b],
          action: "held",
        });
        const after = snapshots.at(-1);
        expect(after?.status).toBe("ready");
        if (after?.status !== "ready") throw new Error("missing actual snapshot");
        expect(after.context).toEqual({
          status: "unavailable",
          reason: "current_files_unavailable",
        });
        expect(after.open).toHaveLength(2);
        for (const row of after.open) {
          expect(row.decisions).toHaveLength(1);
          expect(row.decisions[0]).toMatchObject({ gid: saved.decision, signals: [a, b] });
          expect(row.instrument).toBe(instrument);
          expect(row.status).toBe("acknowledged");
        }
        v.value(signalsOwnerCommands.undo, { decision: saved.decision });
        expect(
          readSignalRows(read, args.now).every(
            (row) => row.decisions.length === 0 && row.status === "active",
          ),
        ).toBe(true);
      } finally {
        stop();
      }
    } finally {
      v.store.close();
    }
  });
  it("keeps currentness tied to the last good run and evaluates snooze at the requested clock", () => {
    const { v, instrument, read } = fixture();
    try {
      const old = rawGid(520),
        good = rawGid(521),
        failed = rawGid(522),
        signal = rawGid(523);
      applyRaw(v, [
        raw.ruleRun(old),
        raw.signalOpened(signal, "old", { instrument, run: old }),
        raw.ruleRun(good, { startedAt: "2026-10-31T08:00:00Z" }),
        raw.ruleRun(failed, { status: "failed", startedAt: "2026-10-31T09:00:00Z" }),
      ]);
      v.value(snoozeSignalCommand, { signal, until: "2026-11-01T00:00:00Z" });
      expect(readSignalRows(read, args.now)[0]).toMatchObject({ current: false, snoozed: true });
      expect(readSignalRows(read, "2026-11-01T00:00:00Z")[0]).toMatchObject({
        current: false,
        snoozed: false,
      });
      // This read never wakes or evaluates the stored episode.
      expect(readSignalRows(read, args.now)[0]?.snoozed).toBe(true);
    } finally {
      v.store.close();
    }
  });
  it("does not publish private payloads for privacy or a disabled module", () => {
    const { v, instrument, read } = fixture();
    try {
      applyRaw(v, [
        raw.signalOpened(rawGid(530), "private", {
          instrument,
          message: "Synthetic private prose",
        }),
      ]);
      const q = signalsQueries().screen;
      expect(q.run(read, { ...args, privacy: true })).toEqual({
        status: "unavailable",
        reason: "privacy",
      });
      v.value(setModules, { moduleIds: ["budget"] });
      expect(q.run(read, args)).toEqual({ status: "unavailable", reason: "module_disabled" });
      expect(v.run(signalsOwnerCommands.acknowledge, { signal: rawGid(530) })).toEqual({
        ok: false,
        reason: "module_disabled",
      });
    } finally {
      v.store.close();
    }
  });
});

it("enriches a shared-open alias without splitting its decision coverage", () => {
  const { v, instrument, read } = fixture();
  try {
    const canonical = rawGid(540),
      alias = rawGid(541);
    applyRaw(v, [
      raw.signalOpened(canonical, "shared", { instrument }),
      raw.signalOpened(alias, "shared", { instrument }),
    ]);
    const saved = v.value(signalsOwnerCommands.positionDecision, {
      instrument,
      signals: [alias],
      action: "held",
    });
    const rows = readSignalRows(read, args.now);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      gid: canonical,
      decisions: [{ gid: saved.decision, signals: [canonical] }],
    });
  } finally {
    v.store.close();
  }
});

it("retains effective alert order and honest dynamic-state availability without a market capability", () => {
  const { v, instrument, read } = fixture();
  try {
    const dynamic = v.value(createAlert, {
      kind: "volume_spike",
      scope: "instrument",
      instrument,
      params: { window_days: 5, multiple: 2 },
      title: "Synthetic volume",
    }).alert;
    const price = v.value(createAlert, {
      kind: "price_above",
      scope: "instrument",
      instrument,
      params: { level: 10 },
      title: "Synthetic price",
      source: "user",
      createdBy: "app",
    }).alert;
    const q = signalsQueries().screen.run(read, args);
    if (q.status !== "ready") throw new Error("expected ready");
    expect(q.alerts.map((row) => row.gid)).toEqual([price, dynamic]);
    expect(q.alerts.find((row) => row.gid === dynamic)).toMatchObject({
      state: null,
      stateUnavailable: true,
    });
    expect(q.alerts.find((row) => row.gid === price)).toMatchObject({
      source: "user",
      createdBy: "app",
      instrumentDetail: { id: instrument },
    });
  } finally {
    v.store.close();
  }
});

it("reads the actual cached volume level without changing stored trigger or checked state", () => {
  const { v, instrument, read } = fixture();
  try {
    const alert = v.value(createAlert, {
      kind: "volume_spike",
      instrument,
      params: { window_days: 5, multiple: 2 },
      title: "Synthetic volume",
    }).alert;
    const prices = new market.InMemoryPriceCache();
    prices.upsertBars(
      market.marketSymbol("yahoo", "TEST.WA"),
      Array.from({ length: 6 }, (_, index) => ({
        date: `2026-10-${24 + index}`,
        close: D("10"),
        open: null,
        high: null,
        low: null,
        volume: index === 5 ? 300 : 100,
        currency: toCurrency("PLN"),
        fetchedAt: null,
      })),
      parseDateTime(args.now),
    );
    const row = readAlertRows(read, args.now, args.today, { prices }).find(
      (item) => item.gid === alert,
    );
    expect(row).toMatchObject({
      status: "active",
      lastCheckedAt: null,
      stateUnavailable: false,
      state: { average_volume: 100, volume: 300, ratio: 3 },
    });
    expect(
      readAlertRows(read, args.now, args.today, null).find((item) => item.gid === alert),
    ).toMatchObject({ status: "active", lastCheckedAt: null });
  } finally {
    v.store.close();
  }
});
