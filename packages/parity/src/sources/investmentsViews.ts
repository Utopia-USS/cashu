/** Copied-source facts needed by native views. No result JSON or golden files are read. */
import { parsePyJson } from "@cashu/domain";
import { int, type Row, text, textOrNull } from "./decode.ts";

type Query = (sql: string, ...params: (string | number | bigint | null)[]) => Row[];

export interface ReviewSourceRow {
  readonly id: number;
  readonly doneAt: string;
  readonly notes: string | null;
  readonly stats: Readonly<Record<string, unknown>>;
}
export interface MacroCloseSourceRow {
  readonly series: string;
  readonly date: string;
  readonly close: string;
}
export interface StrategyVersionSourceRow {
  readonly id: number;
  readonly version: number;
  readonly createdAt: string;
}

export class InvestmentsViewsReader {
  private readonly query: Query;
  constructor(query: Query) {
    this.query = query;
  }

  /** Matches Python overview's global FX freshness metadata, including unrelated/future quotes. */
  newestRateDate(): string | null {
    const row = this.query("SELECT MAX(date) AS latest FROM inv_fx_rates")[0];
    return row === undefined ? null : textOrNull(row, "latest");
  }

  /** Lexical JSON provenance for the exact native-selected topic valuation note, scoped to its owner. */
  valuationDetails(profileId: number, noteId: number): Readonly<Record<string, unknown>> | null {
    const row = this.query(
      "SELECT details FROM research_notes WHERE profile_id = ? AND id = ?",
      profileId,
      noteId,
    )[0];
    if (row === undefined) return null;
    const details = parsePyJson(text(row, "details"), (literal, integer) =>
      integer ? BigInt(literal) : Number(literal),
    );
    if (typeof details !== "object" || details === null || Array.isArray(details))
      throw new Error("selected valuation details is not an object");
    const valuation = (details as Record<string, unknown>).valuation;
    if (valuation === undefined || valuation === null) return null;
    if (typeof valuation !== "object" || Array.isArray(valuation))
      throw new Error("selected valuation payload is not an object");
    return valuation as Readonly<Record<string, unknown>>;
  }

  /** Public shared market reference data, deliberately not profile-scoped. */
  macroCloses(): MacroCloseSourceRow[] {
    return this.query(
      "SELECT series, date, CAST(close AS TEXT) AS close FROM inv_macro_bars ORDER BY series, date",
    ).map((row) => ({
      series: text(row, "series"),
      date: text(row, "date"),
      close: text(row, "close"),
    }));
  }

  reviews(profileId: number): ReviewSourceRow[] {
    return this.query(
      "SELECT id, done_at, notes, stats FROM reviews WHERE profile_id = ? AND module = 'investments' ORDER BY done_at DESC, id DESC",
      profileId,
    ).map((row) => {
      const stats = parsePyJson(text(row, "stats"), (literal, integer) =>
        integer ? BigInt(literal) : Number(literal),
      );
      if (typeof stats !== "object" || stats === null || Array.isArray(stats))
        throw new Error("review stats is not an object");
      return {
        id: int(row, "id"),
        doneAt: text(row, "done_at"),
        notes: textOrNull(row, "notes"),
        stats: stats as Readonly<Record<string, unknown>>,
      };
    });
  }

  strategyVersions(profileId: number): StrategyVersionSourceRow[] {
    return this.query(
      "SELECT id, version, created_at FROM inv_strategy_versions WHERE profile_id = ? ORDER BY version DESC, id DESC",
      profileId,
    ).map((row) => ({
      id: int(row, "id"),
      version: int(row, "version"),
      createdAt: text(row, "created_at"),
    }));
  }
}
