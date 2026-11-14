/** Instrument facts from the actual command's winning legal creation/alias effects. */
import { toCurrency } from "@cashu/domain";
import {
  asInstrumentId,
  type Instrument,
  instrument,
  instrumentAlias,
  parseAssetClass,
  parseInstrumentStatus,
  parseValuationMode,
} from "@cashu/domain/investments";
import type { CommandContext } from "../../command.js";
import { type InstrumentSpec, instrumentSpec } from "../commands/instruments.js";

export function captureInstrumentEffect(ctx: CommandContext) {
  let creation: { gid: string; spec: InstrumentSpec; valuationMode: string } | undefined;
  const aliases: { namespace: string; value: string; guessed: boolean }[] = [];
  const context: CommandContext = {
    ...ctx,
    emit(type, gid, data, options) {
      const result = ctx.emit(type, gid, data, options);
      if (type === "instrument.created") {
        if (creation) throw new Error("multiple prospective instrument creations");
        creation = {
          gid,
          spec: instrumentSpec.parse(data),
          valuationMode: String(data.valuationMode),
        };
      } else if (type === "instrument.aliasAdded" && creation && data.instrument === creation.gid) {
        aliases.push({
          namespace: String(data.namespace),
          value: String(data.value),
          guessed: data.guessed === true,
        });
      }
      return result;
    },
  };
  return {
    context,
    row(gid: string): Instrument | undefined {
      if (!creation || creation.gid !== gid) return undefined;
      const { spec } = creation;
      // SQL's namespace/guessed/id order: ties retain actual emitted insertion order.
      const ordered = [...aliases].sort((a, b) =>
        a.namespace < b.namespace
          ? -1
          : a.namespace > b.namespace
            ? 1
            : Number(a.guessed) - Number(b.guessed),
      );
      return instrument({
        id: asInstrumentId(gid),
        name: spec.name,
        currency: toCurrency(spec.currency),
        assetClass: parseAssetClass(spec.assetClass),
        symbol: spec.symbol ?? null,
        isin: spec.isin ?? null,
        mic: spec.mic ?? null,
        region: spec.region ?? null,
        sector: spec.sector ?? null,
        tags: spec.tags,
        needsClassification: spec.needsClassification,
        valuationMode: parseValuationMode(creation.valuationMode),
        status: parseInstrumentStatus(spec.status),
        aliases: ordered.map((a) => instrumentAlias(a.namespace, a.value, a.guessed)),
      });
    },
  };
}
