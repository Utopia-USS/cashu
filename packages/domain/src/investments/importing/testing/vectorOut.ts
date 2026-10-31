import type { Decimal } from "../../../decimal.js";
import { CanonicalImporter } from "../canonical/index.js";
import type {
  ImportParseResult,
  ImportWarning,
  ParsedCorporateAction,
  ParsedPosition,
  ParsedTxn,
  TimeOfDay,
} from "../contract.js";
import type { ValidationReport } from "../validation.js";
import { reportOk, reportSummary, validateImport } from "../validation.js";

/** The shapes `parity/python/vectors_inv_importing.py` writes, produced from the TypeScript results. */
const dec = (value: Decimal | null): string | null => (value === null ? null : value.toString());

const pad = (n: number): string => String(n).padStart(2, "0");
const time = (value: TimeOfDay | null): string | null =>
  value === null ? null : `${pad(value.hour)}:${pad(value.minute)}:${pad(value.second)}`;

const warningRow = (w: ImportWarning): unknown[] => [w.message, w.row, w.blocking, w.kind];

function txnRow(t: ParsedTxn): unknown[] {
  return [
    t.rowIndex,
    t.tradeDate,
    t.type,
    t.currency,
    dec(t.grossAmount),
    dec(t.cashAmount),
    t.cashCurrency,
    t.externalRef,
    time(t.tradeTime),
    t.settleDate,
    t.symbol,
    t.isin,
    t.name,
    t.exchangeHint,
    dec(t.quantity),
    dec(t.price),
    dec(t.fee),
    dec(t.tax),
    dec(t.fxRate),
    dec(t.splitRatio),
    t.note,
    [...t.rawRow].map(([k, v]) => [k, v]),
  ];
}

const positionRow = (p: ParsedPosition): unknown[] => [
  p.asOf,
  p.currency,
  dec(p.quantity),
  p.symbol,
  p.isin,
  p.name,
  p.exchangeHint,
  dec(p.avgPrice),
  dec(p.marketValue),
];

function actionRow(a: ParsedCorporateAction): unknown[] {
  const head = [a.date, a.rowIndex, a.note];
  return a.kind === "rename"
    ? [
        "ParsedRename",
        ...head,
        a.oldSymbol,
        a.newSymbol,
        a.oldIsin,
        a.newIsin,
        a.exchangeHint,
        a.newExchangeHint,
        a.newName,
      ]
    : ["ParsedDelisting", ...head, a.symbol, a.isin, a.exchangeHint, a.frozen];
}

function resultOut(r: ImportParseResult): Record<string, unknown> {
  return {
    warnings: r.warnings.map(warningRow),
    txns: r.txns.map(txnRow),
    positions: r.positions.map(positionRow),
    actions: r.corporateActions.map(actionRow),
    account_hint: r.accountHint,
    source: r.source,
  };
}

function reportOut(report: ValidationReport): unknown {
  return {
    ok: reportOk(report),
    importer_id: report.importerId,
    errors: report.errors.map(warningRow),
    warnings: report.warnings.map(warningRow),
    summary: reportSummary(report),
  };
}

/** The generator's `canonical_out`. */
export function canonicalOut(content: Uint8Array, name: string): Record<string, unknown> {
  const importer = new CanonicalImporter();
  const file = { name, content };
  return {
    ...resultOut(importer.parse(file)),
    can_parse: importer.canParse(file),
    report: reportOut(validateImport(file)),
  };
}
