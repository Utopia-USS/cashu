// Texts of the statement import sources (importSources.tsx). See src/i18n.ts.
import { catalog } from "../../i18n.ts";

export const S = catalog({
  csvTitle: { pl: "Plik CSV z banku", en: "Bank CSV file" },
  csvDesc: { pl: "mBank, Bank Pekao, Erste: eksport historii z bankowości internetowej.", en: "mBank, Bank Pekao, Erste: a history export from online banking." },
  obDesc: { pl: "Enable Banking: logujesz się w banku, potem ↻ Synchronizuj co około dobę.", en: "Enable Banking: you log in at your bank, then ↻ Sync about once a day." },
  notConfigured: { pl: "nieskonfigurowany", en: "not configured" },
  connector: { pl: "Konektor", en: "Connector" },
  connectorDesc: {
    pl: "Własny importer innego banku; zgłasza go Claude Code, zatwierdzasz w Ustawieniach › Konektory.",
    en: "Your own importer for another bank; Claude Code proposes it, you approve it in Settings › Connectors.",
  },
  connectorTag: { pl: "konektor", en: "connector" },
  approveHint: { pl: "Zatwierdź w Ustawieniach › Konektory", en: "Approve it in Settings › Connectors" },
});
