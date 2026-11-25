// Dates follow the app language, never the phone's region: a US English phone still reads day first.
import { dateFormat, dateLabel, dayMonth, monthName, noon } from "./calendar";

const day = noon("2026-11-12");

describe("calendar labels follow the app language", () => {
  it.each(["en", "en-US", "en-GB", "en-AU"])("writes English day first under %s", (locale) => {
    expect(dateFormat(locale, { day: "numeric", month: "short" }).format(day)).toBe("12 Nov");
    expect(
      dateFormat(locale, { day: "numeric", month: "short", year: "numeric" }).format(day),
    ).toBe("12 Nov 2026");
    expect(dateFormat(locale, { month: "long", year: "numeric" }).format(day)).toBe(
      "November 2026",
    );
    expect(dayMonth("2026-11-30", "2026-11-21", locale)).toBe("30 November");
  });

  it.each(["pl", "pl-PL"])("writes Polish under %s", (locale) => {
    expect(dateFormat(locale, { day: "numeric", month: "short" }).format(day)).toBe("12 lis");
    expect(
      dateFormat(locale, { day: "numeric", month: "short", year: "numeric" }).format(day),
    ).toBe("12 lis 2026");
    expect(dateFormat(locale, { month: "long", year: "numeric" }).format(day)).toBe(
      "listopad 2026",
    );
    expect(monthName("2026-11", locale)).toEqual({
      title: "Listopad",
      of: "listopada",
      name: "listopad",
    });
  });
});

describe("a day carries its year only outside the current one", () => {
  const today = "2026-11-21";

  it("writes a day of this year without the year", () => {
    expect(dateLabel("2026-11-12", today, "en")).toBe("12 Nov");
    expect(dateLabel("2026-11-12", today, "pl")).toBe("12 lis");
    expect(dateLabel("2026-01-05", today, "en")).toBe("5 Jan");
    expect(dateLabel("2026-01-05", today, "pl")).toBe("5 sty");
    expect(dateLabel("2026-11-11", today, "en-US", { weekday: true })).toBe("Wed 11 Nov");
    expect(dateLabel("2026-11-11", today, "pl", { weekday: true })).toBe("śr., 11 lis");
    expect(dateLabel("2026-11-30", today, "pl", { month: "long" })).toBe("30 listopada");
  });

  it("writes a day of another year with the year", () => {
    expect(dateLabel("2025-11-12", today, "en")).toBe("12 Nov 2025");
    expect(dateLabel("2025-11-12", today, "pl")).toBe("12 lis 2025");
    expect(dateLabel("2027-01-04", today, "en-GB")).toBe("4 Jan 2027");
    expect(dateLabel("2025-11-12", today, "en", { weekday: true })).toBe("Wed, 12 Nov 2025");
    expect(dayMonth("2025-11-30", today, "en")).toBe("30 November 2025");
  });

  it.each([
    ["en", "31 Dec 2026", "1 Jan"],
    ["pl", "31 gru 2026", "1 sty"],
  ])("switches at the year boundary in %s", (locale, lastYear, newYear) => {
    // On New Year's Day yesterday belongs to the old year; on New Year's Eve tomorrow to the next.
    expect(dateLabel("2026-12-31", "2027-01-01", locale)).toBe(lastYear);
    expect(dateLabel("2027-01-01", "2027-01-01", locale)).toBe(newYear);
    expect(dateLabel("2026-12-31", "2026-12-31", locale)).toBe(lastYear.replace(" 2026", ""));
    expect(dateLabel("2027-01-01", "2026-12-31", locale)).toBe(`${newYear} 2027`);
  });
});
