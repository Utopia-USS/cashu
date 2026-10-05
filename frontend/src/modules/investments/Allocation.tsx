// Alokacja vs cel: bars on one shared scale with the strategy's band and target tick, drift and
// "do celu" coloured --warn only out of band. Seg switches buckets / asset classes / regions; a click
// on a bucket filters the positions table.
import { useState } from "react";
import { AllocBar, Notice, Seg, Tag } from "../../ui";
import type { Allocation, StrategyStatus } from "./api";
import { assetClass, bucketColor, bucketLabel, money0, nBuckets, nRules, pct, pctTarget, pp, region } from "./labels";
import { allocScale, bandFor, bandTag } from "./logic";

type Group = "bucket" | "asset_class" | "region";

export function AllocationPanel({ alloc, strategy, filtered, selected, onSelect, onClassify }: {
  alloc: Allocation;
  strategy: StrategyStatus | null;
  /** Account filter active: targets apply to the whole portfolio, shown greyed. */
  filtered: boolean;
  selected: string | null;
  onSelect: (bucket: string | null) => void;
  onClassify: (instrumentId: number | string) => void;
}) {
  const [group, setGroup] = useState<Group>("bucket");
  const c = alloc.base_currency;
  const policy = alloc.band;
  const outOfBand = alloc.buckets.filter((b) => b.out_of_band).length;
  const order = alloc.buckets.map((b) => b.bucket_id);
  const hasStrategy = alloc.has_strategy && alloc.buckets.length > 0;
  const view: Group = hasStrategy ? group : group === "bucket" ? "asset_class" : group;

  const shareRows = view === "asset_class" ? alloc.by_asset_class : alloc.by_region;
  const scale = view === "bucket"
    ? allocScale([...alloc.buckets.map((b) => ({ weight: b.weight, target: b.target })), { weight: alloc.unclassified?.weight ?? 0 }], policy)
    : allocScale(shareRows.map((r) => ({ weight: r.weight })), null);

  return (
    <section className="card chart-card">
      <div className="controls" style={{ marginBottom: 8 }}>
        <h2 style={{ margin: 0 }}>Alokacja vs cel</h2>
        {hasStrategy && <Tag tone={outOfBand ? "warn" : undefined}>{bandTag(outOfBand)}</Tag>}
        {filtered && hasStrategy && <span className="hint">cel dotyczy całego portfela</span>}
        <span className="spacer" />
        <Seg<Group> items={[["Koszyki", "bucket"], ["Klasy aktywów", "asset_class"], ["Regiony", "region"]]} value={view}
          onChange={(g) => setGroup(g)} />
      </div>

      {!alloc.has_strategy && (
        <Notice tone="info">Bez strategii pokazuję tylko udziały; cele i pasma pojawią się po zapisaniu strategy.yaml.</Notice>
      )}

      {view === "bucket" ? (
        <>
          <div className="alloc-row alloc-head" role="row">
            <span>Koszyk</span><span>udział · pasmo · cel</span><span className="num">Teraz</span><span className="num">Cel</span><span className="num">Dryf</span><span className="num">Do celu</span>
          </div>
          {alloc.buckets.map((b) => {
            const out = !!b.out_of_band;
            const color = bucketColor(b.bucket_id, order);
            const sel = selected === b.bucket_id;
            const small = policy && Math.abs(b.to_target) < policy.min_trade_value;
            return (
              <div key={b.bucket_id} className={`alloc-row clickable ${sel ? "sel" : ""}`} role="button" tabIndex={0}
                aria-pressed={sel} title={sel ? "Pokaż wszystkie pozycje" : "Pokaż pozycje tego koszyka"}
                onClick={() => onSelect(sel ? null : b.bucket_id)}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect(sel ? null : b.bucket_id); } }}>
                <span className="name"><i className="swatch" style={{ background: color }} /><span>{bucketLabel(b.bucket_id)}</span></span>
                <AllocBar current={b.weight ?? 0} target={b.target} band={filtered ? null : bandFor(b.target, policy)} max={scale} color={color} mutedTarget={filtered} />
                <span className="num">{pct(b.weight)}</span>
                <span className="num muted">{pctTarget(b.target)}</span>
                <span className="num" style={out ? { color: "var(--warn)", fontWeight: 600 } : undefined}>{pp(b.drift_pp)}</span>
                <span className={`num ${out ? "" : "muted"}`} style={out ? { color: "var(--warn)" } : undefined}>
                  {small ? "-" : money0(b.to_target, c, true)}
                </span>
              </div>
            );
          })}
          {alloc.unclassified && (alloc.unclassified.weight ?? 0) > 0 && (
            <div className="alloc-row" style={{ color: "var(--muted)" }}>
              <span className="name"><i className="swatch" style={{ background: "var(--inv-other)" }} /><span>Bez koszyka</span></span>
              <AllocBar current={alloc.unclassified.weight ?? 0} max={scale} color="var(--inv-other)" />
              <span className="num">{pct(alloc.unclassified.weight)}</span><span className="num">-</span><span className="num">-</span>
              <span className="num">
                {alloc.unclassified.instruments.slice(0, 1).map((i) => (
                  <button key={String(i.id)} className="lnk" style={{ fontSize: 12 }} onClick={() => onClassify(i.id)}>
                    sklasyfikuj {i.label.split(" ")[0]}{alloc.unclassified!.instruments.length > 1 ? ` +${alloc.unclassified!.instruments.length - 1}` : ""}
                  </button>
                ))}
              </span>
            </div>
          )}
          <div className="alloc-foot">
            {policy && <span>pasmo: ±{policy.absolute_band_pp} pp lub {pctTarget(policy.relative_band)} względne (co pierwsze)</span>}
            {policy && <span>min. transakcja {money0(policy.min_trade_value, c)}</span>}
            <span>skala paska 0-{Math.round(scale * 100)} %</span>
            {strategy?.version != null && strategy.facts && (
              <span>strategy.yaml v{strategy.version} · {nBuckets(strategy.facts.buckets.length)} · {nRules(strategy.facts.rules.length)}</span>
            )}
          </div>
        </>
      ) : (
        <>
          <div className="alloc-row share alloc-head" role="row">
            <span>{view === "asset_class" ? "Klasa aktywów" : "Region"}</span><span>udział</span><span className="num">Teraz</span><span className="num">Wartość</span>
          </div>
          {shareRows.map((r, k) => (
            <div key={r.key} className="alloc-row share">
              <span className="name"><i className="swatch" style={{ background: r.key === "cash" ? "var(--inv-cash)" : `var(--inv-${["global", "pl", "bonds", "5", "6", "7"][k % 6]})` }} />
                <span>{r.key === "cash" ? "gotówka" : view === "asset_class" ? assetClass(r.key) : region(r.key)}</span></span>
              <AllocBar current={r.weight ?? 0} max={scale} color={r.key === "cash" ? "var(--inv-cash)" : `var(--inv-${["global", "pl", "bonds", "5", "6", "7"][k % 6]})`} />
              <span className="num">{pct(r.weight)}</span>
              <span className="num muted">{money0(r.value, c)}</span>
            </div>
          ))}
          {!shareRows.length && <div className="muted" style={{ fontSize: 13, padding: "8px 0" }}>Brak wycenionych pozycji.</div>}
          <div className="alloc-foot">
            <span>cele strategii dotyczą tylko koszyków</span>
            <span>skala paska 0-{Math.round(scale * 100)} %</span>
          </div>
        </>
      )}
    </section>
  );
}
