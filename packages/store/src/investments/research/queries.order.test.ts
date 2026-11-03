import { research } from "@cashu/domain/investments";
import { expect, it } from "vitest";
import { assertOrderedDelivery } from "../testing/delivery.js";
import { household } from "../testing/household.js";
import { ulid } from "../testing/kit.js";
import { noteRows, notes, notesByGid, unreadNotes, weekNoteRows } from "./queries.js";

it("uses applied storing order for tied observations despite non-monotonic stamps and replay", () => {
  const h = household();
  const ids = [ulid(904), ulid(901), ulid(903), ulid(902)];
  const observed = "2026-10-30T08:00:00Z";
  const now = research.utcInstant("2026-10-31", 12);
  const events = ids.map((gid, i) =>
    h.ev.make(
      "note.added",
      gid,
      {
        instrument: h.first,
        observedAt: i === 3 ? "2026-10-31T08:00:00Z" : observed,
        expiresAt: "2026-11-30T08:00:00Z",
        stamps: { created_at: i === 1 ? "2026-10-29T10:00:00Z" : "2026-10-30T10:00:00Z" },
      },
      { wall: 500 + i },
    ),
  );
  const result = assertOrderedDelivery([...h.events, ...events], (store) => {
    const read = store.read.bind(store);
    const gids = (rows: readonly { readonly gid: string }[]) => rows.map((row) => row.gid);
    return {
      stored: gids(noteRows(read, "1=1")),
      byGid: gids(notesByGid(read, [...ids].reverse())),
      presented: gids(notes(read, now)),
      limited: gids(notes(read, now, { limit: 2 })),
      unread: gids(unreadNotes(read, now)),
      week: gids(weekNoteRows(read, "research:2026-W44|synthetic")),
    };
  });
  expect(result).toEqual({
    stored: ids,
    byGid: ids,
    presented: [...ids].reverse(),
    limited: [...ids].reverse().slice(0, 2),
    unread: ids,
    week: ids,
  });
});
