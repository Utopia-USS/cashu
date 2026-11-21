// Dates follow the app language, never the phone's region: a US English phone still reads day first.
import { dateFormat, dayMonth, monthName, noon } from "./calendar";

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
    expect(dayMonth("2026-11-30", locale)).toBe("30 November");
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
