// The MCP tool schemas, hand-maintained (their source of truth). First captured from the retired
// Python tool registry.
import type { ToolMetadata } from "../registry.js";

type Defaulted = "refused" | "refusedValues" | "nullable" | "also";

/** A tool's metadata with the registry defaults (`toolSpec`): no refusals, nullable fields or extra
 * modules unless the entry names them. */
const tool = (init: Omit<ToolMetadata, Defaulted> & Partial<Pick<ToolMetadata, Defaulted>>) =>
  ({ refused: {}, refusedValues: {}, nullable: [], also: [], ...init }) satisfies ToolMetadata;

export const TOOL_ORDER: readonly string[] = [
  "profile_overview",
  "setup_status",
  "networth_breakdown",
  "mark_review_done",
  "spending_breakdown",
  "cashflow_summary",
  "recurring_payments",
  "uncategorized_merchants",
  "set_merchant_category",
  "validate_budget_import",
  "propose_account_removal",
  "loans_summary",
  "portfolio_overview",
  "positions",
  "signals",
  "review_context",
  "strategy_status",
  "history_metrics",
  "theses",
  "inspect_export",
  "validate_import",
  "set_recommendation",
  "set_recommendations",
  "record_decision",
  "upsert_thesis",
  "propose_strategy",
  "propose_custom_rule",
  "propose_import",
  "alerts",
  "add_alert",
  "mute_alert",
  "watchlist",
  "search_instruments",
  "add_to_watchlist",
  "remove_from_watchlist",
  "research_context",
  "research_notes",
  "start_research_run",
  "add_research_note",
  "set_topic_market_view",
  "upsert_topic_thesis",
  "finish_research_run",
  "set_instrument_segment",
  "test_connector",
  "propose_connector",
  "connectors",
];

export const NATIVE_TOOL_SCHEMAS: readonly ToolMetadata[] = [
  tool({
    name: "set_recommendation",
    module: "investments",
    description:
      "Save the model's assessment of one instrument after reviewing current research, the owner's thesis, invalidation and exit plan, portfolio construction, strategy and history. `strength` (strong | neutral | weak) with `strength_basis` is the model's assessment of how well the thesis holds (research, progress against the thesis and exit plan, environment), never a trade call. `recommendation` is optional: give it only if you are willing to state buy / hold / sell as a model opinion; omitting it clears an older one. Rules: basis fulfilled only with weak and on_track never with weak; buy / buy_asap never with weak and reduce / exit_asap never with strong; while the thesis is invalidated or fulfilled (research since its last edit) the strength must be weak. Opinions for the owner to evaluate, not decisions and never trades. `reason`: one or two short sentences in the app language (max 280 characters) describing the thesis state, shown under the thesis; no personal amounts or position sizes. A price target or price forecast may appear when it follows from the owner's strategy (name the strategy's method), as the model's opinion.",
    properties: {
      instrument: {
        type: "string",
        maxLength: 40,
      },
      strength: {
        type: "string",
        enum: ["strong", "neutral", "weak"],
      },
      strength_basis: {
        type: "string",
        enum: ["on_track", "fulfilled", "undermined", "environment_against", "no_progress"],
      },
      recommendation: {
        type: "string",
        enum: ["buy_asap", "buy", "hold", "reduce", "exit_asap"],
      },
      reason: {
        type: "string",
        maxLength: 280,
      },
    },
    required: ["instrument", "strength", "strength_basis", "reason"],
    write: true,
  }),
  tool({
    name: "set_recommendations",
    module: "investments",
    description:
      "End-of-research assessment gate. Save changed or missing model assessments (position strength, optional recommendation), preserve omitted rows, and commit only when every eligible instrument in scope (all = held + watchlist) has a strength. Each row is the full current opinion: a row without `recommendation` clears an older one. Rules: basis fulfilled only with weak and on_track never with weak; buy / buy_asap never with weak and reduce / exit_asap never with strong; while the thesis is invalidated or fulfilled (research since its last edit) the strength must be weak. Use this once at the end of a routine or full refresh; it returns expected / covered / missing counts. Opinions only, never decisions or trades.",
    properties: {
      scope: {
        type: "string",
        enum: ["all", "held", "watchlist"],
        default: "all",
      },
      recommendations: {
        type: "array",
        description:
          "Changed and missing assessments: {instrument, strength, strength_basis, recommendation?, reason}. Omitted instruments keep their stored assessment.",
        maxItems: 250,
        items: {
          type: "object",
          properties: {
            instrument: {
              type: "string",
              maxLength: 40,
            },
            strength: {
              type: "string",
              enum: ["strong", "neutral", "weak"],
            },
            strength_basis: {
              type: "string",
              enum: ["on_track", "fulfilled", "undermined", "environment_against", "no_progress"],
            },
            recommendation: {
              type: "string",
              enum: ["buy_asap", "buy", "hold", "reduce", "exit_asap"],
            },
            reason: {
              type: "string",
              maxLength: 280,
            },
          },
          required: ["instrument", "strength", "strength_basis", "reason"],
          additionalProperties: false,
        },
      },
    },
    required: ["recommendations"],
    write: true,
  }),
  tool({
    name: "record_decision",
    module: "investments",
    description:
      "Record what the owner decided about a signal (bought, sold, held, ignored, other) with a reason; acknowledges the signal. Never books a trade.",
    properties: {
      signal_id: {
        type: "integer",
        minimum: 1,
      },
      action: {
        type: "string",
        enum: ["bought", "sold", "held", "ignored", "other"],
      },
      reason: {
        type: "string",
        maxLength: 4000,
      },
    },
    required: ["signal_id", "action"],
    write: true,
  }),
  tool({
    name: "upsert_thesis",
    module: "investments",
    description: "Create or update the thesis of a held instrument (id, symbol or ISIN).",
    properties: {
      instrument: {
        type: "string",
        maxLength: 40,
      },
      entry_type: {
        type: "string",
        enum: ["sentiment_correction", "trend", "special_situation"],
      },
      thesis: {
        type: "string",
        maxLength: 4000,
      },
      invalidation: {
        type: "string",
        maxLength: 4000,
      },
      exit_plan: {
        type: "string",
        maxLength: 4000,
      },
      size_plan: {
        type: "string",
        maxLength: 4000,
      },
    },
    required: ["instrument", "entry_type", "thesis"],
    write: true,
  }),
  tool({
    name: "propose_strategy",
    module: "investments",
    description:
      "Propose a new strategy (strategy.yaml + strategy.md). Validated locally; stored as a proposal the owner approves in the app (then it becomes a new version). dry_run: validate only.",
    properties: {
      yaml: {
        type: "string",
        maxLength: 200000,
      },
      md: {
        type: "string",
        maxLength: 200000,
      },
      reason: {
        type: "string",
        maxLength: 4000,
      },
      dry_run: {
        type: "boolean",
        default: false,
      },
    },
    required: ["yaml"],
    write: true,
  }),
  tool({
    name: "propose_custom_rule",
    module: "investments",
    description:
      "Propose a rule: a built-in kind (e.g. drawdown_from_high) with params, or a custom expression (params: scope, message, id, severity, cooldown_days, filters). Validated with the expression compiler and backtested on the profile's history (how often it would have fired). dry_run: validate and backtest only, store nothing.",
    properties: {
      kind_or_expression: {
        type: "string",
        maxLength: 2000,
      },
      params: {
        type: "object",
      },
      reason: {
        type: "string",
        maxLength: 4000,
      },
      dry_run: {
        type: "boolean",
        default: false,
      },
    },
    required: ["kind_or_expression"],
    write: true,
  }),
  tool({
    name: "propose_import",
    module: "investments",
    description:
      "Propose importing a file into a brokerage account (account: use accounts[].account_id from portfolio_overview; an unmasked generated label is also accepted). path: a cashu-format file or a CSV with a mapping (MCP never makes the app run code). Runs the preview and stores a pending import the owner commits in the app.",
    properties: {
      path: {
        type: "string",
        maxLength: 1024,
        description: "local file path",
      },
      account: {
        type: "string",
        maxLength: 80,
      },
      mapping: {
        type: "string",
        maxLength: 64000,
        description: "generic CSV mapping: YAML text or a path to a .yaml/.yml file",
      },
      importer: {
        type: "string",
        enum: ["auto", "cashu", "generic_csv"],
        default: "auto",
      },
      reason: {
        type: "string",
        maxLength: 4000,
      },
    },
    required: ["path", "account"],
    write: true,
    refused: {
      converter:
        "MCP calls never make the app run code: run a one-off converter yourself (python3 <script> <export> <output.csv>) and pass the cashu-format output file as path, or write a connector (propose_connector), which the app runs only after the owner approves it in Ustawienia > Konektory",
    },
  }),
  tool({
    name: "alerts",
    module: "investments",
    description:
      "The profile's alerts (status: live = active, triggered or snoozed (default), all, or one status) with params, polarity, severity, tag, last check and the open signal; plus the agent alert limit and tags_in_use (the tags of all the profile's alerts with counts, most used first).",
    properties: {
      status: {
        type: "string",
        enum: ["all", "live", "active", "triggered", "snoozed", "muted", "expired"],
        default: "live",
      },
    },
    required: [],
    write: false,
  }),
  tool({
    name: "add_alert",
    module: "investments",
    description:
      "Create an ACTIVE alert (source agent) from the fixed catalog: price_above / price_below {level}, change_pct {window_days, threshold, direction up|down|any}, drawdown_from_high {window_days, threshold}, new_high {window_days}, sma_cross {window_days, direction above|below}, weight_above / weight_below {threshold, bucket?}, custom {expression, bucket?}, range_breakout {window_days 10-260 (30), max_range_pct 0.01-0.30 (0.08), direction up|down|any} (the close leaves a narrow range of the previous sessions), volume_spike {window_days 5-260 (20), multiple 1.5-20 (2.5)} (volume vs its average). instrument: id, symbol, ISIN or Yahoo symbol of a held or watched instrument (add_to_watchlist first). Thresholds are fractions (0.1 = 10%), window_days counts sessions. At most 50 live agent alerts per profile. Conditions on hard data only. tag: a short label shown as a chip; reuse a tag already in use in this profile when one fits (tags_in_use in alerts), otherwise a short lowercase noun in the app language such as cena, wydarzenie, rsi, wybicie, wolumen, średnia (English: price, event, rsi, breakout, volume, average). Do not put the ticker in title (the app shows it next to the title).",
    properties: {
      kind: {
        type: "string",
        enum: [
          "price_above",
          "price_below",
          "change_pct",
          "drawdown_from_high",
          "new_high",
          "sma_cross",
          "weight_above",
          "weight_below",
          "custom",
          "range_breakout",
          "volume_spike",
        ],
      },
      params: {
        type: "object",
      },
      instrument: {
        type: "string",
        maxLength: 40,
      },
      polarity: {
        type: "string",
        enum: ["positive", "negative", "neutral"],
      },
      severity: {
        type: "string",
        enum: ["info", "action"],
      },
      title: {
        type: "string",
        maxLength: 120,
      },
      note: {
        type: "string",
        maxLength: 2000,
      },
      expires_in_days: {
        type: "integer",
        minimum: 1,
        maximum: 3650,
      },
      cooldown_days: {
        type: "integer",
        minimum: 0,
        maximum: 3650,
      },
      scope: {
        type: "string",
        enum: ["instrument", "portfolio", "bucket"],
      },
      tag: {
        type: "string",
        maxLength: 24,
      },
    },
    required: ["kind", "params", "polarity", "severity", "title"],
    write: true,
  }),
  tool({
    name: "mute_alert",
    module: "investments",
    description:
      "Mute an alert (any source): it stops being checked and its open signal closes; the owner can re-arm it in the app.",
    properties: {
      id: {
        type: "integer",
        minimum: 1,
      },
    },
    required: ["id"],
    write: true,
  }),
  tool({
    name: "watchlist",
    module: "investments",
    description:
      "Watched instruments (not necessarily held): last close, 1-day / 1-month change, 52-week high and distance, alerts count, the model recommendation (buy_asap | buy | hold | null), strength (strong | neutral | weak | null) and strength_basis (the model's position strength and why), plan_freshness (state fresh | maybe_outdated | outdated and reason codes; null without a recommendation or strength), hints (which of the owner's own rules apply now: code, severity, params; main first).",
    properties: {},
    required: [],
    write: false,
  }),
  tool({
    name: "search_instruments",
    module: "investments",
    description:
      "Find an instrument by name, ticker or ISIN (1-60 characters): the profile's own instruments (local, with state held | watched | saved) and listings found online on Yahoo / OpenFIGI (remote, state new, with the exact Yahoo symbol and exchange; remote_status ok | unavailable | skipped). Use it before add_to_watchlist when the market is not obvious.",
    properties: {
      query: {
        type: "string",
        minLength: 1,
        maxLength: 60,
      },
    },
    required: ["query"],
    write: false,
  }),
  tool({
    name: "add_to_watchlist",
    module: "investments",
    description:
      "Watch an instrument by ticker with its market (VWCE.DE, PKN.WA, AAPL.US, NVDA:XNAS) or ISIN; when the market is not obvious pass an exact Yahoo symbol from search_instruments. A new listing is checked against its Yahoo price chart (its real currency); if that check fails the symbol is kept as a guess (exchange / currency help when the market is unknown). An instrument removed from the watchlist earlier is restored with its old note and tags (restored = true). It joins the daily price refresh.",
    properties: {
      symbol_or_isin: {
        type: "string",
        maxLength: 40,
      },
      note: {
        type: "string",
        maxLength: 1000,
      },
      name: {
        type: "string",
        maxLength: 120,
      },
      currency: {
        type: "string",
        maxLength: 3,
      },
      exchange: {
        type: "string",
        maxLength: 20,
      },
    },
    required: ["symbol_or_isin"],
    write: true,
  }),
  tool({
    name: "remove_from_watchlist",
    module: "investments",
    description:
      "Stop watching an instrument (item id from watchlist). Nothing is deleted: its alerts, theses, research notes, note and tags stay, and add_to_watchlist restores it.",
    properties: {
      id: {
        type: "integer",
        minimum: 1,
      },
    },
    required: ["id"],
    write: true,
  }),
  tool({
    name: "research_context",
    module: "investments",
    description:
      "Context for a research run: held instruments (weights as fractions) and watched ones, each with its current model recommendation and recommendation date, strength (strong | neutral | weak | null), strength_basis and strength_at (strength null means the final set_recommendations gate must receive it), with its market segment (segment, segment_source owner | agent | auto | null), thesis (entry type, thesis, invalidation, exit plan) and research state (thesis health, relation counts, 8-week sentiment, last researched); segments: what moved the portfolio this week and over 4 weeks by market segment (weight, contribution, return, instruments, trend_1w / trend_4w = the equal-weighted price move of its held and watched instruments, members, last_note_at, note_this_week; briefs = up to 3 active brief notes (headline, why) the owner reads under the topic, newest first; thesis = the topic thesis {text, invalidation, draft, created_by, updated_at} or null; valuation = the newest sourced valuation {pe, forward_pe, eps_growth, pe_avg_5y, basis, observed_at} or null; watched-only topics with weight 0), currency and unassigned; topic_thesis_cooldown: topics whose thesis the owner deleted (no new draft before until); segment_catalog; macro: the five macro regime cards (state_label, summary, plain = the beginner sentence the owner sees until a brief exists, brief = the active macro brief {headline, why, supports, risks} or null, since (null + since_open + since_min when the state began before the data), metrics as text, stale, missing, last_note_at, note_this_week; public data) and macro_catalog (their note keys); the strategy's entry types and candidate criteria, open and dismissed (cooldown) candidates, known upcoming events, owner_review (the owner's last weekly review: note and agenda = the review cards the owner sent to the agent {card, title, note}; answer them in this run), the last run, limits (incl. the weekly novelty limits) and boundaries.",
    properties: {},
    required: [],
    write: false,
  }),
  tool({
    name: "research_notes",
    module: "investments",
    description:
      "Research notes stored since a date (default the last 30 days; by storing time), newest observation first, incl. dismissed ones (rejected by the owner: never add them again).",
    properties: {
      since: {
        type: "string",
        maxLength: 40,
      },
      kind: {
        type: "string",
        enum: ["news", "earnings", "community", "trend", "macro", "candidate"],
      },
      include_dismissed: {
        type: "boolean",
        default: true,
      },
      limit: {
        type: "integer",
        minimum: 1,
        maximum: 200,
        default: 100,
      },
      segment: {
        type: "string",
        enum: [
          "equity_global",
          "equity_pl",
          "equity_em",
          "bonds",
          "gold",
          "energy",
          "power",
          "metals",
          "crypto",
          "real_estate",
          "semis_ai",
          "software",
          "robotics",
          "healthcare",
          "financials",
          "consumer",
          "games_media",
          "industrials",
          "quantum",
          "macro_risk",
          "macro_dollar",
          "macro_em",
          "macro_commodities",
          "macro_rates",
        ],
        description: "only this market segment's or macro regime's notes",
      },
    },
    required: [],
    write: false,
  }),
  tool({
    name: "start_research_run",
    module: "investments",
    description:
      "Open a research run. scope: {held: true, watchlist: true, candidates: true, segments: [segment or macro keys], instruments: [ids or symbols], scheduled: false (true for the scheduled routine)}. A run covering the held positions is weekly: per ISO week, weekly runs and notes written without a run cover at most 6 instruments, 2 notes each, and 6 segment notes (strength 3, invalidates and fulfills always pass). A scope with only instruments or segments is on demand (the flags it leaves out default to false) and exempt. full_refresh: true ONLY when the owner explicitly asks for a full fresh research: the run is exempt from the weekly novelty limits and from one brief note per segment and week, never from the duplicate / near-duplicate checks or one non-brief note per segment and week; never together with scheduled. Another run still running is a conflict: finish it first.",
    properties: {
      scope: {
        type: "object",
      },
    },
    required: [],
    write: true,
  }),
  tool({
    name: "add_research_note",
    module: "investments",
    description:
      "Store one sourced research note (facts and sentiment only; no analytical market view, recommendation, security price prediction, target, amounts or sizes). About a held / watched instrument (instrument: id or symbol from research_context), a market segment (segment: catalog key; no instrument, no candidate; kind macro | trend | news; thesis_relation none; summary <= 400 characters; at most one per segment and ISO week, only when something changed), a macro regime (segment: a macro_catalog key, same rules: only when its state changed since its last note or a dated decisive event happened this week), or, for kind candidate, a new instrument (candidate {symbol_or_isin, name, exchange?, currency?} + details {entry_type, criteria [{text, met, threshold?}], context?, bucket?}). thesis_relation (supports | weakens | invalidates | fulfills | neutral) needs an instrument with a thesis, else none; thesis_field names the thesis field it bears on (fulfills: thesis or exit_plan, a dated fact that the expected outcome happened or the exit target is met, never a sell call). details.event + event_date record a known upcoming event; details.scale (small | medium | large) the size of a community discussion; details.headline the plain-words headline (8-80 characters) the app shows first; details.valuation {pe, forward_pe, eps_growth (fraction), pe_avg_5y, basis} the sourced valuation of a topic or company (published figures, forward ones from the consensus the source states; the app derives cheap / fair / rich, never write that word). Title <= 120, summary <= 1200 characters (app language). A topic's current assessment and outlook belong in set_topic_market_view, never in note details. invalidates -> action signal, strength 3 -> info signal. A segment or macro note may carry details.brief {headline (8-80, a plain sentence in the app language a beginner understands), why (<= 280, plain words), supports [<= 3 x 90] and risks [<= 3 x 90] (macro only: conditions that historically supported / weighed on such a market)}: the owner reads it on the home page; describe what is, without forecast or call words (wzrośnie / spadnie / będzie / prognoz* / kupuj / sprzedaj / cel cenowy; will rise / will be / going to / forecast* / predict*), except in a sentence citing an institution's published forecast of a macro or market trend with who, how much and horizon (MFW prognozuje wzrost PKB USA o 2,1 % w 2027; projekcja Fed (dot plot); IEA szacuje popyt), the same in a note summary; no price, valuation or index forecast, analyst forecast or your own (prognozujemy). Wording check: a note whose title, summary, headline or brief reads like a forecast, a call, a rating or a price target is not saved the first time; the reply names the fields. Rewrite it as a fact, or resend with wording_ok true to save it as written (an opinion that follows from the owner's strategy belongs in set_recommendations instead); expires_in_days up to 90 (60 recommended). A topic note may carry thesis_relation supports | weakens | invalidates when the topic has a confirmed thesis (research_context segments[].thesis with draft false; thesis_field thesis); such an invalidates note passes the weekly segment cap. At most one brief note and one other note per segment and ISO week (a full_refresh run lifts it for brief notes). A note restating a fact already in a non-dismissed note of the same instrument / candidate / segment from the last 60 days (similar title, brief headline or headline + summary, same polarity, relation and direction) is refused as a near duplicate (count it skipped); a brief whose why changed passes the headline check.",
    properties: {
      kind: {
        type: "string",
        enum: ["news", "earnings", "community", "trend", "macro", "candidate"],
      },
      polarity: {
        type: "string",
        enum: ["positive", "negative", "neutral"],
      },
      strength: {
        type: "integer",
        minimum: 1,
        maximum: 3,
      },
      title: {
        type: "string",
        maxLength: 120,
      },
      summary: {
        type: "string",
        maxLength: 1200,
      },
      sources: {
        type: "array",
        description:
          "1-10 sources: {url (http(s), original publisher), publisher, published_at (YYYY-MM-DD), title?}",
      },
      instrument: {
        type: "string",
        maxLength: 40,
      },
      segment: {
        type: "string",
        enum: [
          "equity_global",
          "equity_pl",
          "equity_em",
          "bonds",
          "gold",
          "energy",
          "power",
          "metals",
          "crypto",
          "real_estate",
          "semis_ai",
          "software",
          "robotics",
          "healthcare",
          "financials",
          "consumer",
          "games_media",
          "industrials",
          "quantum",
          "macro_risk",
          "macro_dollar",
          "macro_em",
          "macro_commodities",
          "macro_rates",
        ],
        description:
          "market segment of a segment note: equity_global (Akcje globalne), equity_pl (Akcje polskie), equity_em (Rynki wschodzące), bonds (Obligacje i stopy), gold (Złoto i górnicy), energy (Ropa i gaz), power (Energetyka: atom i OZE), metals (Metale i ziemie rzadkie), crypto (Krypto), real_estate (Nieruchomości), semis_ai (AI: chipy i centra danych), software (AI i oprogramowanie), robotics (Robotyka), healthcare (Ochrona zdrowia), financials (Płatności i finanse), consumer (Konsumpcja), games_media (Gry), industrials (Przemysł i obronność), quantum (Komputery kwantowe); or a macro regime (macro note): macro_risk (Rynek akcji), macro_dollar (Dolar), macro_em (Rynki wschodzące), macro_commodities (Surowce), macro_rates (Obligacje i stopy)",
      },
      thesis_relation: {
        type: "string",
        enum: ["supports", "weakens", "invalidates", "fulfills", "neutral", "none"],
        default: "none",
      },
      thesis_field: {
        type: "string",
        enum: ["entry_type", "thesis", "invalidation", "exit_plan", "size_plan"],
      },
      candidate: {
        type: "object",
      },
      details: {
        type: "object",
      },
      observed_at: {
        type: "string",
        maxLength: 40,
      },
      expires_in_days: {
        type: "integer",
        minimum: 1,
        maximum: 90,
      },
      run_id: {
        type: "integer",
        minimum: 1,
      },
      wording_ok: {
        type: "boolean",
        description:
          "true saves a note the wording check flagged (forecast, call, rating or price target), as written",
      },
    },
    required: ["kind", "polarity", "strength", "title", "summary", "sources"],
    write: true,
    refused: {
      theme:
        "themes are gone: a market note takes segment (a catalog key from research_context.segment_catalog); company facts go on the instrument",
    },
  }),
  tool({
    name: "set_topic_market_view",
    module: "investments",
    description:
      "Write the topic's ONE current market view, shown to the owner directly under the topic thesis (Bieżąca ocena / Perspektywa), separate from notes; replaces the previous view (the owner's edit included), so keep it current after each topic research. The topic must have a thesis or your draft (upsert_topic_thesis first). assessment (20-400 characters, app language): the topic's market now (adoption, demand, investment, valuations of the topic as a whole). outlook (20-400): where the topic's market / adoption / demand is heading, resting on at least one quantitative industry estimate of market or demand growth cited as an estimate with who, how much and horizon (e.g. IFR szacuje 575 tys. instalacji robotów rocznie w 2028; IEA szacuje popyt centrów danych na ok. 945 TWh w 2030) plus the main risk; an outlook without a number other than a year / horizon is refused. sources (1-6, required): the reports behind those estimates, {url (http(s), original publisher), publisher, published_at (YYYY-MM-DD), title?}; they replace the stored ones. Not for: buy / sell / hold wording, ratings, a price target, any price, valuation or index move of a security, of shares or of an index (kurs / akcje / notowania / wyceny / S&P 500 ... wzrosną), analyst forecasts; such wording is saved but the reply lists it under warnings, so rewrite the view (a price view that follows from the owner's strategy belongs in set_recommendations).",
    properties: {
      segment: {
        type: "string",
        enum: [
          "equity_global",
          "equity_pl",
          "equity_em",
          "bonds",
          "gold",
          "energy",
          "power",
          "metals",
          "crypto",
          "real_estate",
          "semis_ai",
          "software",
          "robotics",
          "healthcare",
          "financials",
          "consumer",
          "games_media",
          "industrials",
          "quantum",
        ],
      },
      assessment: {
        type: "string",
        minLength: 20,
        maxLength: 400,
      },
      outlook: {
        type: "string",
        minLength: 20,
        maxLength: 400,
      },
      sources: {
        type: "array",
        minItems: 1,
        maxItems: 6,
        description:
          "1-6 sources of the cited estimates: {url (http(s), original publisher), publisher, published_at (YYYY-MM-DD), title?}",
      },
    },
    required: ["segment", "assessment", "outlook", "sources"],
    write: true,
    refusedValues: {
      segment: {
        macro_risk: "macro keys are not instrument segments",
        macro_dollar: "macro keys are not instrument segments",
        macro_em: "macro keys are not instrument segments",
        macro_commodities: "macro keys are not instrument segments",
        macro_rates: "macro keys are not instrument segments",
      },
    },
  }),
  tool({
    name: "upsert_topic_thesis",
    module: "investments",
    description:
      "Propose a DRAFT thesis on a market topic (segment: a segment_catalog key, never a macro key; thesis <= 600 characters, invalidation? <= 400, plain words in the app language, what has to stay true for the topic, never a price forecast or a call). Creates a draft or updates the agent's own draft (invalidation omitted keeps it). The owner's thesis (created_by owner, or a draft the owner confirmed: draft false) is never overwritten: conflict. Propose once for a held topic without a thesis (research_context segments[].thesis null); a topic whose thesis or draft the owner deleted is refused for 90 days (research_context topic_thesis_cooldown).",
    properties: {
      segment: {
        type: "string",
        enum: [
          "equity_global",
          "equity_pl",
          "equity_em",
          "bonds",
          "gold",
          "energy",
          "power",
          "metals",
          "crypto",
          "real_estate",
          "semis_ai",
          "software",
          "robotics",
          "healthcare",
          "financials",
          "consumer",
          "games_media",
          "industrials",
          "quantum",
        ],
      },
      thesis: {
        type: "string",
        maxLength: 600,
      },
      invalidation: {
        type: "string",
        maxLength: 400,
      },
    },
    required: ["segment", "thesis"],
    write: true,
    refusedValues: {
      segment: {
        macro_risk: "macro keys are not instrument segments",
        macro_dollar: "macro keys are not instrument segments",
        macro_em: "macro keys are not instrument segments",
        macro_commodities: "macro keys are not instrument segments",
        macro_rates: "macro keys are not instrument segments",
      },
    },
  }),
  tool({
    name: "finish_research_run",
    module: "investments",
    description:
      "Close a running research run: status done (default) or failed (with a short reason); counts: optional {sources_checked, instruments_covered, segments_covered, candidates_screened, skipped}. The server adds notes, signals and candidates.",
    properties: {
      run_id: {
        type: "integer",
        minimum: 1,
      },
      status: {
        type: "string",
        enum: ["done", "failed"],
        default: "done",
      },
      counts: {
        type: "object",
      },
      reason: {
        type: "string",
        maxLength: 200,
      },
    },
    required: ["run_id"],
    write: true,
  }),
  tool({
    name: "set_instrument_segment",
    module: "investments",
    description:
      "Set the market segment of a held or watched instrument (instrument: id, symbol, ISIN or alias from research_context; segment: a catalog key, or an explicit null to clear it so the automatic guess applies). A segment the owner set (segment_source owner) is never changed or cleared (conflict); the agent may change its own (segment_source agent). Catalog: equity_global (Akcje globalne), equity_pl (Akcje polskie), equity_em (Rynki wschodzące), bonds (Obligacje i stopy), gold (Złoto i górnicy), energy (Ropa i gaz), power (Energetyka: atom i OZE), metals (Metale i ziemie rzadkie), crypto (Krypto), real_estate (Nieruchomości), semis_ai (AI: chipy i centra danych), software (AI i oprogramowanie), robotics (Robotyka), healthcare (Ochrona zdrowia), financials (Płatności i finanse), consumer (Konsumpcja), games_media (Gry), industrials (Przemysł i obronność), quantum (Komputery kwantowe).",
    properties: {
      instrument: {
        type: "string",
        maxLength: 40,
      },
      segment: {
        type: "string",
        enum: [
          "equity_global",
          "equity_pl",
          "equity_em",
          "bonds",
          "gold",
          "energy",
          "power",
          "metals",
          "crypto",
          "real_estate",
          "semis_ai",
          "software",
          "robotics",
          "healthcare",
          "financials",
          "consumer",
          "games_media",
          "industrials",
          "quantum",
        ],
      },
    },
    required: ["instrument"],
    write: true,
    refusedValues: {
      segment: {
        macro_risk: "macro keys are not instrument segments",
        macro_dollar: "macro keys are not instrument segments",
        macro_em: "macro keys are not instrument segments",
        macro_commodities: "macro keys are not instrument segments",
        macro_rates: "macro keys are not instrument segments",
      },
    },
    nullable: ["segment"],
  }),
  tool({
    name: "test_connector",
    module: "core",
    description:
      "Test a connector you are writing (a directory connectors/<id>/ in this workspace), before propose_connector: the app runs a private copy once in the same sandbox as approved runs (Deno connectors: Deno permissions inside the macOS sandbox, imports only from the connector's own files and node: built-ins), detect + convert on `file` (a sample export inside this workspace) for a file connector, or fetch offline with `fixture` (a recorded synthetic API response inside this workspace, passed as the `fixture` param, placeholder secrets, no network) for a fetch connector, then validates the document like the import would. Time limit: detect 10 s, convert / fetch the manifest's timeout_s but at most 120 s (test with a sample that converts within that). Returns a value-free report: manifest facts, each run's outcome, error kind, record count and a fixed message for that kind, the detect match, document validity, counts and issue kinds with their counts. Nothing the connector writes (its error message, stdout, stderr) is ever returned, so give your connector precise error kinds and check rows by the issue kinds. Nothing is installed, approved or recorded.",
    properties: {
      path: {
        type: "string",
        maxLength: 1024,
      },
      file: {
        type: "string",
        maxLength: 1024,
      },
      fixture: {
        type: "string",
        maxLength: 1024,
      },
    },
    required: ["path"],
    write: false,
    refused: {
      network:
        "test_connector never uses the network: test a fetch connector offline with fixture; real fetches run only after the owner approves the connector in the app",
      secrets: "test_connector passes placeholder secrets; the owner enters real keys in the app",
      approve: "only the owner approves a connector, in the app (Ustawienia > Konektory)",
      install: "test_connector never installs; submit the connector with propose_connector",
    },
  }),
  tool({
    name: "propose_connector",
    module: "core",
    description:
      "Submit a connector for the owner's review: `path` = a connector you wrote (a directory connectors/<id>/ in this workspace with connector.yaml and its code; the contract is the import-builder skill's references/connectors.md), or `catalog_id` = an entry of the connector catalog shipped with the app (listed by connectors()). It is installed as pending (an installed one is replaced and waits for approval again). The app runs an installed connector only after the owner approves it in the app (Ustawienia > Konektory); MCP calls never install as approved and never approve. Returns id, status, hash prefix, module, kind, allowed hosts and secret ids. Test it before with test_connector. Never ask for API keys: the owner enters them in the app.",
    properties: {
      path: {
        type: "string",
        maxLength: 1024,
      },
      catalog_id: {
        type: "string",
        maxLength: 40,
      },
    },
    required: [],
    write: true,
    refused: {
      converter: "propose_connector takes the connector directory only; nothing is run",
      approve: "only the owner approves a connector, in the app (Ustawienia > Konektory)",
    },
  }),
  tool({
    name: "connectors",
    module: "core",
    description:
      "Installed connectors: id, name, module, kind, status (pending / approved / changed / disabled), the last run's outcome, error kind and time, and how many accounts of this profile use each; and the connector catalog shipped with the app (id, name, module, kind, version, maintainer, last verified, stale, valid, installed status). Run messages, logs, parameters and keys stay in the app. The app runs an installed connector only after the owner approves it in the app (Ustawienia > Konektory); MCP calls never install as approved and never approve.",
    properties: {},
    required: [],
    write: false,
  }),
];
export const INVESTMENT_READ_TOOLS: readonly ToolMetadata[] = [
  tool({
    name: "portfolio_overview",
    module: "investments",
    description:
      "Portfolio: bucket weights vs targets, drift in pp and band flags, unrealized %, cash weight, data freshness, last rule run, warnings, accounts (generated labels).",
    properties: {},
    required: [],
    write: false,
  }),
  tool({
    name: "positions",
    module: "investments",
    description:
      "Per instrument: symbol, name, weight, unrealized %, tags, bucket, valuation mode, holding days, open signals, thesis flag, the model recommendation (buy_asap | buy | hold | reduce | exit_asap | null), strength (strong | neutral | weak | null) and strength_basis (the model's position strength and why), plan_freshness (state fresh | maybe_outdated | outdated and reason codes; null without a recommendation or strength), hints (which of the owner's own rules apply now: code, severity rule|review|info, params as fractions; main first); cash weights per account.",
    properties: {},
    required: [],
    write: false,
  }),
  tool({
    name: "signals",
    module: "investments",
    description:
      "Rule and alert signals: rule, scope, measured vs threshold (as ratio / pp / days), severity, polarity (positive | negative | neutral), source (rule | alert | research | plan), snooze, age, decisions. status: open (default), history or all.",
    properties: {
      status: {
        type: "string",
        enum: ["open", "history", "all"],
        default: "open",
      },
    },
    required: [],
    write: false,
  }),
  tool({
    name: "review_context",
    module: "investments",
    description:
      "The owner's periodic review (strategy.yaml review:): name, every (week | 2weeks | month), day, cards in order (world, sectors, positions, events, ideas, calendar, decide), due, next_on; since = the last review's date (else 7 days ago), last_review {done_at, notes, agenda = the cards the owner sent to the agent {card, note}}; card_sources = which tool has each card's facts; calendar: the next 14 days (high-impact macro releases, earnings of held / watched US instruments, research note events), stale when a public feed could not be refreshed.",
    properties: {},
    required: [],
    write: false,
  }),
  tool({
    name: "strategy_status",
    module: "investments",
    description:
      "Strategy validation issues (line / column), rules, inactive rules, version history.",
    properties: {},
    required: [],
    write: false,
  }),
  tool({
    name: "history_metrics",
    module: "investments",
    description:
      "Retrospective metrics computed locally from the transaction history: activity gaps, deposits per year, sells after drawdowns, buys after run-ups, price change after sales, holding days of winners vs losers, fees as % of turnover, concentration over time.",
    properties: {},
    required: [],
    write: false,
  }),
  tool({
    name: "theses",
    module: "investments",
    description:
      "Position theses (entry type, thesis, invalidation, exit and size plans) with the model recommendation, strength (strong | neutral | weak | null) and strength_basis, optionally of one instrument (id, symbol or ISIN).",
    properties: {
      instrument: {
        type: "string",
        maxLength: 40,
      },
      include_closed: {
        type: "boolean",
        default: false,
        description:
          "also theses of closed positions (position: held | watched | closed; closed = neither held nor watched now, out of the review and research scope)",
      },
    },
    required: [],
    write: false,
  }),
  tool({
    name: "inspect_export",
    module: "investments",
    description:
      "Structure of a broker export or bank statement file (CSV, TSV, JSON, XLSX): sheets, header row, columns, inferred types, row counts and masked sample rows (numbers as their format, free text as token shapes; amounts, identifiers and names never shown). The blind route: when the user hands you the file itself, read it directly.",
    properties: {
      path: {
        type: "string",
        maxLength: 1024,
        description: "local file path",
      },
      max_samples: {
        type: "integer",
        minimum: 0,
        maximum: 20,
        default: 5,
      },
    },
    required: ["path"],
    write: false,
    also: ["budget"],
  }),
  tool({
    name: "validate_import",
    module: "investments",
    description:
      "Validate a cashu-format file (or a CSV with a mapping): counts and errors by kind with row numbers, no values. MCP never makes the app run code: convert other exports yourself first, or write a connector (propose_connector).",
    properties: {
      path: {
        type: "string",
        maxLength: 1024,
        description: "local file path",
      },
      mapping: {
        type: "string",
        maxLength: 64000,
        description: "generic CSV mapping: YAML text or a path to a .yaml/.yml file",
      },
    },
    required: ["path"],
    write: false,
    refused: {
      converter:
        "MCP calls never make the app run code: run a one-off converter yourself (python3 <script> <export> <output.csv>) and pass the cashu-format output file as path, or write a connector (propose_connector), which the app runs only after the owner approves it in Ustawienia > Konektory",
    },
  }),
];
