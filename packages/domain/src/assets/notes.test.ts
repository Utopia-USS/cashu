// Translation of the logic parts of tests/test_asset_notes.py (F7 OB5: manual positions carry an optional
// one-line note, max 500 characters, on create, patch and list; the note never leaves its profile). The
// HTTP validation of test_note_and_input_validation (type, negative value, duplicate name 409, revaluing
// a vehicle 422, 404 for a bank account) belongs to the API / store command layer.

import { describe, expect, it } from "vitest";
import { netWorth } from "../core/networth.js";
import { SyntheticProfile } from "../testing/netWorthProfile.js";
import { cleanNote, NOTE_MAX, notesOf } from "./service.js";

const TODAY = "2026-10-01";

function seed(): SyntheticProfile {
  const p = new SyntheticProfile(TODAY);
  const main = p.getOrCreateAccount({
    bank: "mbank",
    name: "mKonto Test",
    iban: "PL61109010140000071219812874",
  });
  p.setBalance(main.id, "2026-09-30", "5000.00", "csv");
  const cash = p.getOrCreateAccount({
    bank: "manual",
    name: "Gotówka",
    externalId: "cash:PLN",
    type: "cash",
  });
  p.setBalance(cash.id, "2026-09-30", "300.00");
  p.addManualPosition("Mieszkanie Test", "property", "600000", "2026-06-01");
  const mortgage = p.addManualPosition(
    "Kredyt hipoteczny Test",
    "mortgage",
    "390000",
    "2026-06-01",
  );
  p.writeTerms(mortgage.id, { principal: "400000", rate: "6.0", months: 300, start: "2025-01-05" });
  p.setVehicle("Auto Test", "80000", "2025-05-01", "15", "10000");
  return p;
}

const rows = (p: SyntheticProfile) => p.manualRows(netWorth(p.book()).lines);

/** `set_note`: store (or clear) the note of a position, as the service does. */
function setNote(p: SyntheticProfile, accountId: string, note: string | null): string | null {
  const cleaned = cleanNote(note);
  if (!cleaned.ok) throw new Error(cleaned.message);
  p.notes = [
    ...p.notes.filter((n) => n.accountId !== accountId),
    { accountId, note: cleaned.note },
  ];
  return cleaned.note;
}

describe("test_asset_notes.py", () => {
  it("test_list_shows_manual_positions_and_vehicles_with_a_null_note", () => {
    const names = new Map(rows(seed()).map((r) => [r.name, r]));
    for (const n of ["Mieszkanie Test", "Kredyt hipoteczny Test", "Auto Test"])
      expect(names.has(n)).toBe(true);
    expect(names.get("Auto Test")?.kind).toBe("vehicle");
    expect(names.get("Mieszkanie Test")?.kind).toBe("manual");
    expect(names.get("Kredyt hipoteczny Test")?.isLiability).toBe(true);
    expect([...names.values()].every((r) => r.note === null)).toBe(true);
    expect(names.has("Gotówka") || names.has("mKonto Test")).toBe(false); // cash pool / bank accounts
  });

  it("test_create_with_a_note_then_patch_and_clear_it", () => {
    const p = seed();
    const claim = p.addManualPosition("Wierzytelność Test", "other", "1200");
    expect(setNote(p, claim.id, "Zgłoszona do syndyka,\n termin 2026-12-31")).toBe(
      "Zgłoszona do syndyka, termin 2026-12-31",
    ); // one line
    const row = rows(p).find((r) => r.name === "Wierzytelność Test");
    expect([row?.note, row?.balance?.toString(), row?.kind, row?.currency]).toEqual([
      "Zgłoszona do syndyka, termin 2026-12-31",
      "1200",
      "manual",
      "PLN",
    ]);

    setNote(p, claim.id, "Wypłata częściowa");
    p.setBalance(claim.id, TODAY, "900"); // revalued: the note stays
    const revalued = rows(p).find((r) => r.name === "Wierzytelność Test");
    expect([revalued?.note, revalued?.balance?.toString()]).toEqual(["Wypłata częściowa", "900"]);
    expect(setNote(p, claim.id, null)).toBeNull();
    expect(rows(p).find((r) => r.name === "Wierzytelność Test")?.note).toBeNull();
    expect(p.notes.map((n) => n.note)).toEqual([null]);

    // a note on an existing seeded position
    const flat = rows(p).find((r) => r.name === "Mieszkanie Test");
    setNote(p, flat?.id as string, "Wycena 2026");
    expect(rows(p).find((r) => r.name === "Mieszkanie Test")?.note).toBe("Wycena 2026");
  });

  it("test_note_and_input_validation (note rules)", () => {
    const tooLong = cleanNote("x".repeat(NOTE_MAX + 1));
    expect(tooLong.ok).toBe(false);
    expect(tooLong.ok ? "" : tooLong.message).toContain("500");
    expect(cleanNote("x".repeat(NOTE_MAX))).toEqual({ ok: true, note: "x".repeat(500) });
    // characters, not UTF-16 units: 500 astral characters fit
    expect(cleanNote("\u{1F600}".repeat(500)).ok).toBe(true);
    expect(cleanNote(" \n\t ")).toEqual({ ok: true, note: null });
  });

  it("test_a_note_never_reaches_another_profile", () => {
    const p = seed();
    const other = new SyntheticProfile(TODAY);
    const flat = rows(p).find((r) => r.name === "Mieszkanie Test");
    setNote(p, flat?.id as string, "Tylko moje");
    expect(rows(other)).toEqual([]);
    // notes are looked up only for the accounts asked about
    expect(notesOf(p.notes, [])).toEqual(new Map());
    expect(rows(p).find((r) => r.name === "Mieszkanie Test")?.note).toBe("Tylko moje");
  });
});
