/** Coherent native market facts and optional current-file authority, rebuilt per MCP call. */
import { parseDateTime } from "@cashu/domain";
import { asInstrumentId, market } from "@cashu/domain/investments";
import * as plan from "@cashu/domain/investments/plan";
import * as views from "@cashu/domain/investments/views";
import { investmentsViews } from "@cashu/store";
import { loadInstrument, vaultInstrumentGids } from "@cashu/store/investments/queries";
import { backtestProposalRule } from "@cashu/store/investments/services";
import type { ToolContext } from "../registry.js";
import type { NativeToolStore } from "../runtime/types.js";
import type { InvestmentWriteRequests, InvestmentWriteServices } from "./investmentWriteTypes.js";

export function investmentWriteServices(
  ctx: ToolContext<NativeToolStore>,
  requests: InvestmentWriteRequests,
): InvestmentWriteServices {
  const request = { ...requests.portfolio, accounts: null, forOwner: false };
  if (request.clock.today !== ctx.today || request.asOf !== ctx.today)
    throw new Error("native investment-write clock is inconsistent");
  if (requests.strategyFiles !== undefined && requests.strategyFiles.vault !== request.vault)
    throw new Error("native investment strategy-file vault is inconsistent");
  const holder = requests.isHolder.bind(requests);
  const isHolder = (vault: string) => {
    try {
      return vault === request.vault && holder(vault) === true;
    } catch {
      return false;
    }
  };
  return {
    vault: request.vault,
    strategyFiles: requests.strategyFiles,
    alertBars(instrument) {
      const inst = loadInstrument(ctx.store.read, instrument);
      if (inst === undefined) return [];
      return request.marketData === undefined
        ? market.cachedMarketData(request.prices, [inst]).series(inst.id)
        : request.marketData.data.series(inst.id);
    },
    plans: {
      vault: request.vault,
      config: request.strategy.config,
      lang: request.lang,
      isHolder,
      buildValued(read) {
        const out = investmentsViews.portfolioAt(read, request);
        if (!out.ok) throw new Error("native investment-write portfolio is invalid");
        return out.value.valued;
      },
    },
    watchlist(pending) {
      const prospective = pending?.prospectiveInstrument;
      if (prospective !== undefined && prospective.id !== pending?.instrument)
        throw new Error("prospective watch identity mismatch");
      const newSubject =
        prospective !== undefined && !vaultInstrumentGids(ctx.store.read).has(prospective.id);
      const out = investmentsViews.portfolioViewInputs(ctx.store.read, {
        ...request,
        ...(pending === undefined || newSubject
          ? {}
          : {
              instrumentIds: [...(request.instrumentIds ?? []), asInstrumentId(pending.instrument)],
            }),
      });
      if (!out.ok) throw new Error("native watchlist context is invalid");
      if (pending === undefined) return views.watchlistView(out.value);
      const watched = {
        id: pending.item,
        instrumentId: asInstrumentId(pending.instrument),
        note: pending.note,
        tags: pending.tags,
        source: "agent",
        addedAt: parseDateTime(new Date(ctx.store.now()).toISOString()),
      };
      // A saved instrument becomes watched now. P2 hints are facts-based; plan-check signals are
      // deliberately excluded from the strategy-rule signal kinds used by P2/P3 annotations.
      let state = out.value.state;
      let facts = out.value.facts;
      if (newSubject && prospective) {
        const series =
          pending.verifiedBars ??
          (request.marketData === undefined
            ? market.cachedMarketData(request.prices, [prospective]).series(prospective.id)
            : request.marketData.data.series(prospective.id));
        state = {
          ...state,
          instruments: new Map([...state.instruments, [prospective.id, prospective]]),
          historyBars: new Map([
            ...state.historyBars,
            [prospective.id, series.filter((bar) => bar.date <= ctx.today)],
          ]),
        };
        facts = investmentsViews.readFacts(ctx.store.read, {
          portfolio: state,
          clock: request.clock,
        });
      }
      const subjects = facts.subjects.map((subject) =>
        subject.instrument.id === watched.instrumentId
          ? { ...subject, hintsWanted: true }
          : subject,
      );
      return views.watchlistView({
        ...out.value,
        state,
        annotations: plan.annotateSubjects(subjects, request.clock, request.lang),
        facts: {
          ...facts,
          subjects,
          watched: [...facts.watched.filter((row) => row.id !== watched.id), watched],
        },
      });
    },
    backtest(rule, config) {
      const market =
        request.marketData === undefined
          ? { prices: request.prices }
          : { marketData: request.marketData };
      return backtestProposalRule(ctx.store.read, {
        ...market,
        vault: request.vault,
        today: ctx.today,
        strategy: { ...request.strategy, state: "valid", config },
        rule,
        lang: request.lang,
      });
    },
  };
}
