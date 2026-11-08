import type { TranslationVariants } from "@cashu/i18n";
import { C } from "./core/strings.js";
import { N } from "./native.strings.js";

type Text = TranslationVariants<string>;

/** Native command syntax. The first two tokens select a leaf for grouped commands. */
export const HELP: Readonly<Record<string, Text>> = {
  invest: {
    pl: "Użycie: cashu invest accounts|positions|performance|search|signals|strategy|import|validate|run|macro|instruments|alerts ...",
    en: "Usage: cashu invest accounts|positions|performance|search|signals|strategy|import|validate|run|macro|instruments|alerts ...",
  },
  "invest accounts": {
    pl: "Użycie: cashu invest accounts list|add ...",
    en: "Usage: cashu invest accounts list|add ...",
  },
  "invest accounts list": {
    pl: "Użycie: cashu invest accounts list",
    en: "Usage: cashu invest accounts list",
  },
  "invest accounts add": {
    pl: "Użycie: cashu invest accounts add NAZWA --broker BROKER [--wrapper TYP] [--currency KOD]",
    en: "Usage: cashu invest accounts add NAME --broker BROKER [--wrapper TYPE] [--currency CODE]",
  },
  "invest positions": {
    pl: "Użycie: cashu invest positions [--account GID]. GID znajdziesz przez `cashu invest accounts list`.",
    en: "Usage: cashu invest positions [--account GID]. Find the GID with `cashu invest accounts list`.",
  },
  "invest performance": {
    pl: "Użycie: cashu invest performance [--range 1m|3m|ytd|1y|3y|max] [--account GID] [--attribution]",
    en: "Usage: cashu invest performance [--range 1m|3m|ytd|1y|3y|max] [--account GID] [--attribution]",
  },
  "invest search": {
    pl: "Użycie: cashu invest search ZAPYTANIE [--local]. Domyślnie szuka także w publicznych źródłach online.",
    en: "Usage: cashu invest search QUERY [--local]. By default it also searches public online sources.",
  },
  "invest import": {
    pl: "Użycie: cashu invest import PLIK --account GID [--mapping PLIK] [--importer ID] [--dry-run] [--apply-corrections]",
    en: "Usage: cashu invest import FILE --account GID [--mapping FILE] [--importer ID] [--dry-run] [--apply-corrections]",
  },
  "invest validate": {
    pl: "Użycie: cashu invest validate PLIK [--mapping PLIK]",
    en: "Usage: cashu invest validate FILE [--mapping FILE]",
  },
  "invest strategy": {
    pl: "Użycie: cashu invest strategy init|validate ...",
    en: "Usage: cashu invest strategy init|validate ...",
  },
  "invest strategy init": {
    pl: "Użycie: cashu invest strategy init [--template NAZWA] [--force]",
    en: "Usage: cashu invest strategy init [--template NAME] [--force]",
  },
  "invest strategy validate": {
    pl: "Użycie: cashu invest strategy validate",
    en: "Usage: cashu invest strategy validate",
  },
  "invest signals": {
    pl: "Użycie: cashu invest signals [--history]",
    en: "Usage: cashu invest signals [--history]",
  },
  "invest run": {
    pl: "Użycie: cashu invest run [--offline] [--all]",
    en: "Usage: cashu invest run [--offline] [--all]",
  },
  "invest macro": {
    pl: "Użycie: cashu invest macro refresh",
    en: "Usage: cashu invest macro refresh",
  },
  "invest instruments": {
    pl: "Użycie: cashu invest instruments merge ŹRÓDŁO CEL [--dry-run]",
    en: "Usage: cashu invest instruments merge SOURCE TARGET [--dry-run]",
  },
  "invest instruments merge": {
    pl: "Użycie: cashu invest instruments merge ŹRÓDŁO CEL [--dry-run]",
    en: "Usage: cashu invest instruments merge SOURCE TARGET [--dry-run]",
  },
  "invest alerts": {
    pl: "Użycie: cashu invest alerts kinds",
    en: "Usage: cashu invest alerts kinds",
  },
  budget: {
    pl: "Użycie: cashu budget cash|cash-add|import-csv|import-dir|categorize|set-category|reclassify|match-transfers|cushion|month-close ...",
    en: "Usage: cashu budget cash|cash-add|import-csv|import-dir|categorize|set-category|reclassify|match-transfers|cushion|month-close ...",
  },
  cash: { pl: "Użycie: cashu cash [--currency KOD]", en: "Usage: cashu cash [--currency CODE]" },
  "budget cash": {
    pl: "Użycie: cashu budget cash [--currency KOD]",
    en: "Usage: cashu budget cash [--currency CODE]",
  },
  "cash-add": {
    pl: "Użycie: cashu cash-add KWOTA TYTUŁ KATEGORIA [--date YYYY-MM-DD] [--currency KOD]",
    en: "Usage: cashu cash-add AMOUNT TITLE CATEGORY [--date YYYY-MM-DD] [--currency CODE]",
  },
  "budget cash-add": {
    pl: "Użycie: cashu budget cash-add KWOTA TYTUŁ KATEGORIA [--date YYYY-MM-DD] [--currency KOD]",
    en: "Usage: cashu budget cash-add AMOUNT TITLE CATEGORY [--date YYYY-MM-DD] [--currency CODE]",
  },
  "budget cushion": {
    pl: "Użycie: cashu budget cushion [--target KWOTA] [--months N] [--currency KOD] [--account GID ...] [--monthly-max KWOTA] [--off]",
    en: "Usage: cashu budget cushion [--target AMOUNT] [--months N] [--currency CODE] [--account GID ...] [--monthly-max AMOUNT] [--off]",
  },
  "budget month-close": {
    pl: "Użycie: cashu budget month-close [--month YYYY-MM]",
    en: "Usage: cashu budget month-close [--month YYYY-MM]",
  },
  loans: N.loansUsage,
  "loans list": N.loanListUsage,
  "loans add": N.loanAddUsage,
  "loans set-loan": {
    pl: N.loanSetUsage.pl.replace("cashu set-loan", "cashu loans set-loan"),
    en: N.loanSetUsage.en.replace("cashu set-loan", "cashu loans set-loan"),
  },
  "loans set-payment": N.loanPaymentUsage,
  "loans set-balance": N.loanBalanceUsage,
  assets: N.assetsUsage,
  "assets add-position": {
    pl: N.positionUsage.pl.replace("cashu add-position", "cashu assets add-position"),
    en: N.positionUsage.en.replace("cashu add-position", "cashu assets add-position"),
  },
  "assets set-vehicle": {
    pl: "Użycie: cashu assets set-vehicle NAZWA CENA DATA [--rate PROCENT] [--floor KWOTA] [--currency KOD]",
    en: "Usage: cashu assets set-vehicle NAME PRICE DATE [--rate PERCENT] [--floor AMOUNT] [--currency CODE]",
  },
  "add-position": N.positionUsage,
  "set-vehicle": {
    pl: "Użycie: cashu set-vehicle NAZWA CENA DATA [--rate PROCENT] [--floor KWOTA] [--currency KOD]",
    en: "Usage: cashu set-vehicle NAME PRICE DATE [--rate PERCENT] [--floor AMOUNT] [--currency CODE]",
  },
  language: C.languageUsage,
  profiles: C.profileUsage,
  "profiles add": C.profileAddUsage,
  "profiles inspect": C.profileInspectUsage,
  accounts: C.accountsUsage,
  stats: C.statsUsage,
  "set-account-name": {
    pl: "Użycie: cashu set-account-name GID NAZWA",
    en: "Usage: cashu set-account-name GID NAME",
  },
  "set-account-type": {
    pl: "Użycie: cashu set-account-type GID TYP",
    en: "Usage: cashu set-account-type GID TYPE",
  },
  "set-balance": C.balanceUsage,
  "set-loan": N.loanSetUsage,
  "set-category": {
    pl: "Użycie: cashu set-category SPRZEDAWCA KATEGORIA",
    en: "Usage: cashu set-category MERCHANT CATEGORY",
  },
  "import-csv": {
    pl: "Użycie: cashu import-csv PLIK [--bank BANK] [--account-type TYP] [--name NAZWA]",
    en: "Usage: cashu import-csv FILE [--bank BANK] [--account-type TYPE] [--name NAME]",
  },
  "import-dir": {
    pl: "Użycie: cashu import-dir [KATALOG] [--bank BANK] [--recursive|--no-recursive]",
    en: "Usage: cashu import-dir [DIRECTORY] [--bank BANK] [--recursive|--no-recursive]",
  },
  "match-transfers": {
    pl: "Użycie: cashu match-transfers [--reset|--no-reset] [--max-days DNI]",
    en: "Usage: cashu match-transfers [--reset|--no-reset] [--max-days DAYS]",
  },
  categorize: { pl: "Użycie: cashu categorize [--llm]", en: "Usage: cashu categorize [--llm]" },
  reclassify: { pl: "Użycie: cashu reclassify", en: "Usage: cashu reclassify" },
  connectors: {
    pl: "Użycie: cashu connectors add|list|show|test|disable|remove|catalog ...",
    en: "Usage: cashu connectors add|list|show|test|disable|remove|catalog ...",
  },
  eb: {
    pl: "Użycie: cashu eb status|sessions|check|banks|resync|sync|forget|attempt-status ...",
    en: "Usage: cashu eb status|sessions|check|banks|resync|sync|forget|attempt-status ...",
  },
  worker: {
    pl: "Użycie: cashu worker run|install|uninstall|status [--json]",
    en: "Usage: cashu worker run|install|uninstall|status [--json]",
  },
  workspace: {
    pl: "Użycie: cashu --profile PROFIL workspace init|update|path ...",
    en: "Usage: cashu --profile PROFILE workspace init|update|path ...",
  },
};
