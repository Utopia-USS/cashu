// The old SignalsCtx data (ab24ab6 v2/Home.tsx signalsCtx) from the Home's reads: positions in view, buckets,
// totals, accounts, today, the contribution day, alerts by id, the held set (positions in view + the server's
// `held` on a signal), the watchlist, the last good run and the research effect line. Pure.
import type { AccountRow } from "@cashu/ui-logic/investments/types";
import type { DigestResearch } from "@cashu/ui-logic/investments/v2/research/types";
import type { InvestmentsHomeData } from "../investments/home/useInvestmentsHomeData.js";
import { researchEffectLine, type SignalsCtx } from "./signalsModel.js";

export function signalsCtxOf(data: InvestmentsHomeData): SignalsCtx {
  const overview = data.ov.data;
  const positions = data.pos.data?.positions ?? [];
  const today = overview?.as_of ?? data.today;
  const held = new Set(positions.map((p) => String(p.instrument.id)));
  for (const s of data.sig.data ?? [])
    if (s.held === true && s.instrument_id != null) held.add(String(s.instrument_id));
  const lastRun = overview?.kpis.last_run ?? null;
  const research = data.research;
  return {
    positions,
    buckets: overview?.allocation.buckets ?? [],
    total: overview?.allocation.total ?? 0,
    base: overview?.base_currency ?? "PLN",
    accounts: (overview?.accounts ?? []) as AccountRow[],
    today,
    contributionDay: data.strat.data?.facts?.contributions?.day_of_month ?? null,
    alertsById: new Map((data.alertsQ.data ?? []).map((a) => [a.id, a])),
    held,
    watch: data.watchQ.data ?? [],
    lastRunAt:
      lastRun && lastRun.status !== "failed"
        ? (lastRun.finished_at ?? lastRun.started_at ?? null)
        : null,
    researchEffect: (instrumentId) =>
      research.ran
        ? researchEffectLine({
            instrumentId,
            // The digest's research part (the old DigestV2 `research`; the adapter hands it over untyped).
            digest: (data.dig.data as { research?: DigestResearch | null } | undefined)?.research,
            summary: research.summary,
            runs: research.runs,
            today,
          })
        : null,
  };
}
