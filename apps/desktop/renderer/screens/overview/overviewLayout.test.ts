import { describe, expect, it } from "vitest";
import { type BentoCell, bentoLayout } from "./overviewLayout.js";

const spans = (cells: BentoCell[]) =>
  cells.map((c) => `${c.id}:${c.span}${c.tall ? "x2" : ""}/${c.half}`);

/** Every 12-column row is full: the side column fills the hero's two rows, the rest sums to 12 per row. */
function rowsClose(cells: BentoCell[]): boolean {
  const [hero, ...rest] = cells;
  if (!hero) return false;
  let i = 0;
  if (hero.span === 8) {
    // Beside the hero: one tall tile, or two one-row tiles of 4 columns.
    const [a, b] = rest;
    if (a?.span !== 4) return false;
    if (a.tall) i = 1;
    else if (b?.span === 4 && !b.tall) i = 2;
    else return false;
  }
  let row = 0;
  for (const c of rest.slice(i)) {
    row += c.span;
    if (row > 12) return false;
    if (row === 12) row = 0;
  }
  return row === 0;
}

describe("bentoLayout", () => {
  it("lays every module out as the design (all modules on)", () => {
    const cells = bentoLayout({
      side: ["budget", "surplus"],
      middle: ["investments", "assets", "loans"],
      bottom: ["accounts", "subs"],
    });
    expect(spans(cells)).toEqual([
      "hero:8x2/12",
      "budget:4/6",
      "surplus:4/6",
      "investments:4/6",
      "assets:4/6",
      "loans:4/12",
      "accounts:8/12",
      "subs:4/12",
    ]);
    expect(rowsClose(cells)).toBe(true);
  });

  it("pulls the middle row up beside the hero when the budget tiles are missing", () => {
    const cells = bentoLayout({
      side: [],
      middle: ["investments", "assets", "loans"],
      bottom: ["accounts"],
    });
    expect(spans(cells)).toEqual([
      "hero:8x2/12",
      "investments:4/6",
      "assets:4/6",
      "loans:12/12",
      "accounts:12/12",
    ]);
    expect(rowsClose(cells)).toBe(true);
  });

  it("stretches a single side tile over both hero rows", () => {
    const cells = bentoLayout({ side: ["budget"], middle: [], bottom: ["accounts", "subs"] });
    expect(spans(cells)).toEqual(["hero:8x2/12", "budget:4x2/12", "accounts:8/12", "subs:4/12"]);
    expect(rowsClose(cells)).toBe(true);
  });

  it("makes the hero full width with nothing beside it", () => {
    const cells = bentoLayout({ side: [], middle: [], bottom: ["accounts"], banner: "nomods" });
    expect(spans(cells)).toEqual(["hero:12/12", "nomods:12/12", "accounts:12/12"]);
    expect(rowsClose(cells)).toBe(true);
  });

  it("splits the middle row in threes, then halves or the full width", () => {
    const four = bentoLayout({
      side: ["budget", "surplus"],
      middle: ["pending.loans", "investments", "assets", "x"],
      bottom: ["accounts", "subs"],
    });
    expect(spans(four).slice(3, 7)).toEqual([
      "pending.loans:4/6",
      "investments:4/6",
      "assets:4/6",
      "x:12/6",
    ]);
    const five = bentoLayout({
      side: ["budget", "surplus"],
      middle: ["a", "b", "c", "d", "e"],
      bottom: ["accounts", "subs"],
    });
    expect(five.slice(3, 8).map((c) => c.span)).toEqual([4, 4, 4, 6, 6]);
    for (const input of [four, five]) expect(rowsClose(input)).toBe(true);
  });

  it("closes every combination of modules without a hole", () => {
    const pick = <T>(all: T[], mask: number) => all.filter((_, k) => mask & (1 << k));
    for (let side = 0; side < 4; side++)
      for (let mid = 0; mid < 16; mid++)
        for (const subs of [false, true]) {
          const cells = bentoLayout({
            side: pick(["budget", "surplus"], side),
            middle: pick(["pending", "investments", "assets", "loans"], mid),
            bottom: subs ? ["accounts", "subs"] : ["accounts"],
          });
          expect(rowsClose(cells), spans(cells).join(" ")).toBe(true);
          // Two columns: tiles that are not full width come in pairs between the full-width ones.
          let open = 0;
          for (const c of cells) {
            if (c.half === 12) {
              expect(open, spans(cells).join(" ")).toBe(0);
              continue;
            }
            open = (open + 1) % 2;
          }
          expect(open).toBe(0);
        }
  });
});
