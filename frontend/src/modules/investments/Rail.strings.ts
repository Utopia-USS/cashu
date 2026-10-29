// Texts of the rail pieces (src/modules/investments/Rail.tsx). See src/i18n.ts.
import { catalog } from "../../i18n.ts";

export const S = catalog({
  toClassify: { pl: "Do sklasyfikowania", en: "To classify" },
  proposePrompt: {
    pl: (label: string, isin: string | null, cls: string, region: string) =>
      `Zaproponuj zmianę strategii (propose_strategy): instrument ${label}${isin ? ` (${isin})` : ""}, klasa ${cls}${region ? `, region ${region}` : ""} nie pasuje do żadnego koszyka. Dodaj koszyk${region ? ` „${region}"` : ""} albo rozszerz istniejący i zaproponuj nowe cele.`,
    en: (label: string, isin: string | null, cls: string, region: string) =>
      `Propose a strategy change (propose_strategy): instrument ${label}${isin ? ` (${isin})` : ""}, class ${cls}${region ? `, region ${region}` : ""} fits no bucket. Add a bucket${region ? ` "${region}"` : ""} or widen an existing one and propose new targets.`,
  },
  copiedPaste: { pl: "Skopiowano · wklej w Claude Code", en: "Copied · paste it into Claude Code" },
  pieces: { pl: (q: string) => `${q} szt.`, en: (q: string) => `${q} units` },
  bought: { pl: (d: string, acc: string) => `kupno ${d}${acc} · `, en: (d: string, acc: string) => `bought ${d}${acc} · ` },
  outsideAllocation: { pl: "poza alokacją i regułami", en: "outside the allocation and rules" },
  cls: { pl: "Klasa", en: "Class" },
  region: { pl: "Region", en: "Region" },
  valuation: { pl: "Wycena", en: "Valuation" },
  bucket: { pl: "Koszyk", en: "Bucket" },
  noBucket: { pl: "bez koszyka", en: "no bucket" },
  noStrategy: { pl: "brak strategii", en: "no strategy" },
  newBucket: { pl: "nowy koszyk…", en: "new bucket…" },
  bucketMissing: {
    pl: (region: string, v: number) => `brak koszyka${region ? ` „${region}"` : ""} w strategii v${v}`,
    en: (region: string, v: number) => `no${region ? ` "${region}"` : ""} bucket in strategy v${v}`,
  },
  addsTag: { pl: (tags: string) => `doda tag ${tags}`, en: (tags: string) => `adds the tag ${tags}` },
  needsClass: { pl: (cls: string) => `koszyk wymaga klasy ${cls}`, en: (cls: string) => `the bucket needs the class ${cls}` },
  saving: { pl: "Zapisuję…", en: "Saving…" },
  proposeTitle: { pl: "Kopiuje polecenie dla agenta", en: "Copies a prompt for the agent" },
  propose: { pl: "Zaproponuj zmianę", en: "Propose a change" },
  dataWarnings: { pl: "Ostrzeżenia danych", en: "Data warnings" },
  uploadSnapshot: { pl: "wgraj snapshot", en: "upload a snapshot" },
  import: { pl: "import", en: "import" },
  addAlias: { pl: "dodaj alias", en: "add an alias" },
  hint: { pl: (h: string) => `(podpowiedź: ${h})`, en: (h: string) => `(hint: ${h})` },
  yahooSymbol: { pl: "Symbol Yahoo", en: "Yahoo symbol" },
});
