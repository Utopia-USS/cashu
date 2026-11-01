/**
 * `parity/python/checks/loans_assets.py:_probe_dates`: month starts from the month before `start` to two
 * years after `asOf`, plus the month ends between them, `start` itself and `asOf`, ascending.
 */

import { addDays, formatDate, type IsoDate, parseDate } from "@cashu/domain";

function monthStarts(first: IsoDate, last: IsoDate): IsoDate[] {
  const out: IsoDate[] = [];
  let { year, month } = parseDate(first);
  for (;;) {
    const d = formatDate({ year, month, day: 1 });
    if (d > last) break;
    out.push(d);
    if (month === 12) {
      year += 1;
      month = 1;
    } else month += 1;
  }
  return out;
}

export function probeDates(start: IsoDate, asOf: IsoDate): IsoDate[] {
  const { year, month } = parseDate(start);
  const prev = addDays(formatDate({ year, month, day: 1 }), -1);
  const begin = formatDate({ ...parseDate(prev), day: 1 });
  const firsts = monthStarts(begin, addDays(asOf, 731));
  const ends = firsts.slice(1).map((d) => addDays(d, -1));
  return [...new Set([...firsts, ...ends, start, asOf])].sort();
}
