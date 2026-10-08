// P5 asset header: the instrument's market segment (design/P5/segments-design.md 5), one more item of the
// header meta line. The select holds the explicit value only; the empty option names the auto value when one
// applies (`auto · Złoto i górnicy`), else `brak`. Choosing a catalog entry sets it, the empty option clears it.
import { useEffect, useState } from "react";
import { useToast } from "../../../ui";
import { errorText } from "../../../core/messages";
import { patchInstrumentSegment } from "../api";
import { bumpResearch } from "./research/data";
import { SEGMENTS, segmentLabel } from "./research/segments";

export function SegmentSelect({ slug, instrumentId, segment, source, sep, onChanged }: {
  slug: string; instrumentId: number; segment: string | null;
  /** `owner` / `agent` (earlier `set`) = an explicit value; `auto` = from the symbol or asset class table. */
  source: "owner" | "agent" | "auto" | "set" | null;
  /** A `·` before the item (other meta items precede it). */
  sep?: boolean;
  onChanged: () => void;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const explicit = source != null && source !== "auto" && !!segment;
  const [value, setValue] = useState<string>(explicit ? segment! : "");
  // A re-read (after this save or a change elsewhere, e.g. the agent) brings the stored value.
  useEffect(() => { setValue(explicit ? segment! : ""); }, [segment, explicit]);
  const autoLabel = source === "auto" && segment ? segmentLabel(segment) : null;
  const title = autoLabel ? "auto: po symbolu lub klasie aktywów. Wybór nadpisuje." : source === "agent" && value === segment ? "ustawił Claude" : undefined;
  const save = async (next: string) => {
    const prev = value;
    setValue(next);
    setBusy(true);
    // The research views (Rynek) re-read too: the instrument moves to another row.
    try { await patchInstrumentSegment(slug, instrumentId, next || null); bumpResearch(slug); onChanged(); }
    catch (e) { setValue(prev); toast(`Nie zapisano: ${errorText(e)}`, 4000); }
    finally { setBusy(false); }
  };
  return (
    <span className="mi">
      {sep && <span className="msep" aria-hidden>·</span>}
      <span>Segment</span>
      <select className="sgsel" aria-label="Segment rynku" value={value} disabled={busy} onChange={(e) => void save(e.target.value)}
        title={title}>
        <option value="">{autoLabel ? `auto · ${autoLabel}` : "brak"}</option>
        <optgroup label="Klasy aktywów">{SEGMENTS.filter((s) => s.group === "asset").map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}</optgroup>
        <optgroup label="Sektory">{SEGMENTS.filter((s) => s.group === "sector").map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}</optgroup>
      </select>
    </span>
  );
}
