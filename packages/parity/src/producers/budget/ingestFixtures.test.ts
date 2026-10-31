import { describe, expect, it } from "vitest";
import { dumps } from "../output.ts";
import { produceIngestFixtures } from "./ingestFixtures.ts";

describe("budget.ingest_fixtures producer", () => {
  it("parses every fixture with every bank and round-trips the own bank's rows", () => {
    const out = JSON.parse(dumps(produceIngestFixtures())) as {
      file: string;
      forced: Record<string, { error?: string; transactions?: unknown[] }>;
      round_trip: { statuses: string[]; rows: { occurrence: number }[] }[] | null;
    }[];
    expect(out.length).toBe(27);
    const edge = out.find((f) => f.file === "mbank/mbank-edge.csv");
    expect(edge?.forced.mbank?.transactions?.length).toBe(4);
    expect(edge?.forced.pekao).toEqual({ error: "no_header" });
    const [first, again, rule] = edge?.round_trip ?? [];
    expect(first?.statuses).toEqual(["new", "new", "new", "new"]);
    expect(again?.statuses.every((s) => s === "duplicate")).toBe(true);
    expect(rule?.rows).toEqual([]);
    expect(out.find((f) => f.file.startsWith("foreign/"))?.round_trip).toBeNull();
  });
});
