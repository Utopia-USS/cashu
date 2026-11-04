import { setLanguageForTests } from "@cashu/i18n";
import { beforeEach, describe, expect, it } from "vitest";
import {
  alertCurrentValue,
  alertLine,
  filterAlerts,
  historyCsv,
  observedValue,
} from "./alertModels.js";
import { journalModel } from "./journalModels.js";
import { signalGroups } from "./presentation.js";
import {
  decisionHeader,
  groupOfSignal,
  groupSection,
  minuteInstant,
  movedCursor,
  railRows,
  signalLine,
  snoozeInstant,
  suggestedAction,
} from "./signalModels.js";
import { signalsStorySnapshot } from "./storyState.js";
import { watchHit, watchRow } from "./watchModels.js";

beforeEach(() => setLanguageForTests("en"));
const data = signalsStorySnapshot();
const signal = data.signals[0];
if (!signal) throw new Error("synthetic snapshot has a signal");
const alert = data.alerts[0];
if (!alert) throw new Error("synthetic snapshot has an alert");
const context = data.context;
if (context.status !== "ready") throw new Error("synthetic snapshot has a ready context");

describe("signal groups", () => {
  const groups = signalGroups(data.open, data.held, "all");
  const second = { ...signal, gid: "second", firstSeenAt: "2026-11-02T12:00:00Z" };
  const two = signalGroups([signal, second], data.held, "all");

  it("lists open groups on the rail with their live count and the signal to focus", () => {
    expect(railRows(groups)).toEqual([
      { key: `i:${signal.instrument}`, label: "SYN", live: 1, tone: "positive", focus: signal.gid },
    ]);
  });

  it("splits the dialog into portfolio and watched sections with signal counts", () => {
    expect(groupSection(groups, "watched", null).signals).toBe(1);
    expect(groupSection(groups, "portfolio", null)).toEqual({ rows: [], signals: 0 });
  });

  it("clamps the keyboard cursor to the listed signals and finds the cursor's group", () => {
    expect(movedCursor(two, signal.gid, 1)).toBe("second");
    expect(movedCursor(two, "second", 1)).toBe("second");
    expect(movedCursor(two, signal.gid, -1)).toBe(signal.gid);
    expect(groupOfSignal(two, "second")).toBe(`i:${signal.instrument}`);
    expect(groupOfSignal(two, "missing")).toBeNull();
  });

  it("offers deferral only for an undecided, unsnoozed signal with a deposit plan", () => {
    expect(signalLine(signal, "2026-11-10").deferUntil).toBe("2026-11-10");
    expect(signalLine(signal, null).deferUntil).toBeNull();
    expect(signalLine({ ...signal, snoozed: true }, "2026-11-10").deferUntil).toBeNull();
  });

  it("titles the decision dialog and counts the context beyond five rows", () => {
    const many = Array.from({ length: 7 }, (_, index) => ({ ...signal, gid: `s${index}` }));
    const [group] = signalGroups(many, [], "all");
    const header = decisionHeader(group ?? null);
    expect(header.title).toBe("SYN");
    expect(header.context).toHaveLength(5);
    expect(header.more).toBe(2);
    expect(decisionHeader(null)).toEqual({ title: "", context: [], more: 0 });
  });
});

it("maps a suggestion to the form action and the deposit day to its local end", () => {
  expect(suggestedAction("buy")).toBe("bought");
  expect(suggestedAction("sell")).toBe("sold");
  expect(suggestedAction("later")).toBe("other");
  expect(suggestedAction("none")).toBe("held");
  expect(snoozeInstant("2026-11-10")).toBe(new Date("2026-11-10T23:59:00").toISOString());
});

it("keeps one read clock per minute so Suspense retries share a query key", () => {
  expect(minuteInstant(new Date("2026-11-03T12:34:56.789Z"))).toBe("2026-11-03T12:34:00.000Z");
});

describe("alerts", () => {
  it("filters by state and source", () => {
    expect(filterAlerts(data.alerts, "triggered", "user")).toHaveLength(1);
    expect(filterAlerts(data.alerts, "muted", "all")).toHaveLength(0);
    expect(filterAlerts(data.alerts, "all", "agent")).toHaveLength(0);
  });

  it("shows the last value in the unit of the condition", () => {
    expect(alertCurrentValue(alert)).toMatchObject({ kind: "money" });
    expect(alertCurrentValue({ ...alert, kind: "volume_spike" })).toMatchObject({
      kind: "multiple",
    });
    expect(alertCurrentValue({ ...alert, unit: "ratio" })).toMatchObject({ kind: "ratio" });
    expect(alertCurrentValue({ ...alert, lastValue: null })).toEqual({ kind: "none" });
    expect(alertCurrentValue({ ...alert, instrumentDetail: null })).toMatchObject({
      kind: "amount",
      fractionDigits: 2,
    });
    expect(observedValue(signal)).toMatchObject({ kind: "money" });
  });

  it("lists an alert with its badge state and agent origin", () => {
    expect(alertLine(alert)).toMatchObject({
      gid: alert.gid,
      status: "triggered",
      muted: false,
      fromAgent: false,
      symbol: "SYN",
      signalStatus: "active",
    });
  });

  it("exports the history as BOM CSV and labels a deleted alert", () => {
    const csv = historyCsv([signal], []);
    expect(csv.startsWith("﻿")).toBe(true);
    expect(csv).toContain("Deleted alert");
    expect(historyCsv([signal], data.alerts)).toContain("Synthetic price alert");
  });
});

describe("watchlist", () => {
  const raw = context.watchlist[0];
  if (!raw) throw new Error("synthetic snapshot has a watch row");

  it("maps the wire row to a camelCase view model with quote and trend", () => {
    const row = watchRow(raw);
    expect(row).toMatchObject({
      id: raw.id,
      instrumentId: raw.instrument_id,
      label: "SYN",
      held: false,
      fromAgent: false,
      note: "Synthetic watch note",
      tags: ["demo"],
      spark: [143, 148.625],
      liveAlerts: 1,
    });
    expect(row.quote?.close).toMatchObject({ kind: "money" });
    expect(row.quote?.changeDay?.toString()).toBe("0.012");
  });

  it("drops a one-point trend and shows a currency-less quote as an amount", () => {
    const row = watchRow({
      ...raw,
      closes_30d: raw.closes_30d.slice(0, 1),
      instrument: { ...raw.instrument, currency: "" },
      price: raw.price === null ? null : { ...raw.price, currency: "" },
    } as typeof raw);
    expect(row.spark).toBeNull();
    expect(row.quote?.close).toMatchObject({ kind: "amount" });
  });

  it("opens a watched hit and adds any other", () => {
    const hit = {
      key: "k",
      instrument_id: null,
      state: "new" as const,
      symbol: "NEW",
      yahoo_symbol: null,
      name: "Synthetic new",
      exchange: null,
      mic: null,
      asset_class: "equity",
      currency: null,
      isin: null,
      source: "local" as const,
    };
    expect(watchHit(hit).opens).toBe(false);
    expect(watchHit({ ...hit, state: "watched" }).opens).toBe(true);
  });
});

it("builds the journal with undo still open only inside the window", () => {
  const model = journalModel(data, "", "all");
  expect(model).toMatchObject({ decisions: 1, signals: 1 });
  const decision = model.rows.find((row) => row.kind === "decision");
  expect(decision).toMatchObject({ undoable: true, linked: 1, reason: "Review next week" });
  const later = journalModel({ ...data, asOf: "2026-11-03T13:00:00Z" }, "", "decisions");
  expect(later.rows.find((row) => row.kind === "decision")).toMatchObject({ undoable: false });
  expect(later.rows.some((row) => row.kind === "signal")).toBe(false);
  expect(journalModel(data, "other", "all")).toMatchObject({ decisions: 0, signals: 0 });
});
