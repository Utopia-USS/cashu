/** Per-call native portfolio, attribution and macro composition, without Python-result inputs. */

import * as macro from "@cashu/domain/investments/macro";
import * as perf from "@cashu/domain/investments/performance";
import { DEFAULT_DATA_QUALITY } from "@cashu/domain/investments/rules";
import { investmentsPerformance, investmentsResearch, investmentsViews } from "@cashu/store";
import type { ToolContext } from "../registry.js";
import type { NativeToolStore } from "../runtime/types.js";
import type { ResearchRequests, ResearchServices } from "./researchTypes.js";

/** The language of the macro cards the MCP sends (its market vocabulary is Polish). */
const MCP_MARKET_LANG = "pl";

export function researchServices(
  ctx: ToolContext<NativeToolStore>,
  requests: ResearchRequests,
): ResearchServices {
  const request = { ...requests.portfolio, forOwner: false };
  if (request.clock.today !== ctx.today || request.asOf !== ctx.today)
    throw new Error("native research clock is inconsistent");
  const holder = requests.isHolder.bind(requests);
  const isHolder = (vault: string) => {
    try {
      return vault === request.vault && holder(vault) === true;
    } catch {
      return false;
    }
  };
  const read = ctx.store.read;
  const now = investmentsResearch.eventInstant(new Date(ctx.store.now()).toISOString());
  let computed: perf.ComputedPerformance | undefined;
  const config = request.strategy.config;
  const market =
    request.marketData === undefined
      ? { prices: request.prices }
      : { marketData: request.marketData };
  const compute = () => {
    if (computed !== undefined) return computed;
    const data = config?.data ?? DEFAULT_DATA_QUALITY;
    const inputs = investmentsPerformance.performanceInputs(read, {
      ...market,
      asOf: ctx.today,
      strategy: {
        state: request.strategy.state,
        benchmark: config?.benchmark ?? null,
        policy: { maxPriceAgeDays: data.maxPriceAgeDays, maxFxAgeDays: data.maxFxAgeDays },
        strategy:
          config === null
            ? null
            : { baseCurrency: config.baseCurrency, allocation: config.allocation },
      },
    });
    computed = perf.computePerformance(inputs, ctx.today);
    return computed;
  };
  return {
    vault: request.vault,
    strategy: request.strategy,
    markdown: config?.markdown ?? requests.markdown ?? null,
    isHolder,
    plans: {
      vault: request.vault,
      config,
      lang: request.lang,
      isHolder,
      buildValued(read) {
        const result = investmentsViews.portfolioAt(read, request);
        if (!result.ok) throw new Error("native research portfolio is invalid");
        return result.value.valued;
      },
    },
    positions() {
      const result = investmentsViews.readPositions(read, request);
      if (!result.ok) throw new Error("native research positions are invalid");
      return result.value;
    },
    segments(window) {
      const result = investmentsResearch.segmentsView(read, {
        ...market,
        computed: compute(),
        window,
        now,
        lang: request.lang,
      });
      if (!result.ok) throw new Error("native research segment window is invalid");
      return result.value;
    },
    macro: () => {
      let currency: Parameters<typeof macro.regimeDict>[2] = null;
      try {
        const found = investmentsResearch.attribution(compute(), "1w");
        if (found !== null) currency = macro.currencyEffectOf(found.attribution);
      } catch {
        /* Source keeps macro cards when attribution is unavailable. */
      }
      const notes = investmentsResearch.notesBySegment(read, now);
      return macro.evaluate(requests.macroCloses, ctx.today).map((regime) => {
        const entry = notes.get(`macro_${regime.key}`),
          selected = macro.currentBrief(entry?.briefs ?? [], regime);
        return {
          // Always Polish, whatever the app language: the MCP `market` label admits only the Polish
          // metric labels, Polish-formatted numbers and the Polish summary vocabulary, so an English
          // card made research_context fail with an internal error.
          ...macro.regimeDict(regime, MCP_MARKET_LANG, currency),
          brief: investmentsResearch.macroBrief(selected ?? undefined, now),
          last_note_at: investmentsResearch.iso(entry?.newest?.observedAt ?? null),
          note_this_week: macro.inSameIsoWeek(entry?.newest?.observedAt ?? null, now),
        };
      });
    },
  };
}
