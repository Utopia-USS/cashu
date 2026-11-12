// The tab header's bank freshness line: today's time, the weekday within the week, the date beyond, and
// the stale warning past the attention list's threshold. Dates are built in the device timezone, as
// the line shows them.
import { setLanguageForTests } from "@cashu/i18n";
import { formatCalendarDate } from "@cashu/i18n/values";
import { bankFresh } from "./fresh";

const local = (day: number, hour: number, minute = 0) =>
  new Date(2026, 10, day, hour, minute).toISOString();

afterEach(() => setLanguageForTests("en"));

describe("bankFresh", () => {
  const now = new Date(2026, 10, 12, 9, 15);

  it("says the time of a batch finished today", () => {
    setLanguageForTests("en");
    expect(bankFresh(local(12, 6, 40), now, "en-GB")).toEqual({
      tone: "ok",
      text: "Bank data from 06:40",
    });
    setLanguageForTests("pl");
    expect(bankFresh(local(12, 6, 40), now, "pl-PL")).toEqual({
      tone: "ok",
      text: "Dane z banku z 06:40",
    });
  });

  it("names the weekday of yesterday's batch while it is younger than the threshold", () => {
    setLanguageForTests("en");
    expect(bankFresh(local(11, 7, 30), now, "en-GB")).toEqual({
      tone: "ok",
      text: "Bank data from Wed 07:30",
    });
  });

  it("warns with the age in days from 36 hours on", () => {
    setLanguageForTests("en");
    expect(bankFresh(local(9, 7, 30), now, "en-GB")).toEqual({
      tone: "warn",
      text: "Bank data from Mon 07:30 · 3 days old",
    });
    expect(bankFresh(local(10, 21, 15), now, "en-GB")).toEqual({
      tone: "warn",
      text: "Bank data from Tue 21:15 · 1 day old",
    });
    setLanguageForTests("pl");
    expect(bankFresh(local(9, 7, 30), now, "pl-PL")).toEqual({
      tone: "warn",
      text: "Dane z banku z pon. 07:30 · sprzed 3 dni",
    });
    expect(bankFresh(local(10, 21, 15), now, "pl-PL").text).toBe(
      "Dane z banku z wt. 21:15 · sprzed 1 dnia",
    );
  });

  it("falls back to the date a week back and says when nothing was imported", () => {
    setLanguageForTests("en");
    expect(bankFresh(local(2, 8, 0), now, "en-GB")).toEqual({
      tone: "warn",
      text: `Bank data from ${formatCalendarDate("2026-11-02", "en-GB")} · 10 days old`,
    });
    expect(bankFresh(null, now, "en-GB")).toEqual({ tone: "muted", text: "No bank data yet" });
  });
});
