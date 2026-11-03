/** Copied raw facts for the two S38d reads. No labelled Python results enter native computation. */
import { views } from "@cashu/domain/investments";
import { investmentWriteServices, type NativeToolStore, type ToolContext } from "@cashu/mcp";
import type { PythonDb } from "../../sources/pythonDb.ts";
import { copiedProjectionInput, nativeViewSources } from "../investments/viewSource.ts";

export function bindInvestmentWriteReads(
  db: PythonDb,
  profileId: number,
  context: ToolContext<NativeToolStore>,
) {
  const source = nativeViewSources(db).find((row) => row.profile.id === profileId);
  if (source === undefined) throw new Error("missing native investment-write read source");
  const native = investmentWriteServices(context, {
    portfolio: { ...source.request, lang: "pl" },
    isHolder: () => false,
  });
  return {
    ...native,
    watchlist(pending?: Parameters<typeof native.watchlist>[0]) {
      if (pending !== undefined) throw new Error("copied read adapter cannot project a mutation");
      // The established adapter preserves Python's source ordering/classification quirks using raw
      // source rows and metadata, while production identities and view ordering stay canonical.
      const input = copiedProjectionInput(db, source, { forOwner: false });
      return views.watchlistView({ ...input, options: { ...input.options, lang: "pl" } });
    },
  };
}
