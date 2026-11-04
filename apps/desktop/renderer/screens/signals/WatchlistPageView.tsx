import { Button, Card, DateText, Percent, Sparkline, VirtualList } from "@cashu/ui";
import { useState } from "react";
import { field, searchOption } from "./controls.js";
import { statusLabel } from "./labels.js";
import { G } from "./Signals.strings.js";
import { Count, SignalValue } from "./SignalValue.js";
import type { WatchlistPageState } from "./useWatchlistPage.js";
import type { WatchRow } from "./watchModels.js";

const chip = "rounded-sm border border-border px-1.5 py-0.5";

/** The Watchlist page: instrument search with keyboard choice, the list with quotes, remove and undo. */
export function WatchlistPageView(props: WatchlistPageState) {
  const { search } = props;
  const hits = search.hits;
  // The highlighted search hit is presentational: it resets when the text changes.
  const [active, setActive] = useState(0);
  return (
    <>
      <Card>
        <label>
          {G.search}
          <input
            role="combobox"
            aria-expanded={hits.length > 0}
            aria-controls="signals-search-results"
            value={search.text}
            onChange={(event) => {
              props.onSearch(event.target.value);
              setActive(0);
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") props.onSearch("");
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setActive(Math.min(active + 1, hits.length - 1));
              }
              if (event.key === "ArrowUp") {
                event.preventDefault();
                setActive(Math.max(active - 1, 0));
              }
              const hit = hits[active];
              if (event.key === "Enter" && hit) props.onChoose(hit.key);
            }}
            className={field}
          />
        </label>
        {search.searching && <p role="status">{G.search}</p>}
        {search.remoteUnavailable && <p>{G.remoteUnavailable}</p>}
        <div id="signals-search-results" role="listbox">
          {hits.map((hit, index) => (
            <button
              key={hit.key}
              type="button"
              role="option"
              aria-selected={index === active}
              className={searchOption}
              onClick={() => props.onChoose(hit.key)}
            >
              {hit.symbol} · {hit.name} · {statusLabel(hit.state)} · {hit.opens ? G.opens : G.add}
            </button>
          ))}
        </div>
        {search.offerTyped && <Button onPress={props.onAddTyped}>{G.freeText}</Button>}
      </Card>
      {props.canRestore && <Button onPress={() => void props.onRestore()}>{G.undo}</Button>}
      <Card>
        <h2>{G.watchlist}</h2>
        {!props.available ? (
          <p>{G.unavailable}</p>
        ) : props.rows.length === 0 ? (
          <p>{G.noRows}</p>
        ) : (
          <VirtualList
            items={props.rows}
            getKey={(row) => row.id}
            label={G.watchlist}
            estimateSize={76}
            rowClassName="grid grid-cols-1 items-center gap-2 border-b border-border p-2 md:grid-cols-[minmax(7rem,1fr)_minmax(14rem,2fr)_minmax(16rem,2fr)_auto]"
            renderItem={(row) => <WatchLine {...props} row={row} />}
          />
        )}
      </Card>
    </>
  );
}

function WatchLine({ row, onOpenAsset, onRemove }: WatchlistPageState & { row: WatchRow }) {
  const { quote } = row;
  return (
    <>
      <Button variant="ghost" onPress={() => onOpenAsset(row.instrumentId)}>
        {row.label}
      </Button>
      <div className="flex min-w-0 flex-wrap items-center gap-2 text-sm">
        <span>{row.held ? G.heldInstrument : G.watched}</span>
        <span>{row.fromAgent ? G.agent : G.you}</span>
        {row.note && <span>{row.note}</span>}
        {row.tags.map((tag) => (
          <span key={tag} className={chip}>
            {tag}
          </span>
        ))}
        {row.marks.map((mark) => (
          <span key={mark} className={chip}>
            {mark}
          </span>
        ))}
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-2 text-sm">
        {quote ? (
          <>
            <span>
              {G.lastQuote}: <SignalValue value={quote.close} />
            </span>
            <DateText value={quote.date} />
            {quote.stale && <span>{G.stalePrice}</span>}
            <span>
              {G.changeDay}: <Percent value={quote.changeDay} />
            </span>
            <span>
              {G.changeMonth}: <Percent value={quote.changeMonth} />
            </span>
          </>
        ) : (
          <span>{G.noPrice}</span>
        )}
        {row.spark && <Sparkline values={row.spark} label={G.spark} />}
        <span>
          {G.liveAlerts}: <Count value={row.liveAlerts} />
        </span>
      </div>
      <Button className="justify-self-end" onPress={() => onRemove(row.instrumentId)}>
        {G.remove}
      </Button>
    </>
  );
}
