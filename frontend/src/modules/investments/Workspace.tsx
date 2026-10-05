// Inwestycje: one workspace for the Sunday review. Header row, KPIs, the review band (review mode),
// then the grid: state on the left (allocation, positions, accounts), the to-do rail on the right
// (signals with the decision form, instruments to classify, data warnings). Tasks happen in place or
// in a drawer; nothing opens a new page.
//
// Profile scoping: the shell remounts this page per profile (key = slug), every fetch takes the
// slug, and remembered values (account filter, review note draft) live under slug-scoped keys.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError } from "../../core/api";
import type { ModuleCtx } from "../../core/types";
import { useAsync } from "../../hooks";
import { Kpi, Notice, Skeleton, SkeletonKpis, SkeletonTable, useToast } from "../../ui";
import {
  type CommitResult, type Decision, type DecisionInput, getOverview, getPositions, getProposals, getReviewDigest, getSignals, getStrategy,
  getUnclassified, patchInstrument, type Position, postAcknowledge, postDecision, postReview, postRun, postStrategyInit, postStrategyReload,
  type Signal,
} from "./api";
import { AccountsPanel } from "./Accounts";
import { AllocationPanel } from "./Allocation";
import { AccountDrawer, HistoryDrawer, ImportDrawer, ProposalDrawer, ThesisDrawer, TxnDrawer, TxnsDrawer } from "./Drawers";
import { EmptyWorkspace } from "./EmptyWorkspace";
import { WorkspaceHeader } from "./Header";
import { storedKey, useDeferred, useShortcuts, useStored } from "./hooks";
import { bucketLabel, dm, hm, isoDate, money, nAccountsInv, pct, pctTarget, pp, RUN_STATUS, WEEKDAY_INDEX } from "./labels";
import { changeCount, type ChangeRow, orderSignals, reviewDue, runError, warningItems } from "./logic";
import { PositionsTable } from "./Positions";
import { ClassifyCard, SignalsCard, WarningsCard } from "./Rail";
import { ReviewBand } from "./ReviewBand";

type DrawerState =
  | { kind: "import"; account?: number | null }
  | { kind: "txn"; instrumentId?: number | string | null; type?: string }
  | { kind: "account" }
  | { kind: "thesis"; position: Position; thesisId: number | null }
  | { kind: "proposal"; id: number }
  | { kind: "history"; instrument: { id: number | string; label: string } | null }
  | { kind: "txns"; position: Position };

type Pending = { action: string; quantity: number | null; created_at: string | null };

const readSession = (k: string) => { try { return sessionStorage.getItem(k); } catch { return null; } };
const writeSession = (k: string, v: string) => { try { sessionStorage.setItem(k, v); } catch { /* ignore */ } };

export function Workspace({ ctx }: { ctx: ModuleCtx }) {
  const slug = ctx.slug;
  const toast = useToast();
  const { schedule } = useDeferred(6000);
  const [filter, setFilter] = useStored<number | null>(storedKey("filter", slug), null);
  const [note, setNote] = useStored<string>(storedKey("reviewNote", slug), "");
  const [nonce, setNonce] = useState(0);
  const reload = useCallback(() => setNonce((n) => n + 1), []);

  const accountsFilter = filter == null ? null : [filter];
  const ov = useAsync(() => getOverview(slug, accountsFilter), [slug, filter, nonce]);
  const pos = useAsync(() => getPositions(slug, accountsFilter), [slug, filter, nonce]);
  const sig = useAsync(() => getSignals(slug, "open"), [slug, nonce]);
  const uncl = useAsync(() => getUnclassified(slug), [slug, nonce]);
  const strat = useAsync(() => getStrategy(slug), [slug, nonce]);
  const dig = useAsync(() => getReviewDigest(slug).catch(() => null), [slug, nonce]);
  const props = useAsync(() => getProposals(slug).catch(() => []), [slug, nonce]);

  const [pending, setPending] = useState<ReadonlyMap<number, Pending>>(new Map());
  const [openSignal, setOpenSignal] = useState<number | null>(null);
  const [cursor, setCursor] = useState<number | null>(null);
  const [bucketFilter, setBucketFilter] = useState<string | null>(null);
  const [drawer, setDrawer] = useState<DrawerState | null>(null);
  const reviewKey = `finanse.inv.reviewOpen.${slug}`;
  const [reviewOpen, setReviewOpenState] = useState(() => readSession(reviewKey) === "1");
  const setReviewOpen = (v: boolean) => { setReviewOpenState(v); writeSession(reviewKey, v ? "1" : "0"); };
  // Data changed in a drawer (import, transaction, account): the shell's shared data (net worth,
  // account count) is refreshed when the drawer closes, not while it shows its result.
  const shellStale = useRef(false);
  const [step, setStep] = useState(0);
  const [doneLocal, setDoneLocal] = useState<string | null>(null);
  const reviewStarted = useRef<number | null>(null);
  const [hl, setHl] = useState<"signals" | "classify" | "warnings" | null>(null);
  const [classifyFocus, setClassifyFocus] = useState<string | null>(null);
  const [runBusy, setRunBusy] = useState(false);
  const [initBusy, setInitBusy] = useState(false);

  // A remembered filter that no longer names one of this profile's accounts (deleted, or an id
  // from an older data dir) falls back to all accounts instead of an error page.
  useEffect(() => {
    if (filter == null) return;
    const gone = ov.error ? /brokerage account|account id/i.test(ov.error) : ov.data ? !ov.data.accounts.some((a) => a.id === filter) : false;
    if (gone) setFilter(null);
  }, [ov.error, ov.data]); // eslint-disable-line react-hooks/exhaustive-deps

  const overview = ov.data;
  const positions = pos.data;
  const accounts = overview?.accounts ?? [];
  const today = overview?.as_of ?? isoDate(new Date());
  const base = overview?.base_currency ?? ctx.profile.base_currency;
  const hasData = !!positions && (positions.positions.length > 0 || positions.cash.some((c) => c.amount !== 0));
  const strategy = strat.data;
  const digest = dig.data;
  const weekday = digest?.digest_weekday ?? strategy?.facts?.notifications.digest_weekday ?? "sunday";
  const lastDone = doneLocal ?? digest?.last_review?.done_at ?? null;
  const due = doneLocal ? false : digest ? (digest.review_due ?? reviewDue(today, weekday, lastDone)) : false;

  // Signals: server state overlaid with decisions still inside their undo window, scoped to the
  // account filter (instrument signals of instruments held there; portfolio-wide ones stay).
  const signals = useMemo(() => {
    const held = new Set((positions?.positions ?? []).map((p) => String(p.instrument.id)));
    const list = (sig.data ?? []).map((s) => {
      const p = pending.get(s.id);
      return p ? { ...s, decisions: [...s.decisions, { id: -s.id, signal_id: s.id, instrument_id: s.instrument_id, account_id: null, price: null, currency: null, reason: null, ...p } as Decision] } : s;
    }).filter((s) => filter == null || s.instrument_id == null || held.has(String(s.instrument_id)));
    return orderSignals(list);
  }, [sig.data, pending, positions, filter]);
  const decidedCount = signals.filter((s) => s.decisions.length).length;

  // Review band: opens by itself on the digest weekday until the review is done (decision 7);
  // closing it by hand keeps it closed for that profile and day; otherwise it opens on click.
  const dismissKey = `finanse.inv.reviewClosed.${slug}.${today}`;
  useEffect(() => {
    if (!digest || !hasData || doneLocal) return;
    const [y, m, d] = today.split("-").map(Number);
    const isDay = new Date(y, m - 1, d).getDay() === (WEEKDAY_INDEX[weekday] ?? 0);
    if (isDay && digest.review_due && !readSession(dismissKey)) openReview();
  }, [digest, hasData]); // eslint-disable-line react-hooks/exhaustive-deps

  function openReview() { setReviewOpen(true); setStep(0); reviewStarted.current ??= Date.now(); }
  const toggleReview = () => {
    if (reviewOpen) { setReviewOpen(false); writeSession(dismissKey, "1"); } else openReview();
  };

  const scrollTo = (id: string, mark?: "signals" | "classify" | "warnings") => {
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
    if (mark) { setHl(mark); setTimeout(() => setHl((cur) => (cur === mark ? null : cur)), 2500); }
  };

  // ---- actions --------------------------------------------------------------------------
  const decide = (s: Signal, input: DecisionInput, label: string) => {
    const created = new Date().toISOString();
    setPending((cur) => new Map(cur).set(s.id, { action: input.action, quantity: input.quantity ?? null, created_at: created }));
    setOpenSignal(null);
    const drop = () => setPending((cur) => { const n = new Map(cur); n.delete(s.id); return n; });
    const cancel = schedule(() => {
      postDecision(slug, s.id, input)
        .catch((e: Error) => toast(`Nie zapisano decyzji: ${e.message}`, 5000))
        .finally(() => { drop(); reload(); });
    });
    toast(`Zapisano decyzję · ${label.replace("decyzja: ", "")}`, 6000, { label: "Cofnij", onClick: () => { if (cancel()) drop(); } });
  };
  const ack = (s: Signal, reason?: string) => {
    setPending((cur) => new Map(cur).set(s.id, { action: reason?.startsWith("odłożone") ? "other" : "held", quantity: null, created_at: new Date().toISOString() }));
    setOpenSignal(null);
    const drop = () => setPending((cur) => { const n = new Map(cur); n.delete(s.id); return n; });
    const cancel = schedule(() => {
      postAcknowledge(slug, s.id, reason)
        .catch((e: Error) => toast(`Nie zapisano potwierdzenia: ${e.message}`, 5000))
        .finally(() => { drop(); reload(); });
    });
    const until = reason ? /\d{4}-\d{2}-\d{2}/.exec(reason)?.[0] : undefined;
    toast(until ? `Odłożone do ${dm(until)}` : "Potwierdzone bez zmian", 6000, { label: "Cofnij", onClick: () => { if (cancel()) drop(); } });
  };

  const markDone = () => {
    const minutes = reviewStarted.current ? Math.max(1, Math.round((Date.now() - reviewStarted.current) / 60000)) : null;
    const stats = { open_signals: signals.length, decided: decidedCount, ...(minutes ? { minutes } : {}) };
    const text = note.trim() || null;
    setReviewOpen(false);
    setDoneLocal(new Date().toISOString());
    const next = nextDigest(today, weekday);
    const cancel = schedule(() => {
      postReview(slug, text, stats)
        .then(() => { setNote(""); reviewStarted.current = null; })
        .catch((e: Error) => {
          setDoneLocal(null);
          toast(e instanceof ApiError && e.status === 404 ? "Serwer nie zapisuje jeszcze przeglądów (brak /reviews)." : `Nie zapisano przeglądu: ${e.message}`, 5000);
        })
        .finally(reload);
    });
    toast(`Przegląd zapisany · następny ${dm(next)}`, 6000, { label: "Cofnij", onClick: () => { if (cancel()) { setDoneLocal(null); setReviewOpen(true); } } });
  };

  const run = async () => {
    setRunBusy(true);
    try {
      const r = await postRun(slug);
      const p = r.profiles?.[0];
      const status = p?.status ?? "ok";
      const firstErr = p?.errors?.[0] ?? r.market_errors?.[0] ?? r.market_error ?? "";
      toast(status === "failed" ? `Przebieg reguł nieudany${firstErr ? `: ${runError(firstErr)}` : ""}` : status === "partial" ? `Reguły przeliczone częściowo${firstErr ? ` · ${runError(firstErr)}` : ""}` : "Reguły przeliczone", 4000);
      reload();
    } catch (e) {
      toast(e instanceof ApiError && e.status === 409 ? "Reguły już działają (worker)" : `Nie udało się uruchomić reguł: ${(e as Error).message}`, 4000);
    } finally { setRunBusy(false); }
  };
  const initStrategy = async () => {
    setInitBusy(true);
    try {
      await postStrategyInit(slug);
      await postStrategyReload(slug).catch(() => null); // records version 1 right away
      toast("Utworzono strategię z szablonu · uzupełnij strategy.yaml albo poproś agenta o propozycję", 4000);
      reload();
    } catch (e) { toast(`Nie utworzono strategii: ${(e as Error).message}`, 4000); } finally { setInitBusy(false); }
  };
  const reloadStrategy = async () => {
    try { const s = await postStrategyReload(slug); toast(s.version != null ? `Strategia wczytana · v${s.version}` : "Brak pliku strategii", 2500); reload(); }
    catch (e) { toast(`Nie wczytano strategii: ${(e as Error).message}`, 4000); }
  };
  const classify = async (i: { id: number | string }, patch: { asset_class: string; region: string | null; valuation_mode: string; tags: string[] }) => {
    try { await patchInstrument(slug, i.id, patch); toast("Zapisano klasyfikację · alokacja przeliczona", 2500); reload(); }
    catch (e) { toast(`Nie zapisano: ${(e as Error).message}`, 4000); throw e; }
  };
  const alias = async (instrumentId: string, yahoo: string) => {
    try { await patchInstrument(slug, instrumentId, { aliases: [{ namespace: "yahoo", value: yahoo }] }); toast("Zapisano alias · ceny przy następnym przebiegu reguł", 3000); reload(); }
    catch (e) { toast(`Nie zapisano aliasu: ${(e as Error).message}`, 4000); throw e; }
  };
  const focusClassify = (id: number | string) => { setClassifyFocus(String(id)); scrollTo("inv-classify", "classify"); };
  const jump = (key: ChangeRow["key"]) => {
    if (key === "signals" || key === "decisions") scrollTo("inv-signals", "signals");
    else if (key === "prices") scrollTo("inv-warnings", "warnings");
    else if (key === "strategy") document.getElementById("inv-strategy-btn")?.click();
    else scrollTo("inv-accounts");
  };
  const onStep = (k: number) => {
    setStep(k);
    if (k === 1) scrollTo("inv-signals", "signals");
    if (k === 2) document.getElementById("inv-review-note")?.focus();
  };

  // Keyboard: r review, i import, j/k between signals, Enter expands.
  const moveCursor = (d: number) => {
    const open = signals.filter((s) => !s.decisions.length);
    if (!open.length) return;
    const i = open.findIndex((s) => s.id === cursor);
    const next = open[Math.max(0, Math.min(open.length - 1, i < 0 ? 0 : i + d))];
    setCursor(next.id);
    document.querySelector(`[data-signal="${next.id}"]`)?.scrollIntoView({ block: "nearest" });
  };
  useShortcuts({
    r: () => hasData && toggleReview(),
    i: () => setDrawer({ kind: "import", account: filter }),
    j: () => moveCursor(1),
    k: () => moveCursor(-1),
    Enter: () => { if (cursor != null) setOpenSignal((cur) => (cur === cursor ? null : cursor)); },
  }, drawer == null);

  // ---- render ---------------------------------------------------------------------------
  const err = ov.error || pos.error;
  if (err && !overview) return <div className="err">Błąd: {err}</div>;
  if (!overview || !positions || !strat.data && !strat.error) {
    return (
      <>
        <div className="wshead"><h2>Inwestycje</h2><Skeleton w={320} h={26} /><span className="spacer" /><Skeleton w={260} h={26} /></div>
        <SkeletonKpis n={6} />
        <div className="ws">
          <div><SkeletonTable rows={5} /><SkeletonTable rows={7} /></div>
          <div className="rail"><SkeletonTable rows={4} /><SkeletonTable rows={2} /></div>
        </div>
      </>
    );
  }

  const k = overview.kpis;
  const alloc = overview.allocation;
  const labels = new Map(positions.positions.map((p) => [String(p.instrument.id), p.instrument.label]));
  const warnings = warningItems({
    warnings: overview.warnings, labels, accounts, stale: overview.freshness.prices.stale, missingFx: overview.freshness.fx.missing, today,
  });
  const aliasHints = new Map(positions.positions.map((p) => [String(p.instrument.id), yahooHint(p.instrument.symbol, p.instrument.mic)]));
  const proposals = props.data ?? [];
  const changes = digest ? changeCount(digest) : 0;
  const cashTarget = strategy?.facts?.targets?.cash;
  const lastRun = k.last_run;
  const header = (
    <WorkspaceHeader accounts={accounts} filter={filter} onFilter={(id) => { setFilter(id); setBucketFilter(null); }} overview={overview} hasData={hasData}
      strategy={strategy ?? null} proposals={proposals} runBusy={runBusy} canRun={hasData} onRun={run}
      onImport={() => setDrawer({ kind: "import", account: filter })} onAddTxn={() => setDrawer({ kind: "txn" })}
      review={{ open: reviewOpen, due, changes, doneToday: lastDone && lastDone.slice(0, 10) === today ? lastDone : doneLocal }}
      onReview={toggleReview} onProposal={(id) => setDrawer({ kind: "proposal", id })}
      onStrategyInit={initStrategy} onStrategyReload={reloadStrategy} onWarnings={() => scrollTo("inv-warnings", "warnings")} />
  );

  const drawers = renderDrawer();
  if (!hasData) {
    return (
      <>
        {header}
        <EmptyWorkspace accounts={accounts} strategy={strategy ?? null} hasTxn={positions.positions.length > 0}
          onAddAccount={() => setDrawer({ kind: "account" })} onInitStrategy={initStrategy} onAddTxn={() => setDrawer({ kind: "txn" })}
          onImport={() => setDrawer({ kind: "import", account: filter })} initBusy={initBusy} />
        {drawers}
      </>
    );
  }

  // The weekly change is portfolio-wide: not shown against an account subset.
  const valueChange = filter == null && digest?.value.change != null && digest.value.then != null ? digest.value : null;
  const runHint = lastRun
    ? lastRun.status === "ok" ? "ok" : `${RUN_STATUS[lastRun.status] ?? lastRun.status}${lastRun.errors[0] ? ` · ${runError(lastRun.errors[0])}` : ""}`
    : "jeszcze nie uruchomiono";
  const drift = k.max_drift;

  return (
    <>
      {header}
      <div className="kpis">
        <Kpi label={`Wartość portfela (${base})`} value={money(k.value.total, base)}
          hint={valueChange ? `${money(valueChange.change, base, true)}${valueChange.change_pct != null ? ` (${pct(valueChange.change_pct, true)})` : ""} od ${dm(digest!.since)}` : `pozycje ${money(k.value.holdings, base)}`}
          hintCls={valueChange ? (valueChange.change! >= 0 ? "pos" : "neg") : undefined} />
        <Kpi label="Wynik niezrealizowany" value={money(k.unrealized.amount, base, true)}
          cls={k.unrealized.amount == null ? "" : k.unrealized.amount >= 0 ? "pos" : "neg"}
          hint={k.unrealized.pct != null ? `${pct(k.unrealized.pct, true)} od kosztu ${money(k.unrealized.cost, base)}` : "koszt nieznany"} />
        <Kpi label="Gotówka" value={money(k.cash.amount, base)}
          hint={`${pct(k.cash.weight)}${cashTarget != null ? ` · cel ${pctTarget(cashTarget)}` : ""} · ${nAccountsInv(k.cash.accounts)}`} />
        <Kpi label="Sygnały" value={k.signals.action + k.signals.info}
          hint={<>{k.signals.action > 0 && <span className="neg">{k.signals.action} do działania</span>}{k.signals.action > 0 && " · "}{k.signals.info} do przeglądu</>} />
        <Kpi label="Dryf maks." value={drift ? pp(drift.drift_pp) : "-"} cls={drift?.out_of_band ? "warn" : ""}
          hint={drift ? `${bucketLabel(drift.bucket_id)} · ${drift.out_of_band ? `poza pasmem ±${alloc.band?.absolute_band_pp ?? 5} pp` : "w paśmie"}` : alloc.has_strategy ? "brak koszyków" : "bez strategii"} />
        <Kpi label="Reguły" value={lastRun ? runWhen(lastRun.finished_at ?? lastRun.started_at, today) : "-"}
          cls={lastRun?.status === "failed" ? "neg" : ""}
          hint={runHint} hintCls={lastRun?.status === "partial" ? "warn" : lastRun?.status === "failed" ? "neg" : undefined} />
      </div>

      {reviewOpen && digest && (
        <ReviewBand digest={digest} accounts={accounts} step={step} onStep={onStep} note={note} onNote={setNote}
          decided={decidedCount} total={signals.length} onDone={markDone} onJump={jump} busy={false} />
      )}
      {reviewOpen && !digest && (
        <Notice tone="warn" action={<button className="btn" onClick={() => setReviewOpen(false)}>Zamknij</button>}>Podsumowanie zmian jest niedostępne (serwer bez /review-digest).</Notice>
      )}
      {lastRun?.status === "failed" && <Notice tone="neg">Ostatni przebieg reguł się nie udał{lastRun.errors[0] ? `: ${lastRun.errors[0]}` : ""}. Sygnały poniżej pochodzą z wcześniejszego przebiegu.</Notice>}

      <div className="ws">
        <div className="main">
          <AllocationPanel alloc={alloc} strategy={strategy ?? null} filtered={filter != null} selected={bucketFilter}
            onSelect={(b) => { setBucketFilter(b); if (b) document.getElementById("inv-positions")?.scrollIntoView({ behavior: "smooth", block: "start" }); }}
            onClassify={focusClassify} />
          <PositionsTable slug={slug} data={positions} accounts={accounts} buckets={alloc.buckets} signals={signals} hasStrategy={alloc.has_strategy}
            bucketFilter={bucketFilter} onClearFilter={() => setBucketFilter(null)} refreshKey={nonce}
            actions={{
              onClassify: focusClassify,
              onAddTxn: (id) => setDrawer({ kind: "txn", instrumentId: id }),
              onTxns: (p) => setDrawer({ kind: "txns", position: p }),
              onThesis: (p, id) => setDrawer({ kind: "thesis", position: p, thesisId: id }),
              onDecisions: (p) => setDrawer({ kind: "history", instrument: { id: p.instrument.id, label: p.instrument.label } }),
            }} />
          <AccountsPanel accounts={accounts} base={base} today={today} filter={filter} onAdd={() => setDrawer({ kind: "account" })}
            onReconcile={(id) => setDrawer({ kind: "import", account: id })} />
        </div>
        <aside className="rail">
          <SignalsCard signals={signals} openId={openSignal} cursorId={cursor} highlight={hl === "signals" || (reviewOpen && step === 1)}
            positions={positions.positions} buckets={alloc.buckets} total={alloc.total} base={base} accounts={accounts} today={today}
            contributionDay={strategy?.facts?.contributions?.day_of_month ?? null} slug={slug}
            onToggle={(id) => { setOpenSignal(id); if (id != null) setCursor(id); }} onDecide={decide} onAck={ack}
            onHistory={() => setDrawer({ kind: "history", instrument: null })} />
          <ClassifyCard items={uncl.data ?? []} positions={positions.positions} strategy={strategy ?? null} accounts={accounts}
            onSave={classify} highlight={hl === "classify"} focusId={classifyFocus} />
          <WarningsCard items={warnings} highlight={hl === "warnings"} aliasHints={aliasHints} onAlias={alias}
            onAction={(w) => setDrawer({ kind: "import", account: w.key.startsWith("snap:") ? Number(w.key.slice(5)) : filter })} />
        </aside>
      </div>
      {drawers}
    </>
  );

  function renderDrawer() {
    if (!drawer) return null;
    const close = () => {
      setDrawer(null);
      if (shellStale.current) { shellStale.current = false; ctx.refresh(); }
    };
    const positionsList = positions?.positions ?? [];
    switch (drawer.kind) {
      case "import":
        return (
          <ImportDrawer slug={slug} accounts={accounts} initialAccount={drawer.account ?? null} onClose={close}
            onDone={(r: CommitResult) => { toast(`Zaimportowano ${r.inserted} transakcji`, 2500); shellStale.current = true; reload(); }}
            onAddAccount={() => setDrawer({ kind: "account" })} onManual={() => setDrawer({ kind: "txn" })}
            onClassify={() => { close(); setTimeout(() => scrollTo("inv-classify", "classify"), 50); }} />
        );
      case "txn":
        return (
          <TxnDrawer slug={slug} accounts={accounts} positions={positionsList} preset={{ instrumentId: drawer.instrumentId ?? null, type: drawer.type, accountId: filter }}
            onClose={close} onSaved={(w) => { shellStale.current = true; close(); toast(w.length ? `Zapisano transakcję · uwaga: ${w[0]}` : "Zapisano transakcję", w.length ? 5000 : 2500); reload(); }} />
        );
      case "account":
        return <AccountDrawer slug={slug} onClose={close} onSaved={(a) => { shellStale.current = true; close(); toast(`Dodano rachunek ${a.name}`, 2500); reload(); }} />;
      case "thesis": {
        return (
          <ThesisLoader slug={slug} position={drawer.position} thesisId={drawer.thesisId} onClose={close}
            onSaved={() => { close(); toast("Zapisano tezę", 2000); reload(); }} />
        );
      }
      case "proposal":
        return (
          <ProposalDrawer slug={slug} id={drawer.id} version={strategy?.version ?? null} onClose={close} onChanged={reload}
            onDone={(ok, v) => { close(); toast(ok ? `Zatwierdzono propozycję${v ? ` · strategia v${v}` : ""}` : "Odrzucono propozycję", 3000); reload(); }} />
        );
      case "history":
        return <HistoryDrawer slug={slug} instrument={drawer.instrument} onClose={close} />;
      case "txns":
        return <TxnsDrawer slug={slug} position={drawer.position} accounts={accounts} onClose={close} onAdd={() => setDrawer({ kind: "txn", instrumentId: drawer.position.instrument.id })} />;
    }
  }
}

/** Thesis drawer with the thesis loaded from the position detail (or empty for a new one). */
function ThesisLoader({ slug, position, thesisId, onClose, onSaved }: { slug: string; position: Position; thesisId: number | null; onClose: () => void; onSaved: () => void }) {
  const d = useAsync(() => (thesisId == null ? Promise.resolve(null) : import("./api").then((m) => m.getPositionDetail(slug, position.instrument.id))), [slug, thesisId]);
  if (thesisId != null && !d.data) return null;
  const thesis = d.data?.theses.find((t) => t.id === thesisId) ?? null;
  return <ThesisDrawer slug={slug} position={position} thesis={thesis} onClose={onClose} onSaved={onSaved} />;
}

function runWhen(iso: string | null, today: string): string {
  if (!iso) return "-";
  const day = isoDate(new Date(iso));
  const [y, m, d] = today.split("-").map(Number);
  const yesterday = isoDate(new Date(y, m - 1, d - 1));
  const prefix = day === today ? "dziś" : day === yesterday ? "wczoraj" : dm(iso);
  return `${prefix} ${hm(iso)}`.trim();
}

function nextDigest(today: string, weekday: string): string {
  const [y, m, d] = today.split("-").map(Number);
  const t = new Date(y, m - 1, d);
  const add = ((WEEKDAY_INDEX[weekday] ?? 0) - t.getDay() + 7) % 7 || 7;
  return isoDate(new Date(y, m - 1, d + add));
}

/** Yahoo symbol suggestion for an instrument without a price alias (listing suffix by MIC). */
function yahooHint(symbol: string | null, mic: string | null): string {
  if (!symbol) return "";
  const suffix: Record<string, string> = { XWAR: ".WA", XETR: ".DE", XLON: ".L", XAMS: ".AS", XPAR: ".PA", XMIL: ".MI", XSWX: ".SW" };
  return `${symbol}${suffix[mic ?? ""] ?? ""}`;
}
