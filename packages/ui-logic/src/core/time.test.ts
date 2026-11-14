import { expect, it } from "vitest";
import { dayMonthShort, relativeDay } from "./time.js";

it("writes the day and the short month without a year", () => {
  const at = new Date(2026, 10, 12, 22, 40);
  expect(dayMonthShort(at, "en-GB")).toBe("12 Nov");
  expect(dayMonthShort(at, "pl-PL")).toBe("12 lis");
});

it("tells today, yesterday and earlier by the local calendar day", () => {
  const now = new Date(2026, 10, 14, 0, 30);
  expect(relativeDay(new Date(2026, 10, 14, 0, 1), now)).toBe("today");
  expect(relativeDay(new Date(2026, 10, 13, 23, 59), now)).toBe("yesterday");
  expect(relativeDay(new Date(2026, 10, 13, 0, 0), now)).toBe("yesterday");
  expect(relativeDay(new Date(2026, 10, 12, 23, 59), now)).toBe("earlier");
  // Across a month and a year boundary.
  expect(relativeDay(new Date(2026, 11, 31, 22, 0), new Date(2027, 0, 1, 8, 0))).toBe("yesterday");
  // Ahead of this clock: today.
  expect(relativeDay(new Date(2026, 10, 14, 9, 0), now)).toBe("today");
});
