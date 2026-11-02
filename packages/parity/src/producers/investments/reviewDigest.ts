/** Actual store review inputs and the native pure digest; legacy row rank is explicit input metadata. */
import { investments as inv, toStorage, utcIso } from "@cashu/domain";
import { investmentsViews } from "@cashu/store";
import type { PythonDb } from "../../sources/pythonDb.ts";
import type { OutValue } from "../output.ts";
import { REVIEW_DIGEST_FLOAT_PATHS, viewOutput } from "./viewOutput.ts";
import {
  copiedAllSignalFacts,
  copiedJsonFloatPaths,
  copiedScalarFloatPaths,
  copiedSourceGid,
  copiedSourceId,
  copiedWarningMessages,
  nativeViewSources,
} from "./viewSource.ts";

/** Only the final Python source-counter tie differs from the native canonical-gid order. */
export function copiedSegmentMembers<
  T extends Pick<inv.research.SegmentRow, "segment" | "member_instruments">,
>(segment: T, trends: inv.research.Trends | null, source: Parameters<typeof copiedSourceId>[0]): T {
  const raw = trends?.bySegment.get(segment.segment)?.instruments ?? [];
  const members = segment.member_instruments;
  const byId = new Map(members.map((row) => [row.instrument_id, row]));
  if (byId.size !== members.length || raw.length !== members.length)
    throw new Error("native segment member coverage differs");
  const sourceIds = new Map<string, string>();
  for (const [index, row] of raw.entries()) {
    const gid = String(row.instrumentId);
    if (!byId.has(gid) || sourceIds.has(gid) || members[index]?.instrument_id !== gid)
      throw new Error("native segment member identity or order differs");
    sourceIds.set(gid, String(copiedSourceId(source, gid, "inv_instruments")));
  }
  const tied = (a: inv.performance.MemberMove, b: inv.performance.MemberMove) =>
    a.held === b.held &&
    ((a.returns[0] ?? null) === null) === ((b.returns[0] ?? null) === null) &&
    Math.abs(a.returns[0] ?? 0) === Math.abs(b.returns[0] ?? 0);
  const ordered = [...raw];
  for (let start = 0; start < raw.length; ) {
    const first = raw[start];
    if (first === undefined) throw new Error("native segment member is absent");
    let end = start + 1;
    while (end < raw.length && tied(first, raw[end] as inv.performance.MemberMove)) end++;
    const group = raw.slice(start, end).sort((a, b) => {
      const left = sourceIds.get(String(a.instrumentId)) as string;
      const right = sourceIds.get(String(b.instrumentId)) as string;
      return left < right ? -1 : left > right ? 1 : 0;
    });
    ordered.splice(start, end - start, ...group);
    start = end;
  }
  return {
    ...segment,
    member_instruments: ordered.map((row) => ({ ...byId.get(String(row.instrumentId))! })),
  };
}

/** The real Python golden pins its ambient UI language to Polish; synthetic callers may pin EN. */
export function produceReviewDigest(
  db: PythonDb,
  lang: inv.views.ViewOptions["lang"] = "pl",
): OutValue {
  return Object.fromEntries(
    nativeViewSources(db).map((source) => {
      const loaded = investmentsViews.reviewDigestInputs(source.vault.store, {
        ...source.request,
        lang,
        macroCloses: source.macroCloses,
      });
      if (!loaded.ok) throw new Error(`native review input refused: ${loaded.reason}`);
      const input = loaded.value;
      const last = db.investmentsViews.reviews(source.profile.id)[0] ?? null;
      const accountOrder = (state: inv.views.PortfolioViewState) => ({
        ...state,
        accounts: [...state.accounts].sort(
          (a, b) => copiedSourceId(source, a.id) - copiedSourceId(source, b.id),
        ),
      });
      const decisions = [...input.decisions]
        .sort((a, b) =>
          toStorage(a.createdAt) < toStorage(b.createdAt)
            ? 1
            : toStorage(a.createdAt) > toStorage(b.createdAt)
              ? -1
              : copiedSourceId(source, b.id) - copiedSourceId(source, a.id),
        )
        .map((row) => ({
          ...row,
          signals: [
            ...(row.signal === null ? [] : [row.signal]),
            ...row.signals
              .filter((gid) => gid !== row.signal)
              .sort((a, b) => copiedSourceId(source, a) - copiedSourceId(source, b)),
          ],
        }));
      const good = db.investments
        .signalRuleRuns(source.profile.id)
        .find((row) => row.status === "ok" || row.status === "partial");
      const research: Record<string, unknown> = { ...input.research };
      const valuationFloatPaths: (readonly string[])[] = [];
      if (Array.isArray(research.segments)) {
        research.segments = research.segments.map((segment, index) => {
          if (segment === null || typeof segment !== "object") return segment;
          segment = copiedSegmentMembers(segment, loaded.segmentTrends, source);
          const valuation = "valuation" in segment ? segment.valuation : null;
          if (valuation !== null) {
            if (
              typeof valuation !== "object" ||
              !("note_id" in valuation) ||
              typeof valuation.note_id !== "string"
            )
              throw new Error("native segment valuation note is not canonical text");
            const noteId = copiedSourceId(source, valuation.note_id, "research_notes");
            const raw = db.investmentsViews.valuationDetails(source.profile.id, noteId);
            if (raw === null)
              throw new Error("selected valuation note is absent from its copied owner");
            valuationFloatPaths.push(
              ...copiedJsonFloatPaths(raw, ["research", "segments", String(index), "valuation"]),
            );
          }
          if (!("thesis" in segment)) return segment;
          const thesis = segment.thesis;
          if (thesis === null) return segment;
          if (typeof thesis !== "object" || !("id" in thesis) || typeof thesis.id !== "string")
            throw new Error("native segment thesis identity is not canonical text");
          // Canon uses parent `thesis` -> inv_theses even for this topic-thesis path.
          // Preserve that copied-source wire quirk without changing the native topic gid or guard.
          return {
            ...segment,
            thesis: {
              ...thesis,
              id: BigInt(copiedSourceId(source, thesis.id, "inv_topic_theses")),
            },
          };
        });
      }
      for (const field of ["candidates", "highlights"]) {
        const rows = research[field];
        if (Array.isArray(rows))
          research[field] = rows.map((gid) => {
            if (typeof gid !== "string")
              throw new Error("native research digest reference is not canonical text");
            return BigInt(copiedSourceId(source, gid, "research_notes"));
          });
      }
      const run = research.run;
      if (run !== null && typeof run === "object" && "id" in run && typeof run.id === "string") {
        // The existing Python check's bare-id override is inv_signals even inside research.run.
        // Preserve that legacy wire contract at this boundary; production keeps the real run gid.
        research.run = { ...run, id: BigInt(copiedSourceId(source, run.id, "research_runs")) };
      }
      const market = research.market;
      if (
        market !== null &&
        typeof market === "object" &&
        "stale" in market &&
        Array.isArray(market.stale)
      ) {
        research.market = {
          ...market,
          stale: market.stale
            .map((gid) => {
              if (typeof gid !== "string")
                throw new Error("native stale instrument is not canonical text");
              return BigInt(copiedSourceId(source, gid, "inv_instruments"));
            })
            .sort((a, b) => (String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0)),
        };
      }
      const value = inv.views.reviewDigestView({
        ...input,
        current: accountOrder(input.current),
        previous: input.previous === null ? null : accountOrder(input.previous),
        lastReview: last,
        signals: copiedAllSignalFacts(db, source),
        decisions,
        research,
        goodRun: good === undefined ? null : copiedSourceGid(source, "inv_rule_runs", good.id),
        imports: [...input.imports].sort((a, b) =>
          toStorage(a.createdAt) < toStorage(b.createdAt)
            ? 1
            : toStorage(a.createdAt) > toStorage(b.createdAt)
              ? -1
              : copiedSourceId(source, b.id) - copiedSourceId(source, a.id),
        ),
        runs: [...input.runs].sort((a, b) =>
          toStorage(a.startedAt) < toStorage(b.startedAt)
            ? 1
            : toStorage(a.startedAt) > toStorage(b.startedAt)
              ? -1
              : copiedSourceId(source, b.id) - copiedSourceId(source, a.id),
        ),
      });
      const bare =
        last === null
          ? null
          : { done_at: utcIso(last.doneAt), notes: last.notes, stats: last.stats };
      // Canon's generic run_id maps to research_runs, including the source's rule-run warning event.
      const wireValue = {
        ...value,
        warnings: copiedWarningMessages(value.warnings, input.current, source),
        events: value.events.map((event) =>
          event.type === "data_warning" && typeof event.run_id === "string"
            ? { ...event, run_id: BigInt(copiedSourceId(source, event.run_id, "inv_rule_runs")) }
            : event,
        ),
      };
      return [
        db.keys.key("profiles", source.profile.id),
        {
          digest: viewOutput(wireValue, db, source.vault, {
            bareIdTable: "inv_signals",
            floatPaths: [
              ...REVIEW_DIGEST_FLOAT_PATHS,
              ...copiedScalarFloatPaths(wireValue, source),
              ...valuationFloatPaths,
              ...copiedJsonFloatPaths(last?.stats, ["last_review", "stats"]),
            ],
            literalIdPaths: ["events.*.bucket_id", "signals.*.*.payload.bucket_id"],
          }),
          last_review: viewOutput(bare, db, source.vault, {
            floatPaths: copiedJsonFloatPaths(last?.stats, ["stats"]),
          }),
        },
      ];
    }),
  );
}
