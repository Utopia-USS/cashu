// Local fire times as instants, across both DST changes of Europe/Warsaw in 2026 and in New York.

import { describe, expect, it } from "vitest";
import {
  dayOfWeek,
  eveningDigestOffset,
  isAhead,
  localDate,
  localFireAt,
  monthClosedFireAt,
  weeklyDigestOffset,
} from "./schedule.js";

const WARSAW = "Europe/Warsaw";
const NEW_YORK = "America/New_York";

describe("localFireAt", () => {
  it("puts 19:00 in Warsaw at 18:00Z in winter and 17:00Z in summer", () => {
    expect(localFireAt("2026-01-15", 19, 0, WARSAW)).toBe("2026-01-15T18:00:00.000Z");
    expect(localFireAt("2026-07-15", 19, 0, WARSAW)).toBe("2026-07-15T17:00:00.000Z");
  });

  it("follows the spring-forward change on 2026-03-29", () => {
    expect(localFireAt("2026-03-28", 19, 0, WARSAW)).toBe("2026-03-28T18:00:00.000Z");
    expect(localFireAt("2026-03-29", 19, 0, WARSAW)).toBe("2026-03-29T17:00:00.000Z");
    // The day offset crosses the change: Saturday's "tomorrow 19:00" is already summer time.
    expect(localFireAt("2026-03-28", 19, 0, WARSAW, 1)).toBe("2026-03-29T17:00:00.000Z");
    // Before the jump the night is still winter time.
    expect(localFireAt("2026-03-29", 1, 30, WARSAW)).toBe("2026-03-29T00:30:00.000Z");
    // 02:30 does not exist that night: it moves forward by the jump, to 03:30 summer time.
    expect(localFireAt("2026-03-29", 2, 30, WARSAW)).toBe("2026-03-29T01:30:00.000Z");
  });

  it("follows the fall-back change on 2026-10-25", () => {
    expect(localFireAt("2026-10-24", 19, 0, WARSAW)).toBe("2026-10-24T17:00:00.000Z");
    expect(localFireAt("2026-10-25", 19, 0, WARSAW)).toBe("2026-10-25T18:00:00.000Z");
    expect(localFireAt("2026-10-24", 19, 0, WARSAW, 1)).toBe("2026-10-25T18:00:00.000Z");
    expect(localFireAt("2026-10-25", 9, 0, WARSAW)).toBe("2026-10-25T08:00:00.000Z");
  });

  it("works west of UTC, where the local evening is the next UTC day", () => {
    expect(localFireAt("2026-11-13", 19, 0, NEW_YORK)).toBe("2026-11-14T00:00:00.000Z");
    expect(localFireAt("2026-07-01", 18, 0, NEW_YORK)).toBe("2026-07-01T22:00:00.000Z");
    // New York leaves summer time on 2026-11-01.
    expect(localFireAt("2026-10-31", 18, 0, NEW_YORK, 1)).toBe("2026-11-01T23:00:00.000Z");
  });

  it("crosses a month and a year end with the day offset", () => {
    expect(localFireAt("2026-12-31", 9, 0, WARSAW, 1)).toBe("2027-01-01T08:00:00.000Z");
  });
});

describe("localDate", () => {
  it("names the local day of an instant", () => {
    expect(localDate("2026-11-14T00:00:00.000Z", NEW_YORK)).toBe("2026-11-13");
    expect(localDate("2026-11-14T00:00:00.000Z", WARSAW)).toBe("2026-11-14");
    expect(localDate("2026-10-24T22:30:00.000Z", WARSAW)).toBe("2026-10-25");
  });
});

describe("dayOfWeek", () => {
  it("counts from Sunday = 0", () => {
    expect(dayOfWeek("2026-11-15")).toBe(0);
    expect(dayOfWeek("2026-11-12")).toBe(4);
    expect(dayOfWeek("2026-11-14")).toBe(6);
  });
});

describe("isAhead", () => {
  it("needs more than a minute of lead time", () => {
    const now = "2026-11-12T17:59:00.000Z";
    expect(isAhead("2026-11-12T18:00:01.000Z", now)).toBe(true);
    expect(isAhead("2026-11-12T18:00:00.000Z", now)).toBe(false);
    expect(isAhead("2026-11-12T17:00:00.000Z", now)).toBe(false);
  });
});

describe("eveningDigestOffset", () => {
  it("is today while 19:00 is more than a minute ahead, else tomorrow", () => {
    expect(eveningDigestOffset("2026-11-12", "2026-11-12T08:00:00Z", WARSAW)).toBe(0);
    expect(eveningDigestOffset("2026-11-12", "2026-11-12T17:59:30Z", WARSAW)).toBe(1);
    expect(eveningDigestOffset("2026-11-12", "2026-11-12T19:00:00Z", WARSAW)).toBe(1);
  });
});

describe("weeklyDigestOffset", () => {
  it("counts to the next Sunday, today while its 18:00 is ahead, else a week", () => {
    expect(weeklyDigestOffset("2026-11-12", "2026-11-12T08:00:00Z", WARSAW)).toBe(3);
    expect(weeklyDigestOffset("2026-11-15", "2026-11-15T10:00:00Z", WARSAW)).toBe(0);
    expect(weeklyDigestOffset("2026-11-15", "2026-11-15T17:30:00Z", WARSAW)).toBe(7);
  });
});

describe("monthClosedFireAt", () => {
  it("is the 1st of the following month at 09:00 local, across a year end", () => {
    expect(monthClosedFireAt("2026-10", WARSAW)).toBe("2026-11-01T08:00:00.000Z");
    expect(monthClosedFireAt("2026-12", WARSAW)).toBe("2027-01-01T08:00:00.000Z");
  });
});
