// TRANSITIONAL(S49): the sync bridge exists only while the Python app writes (S31a spec 2.1).
//
// Bridges of the loans and assets tables (S31a spec 4.4; events.md 8.4): the 1:1 rows of an account,
// gid DET[@account]. Inserts are the genesis snapshot (`mapLoan`, `mapDepreciation`,
// `mapAssetDetails`); updates take every payload field from the genesis snapshot of `post`:
// - loans: a term column -> `loan.termsSet` (whole value); `payment_iban` / `payment_text` ->
//   `loan.paymentMatchingSet` (whole value; `updated_at` is derived from the latest terms);
// - depreciations: any curve column -> `depreciation.set` (whole value);
// - asset details: `note` -> `assetDetails.noteSet` (`updated_at` is derived).
// The account (the DET part) and created_at never change; Python deletes none of these rows.

import { mapAssetDetails, mapDepreciation, mapLoan } from "../../genesis/map/assetsLoans.js";
import type { EventDraft, MapContext } from "../../genesis/map/context.js";
import type { AssetDetailsRow, DepreciationRow, LoanRow } from "../../genesis/rows.js";
import { need, onRow, refuseChanged } from "./core.js";
import {
  anyChanged,
  carried,
  derived,
  eventsOf,
  pick,
  type RowChange,
  type TableBridge,
} from "./types.js";

const FIXED = ["id", "account_id", "created_at"];

// ----------------------------------------------------------------------------------------------- //
// Loans

const LOAN_TERMS = ["principal", "annual_rate", "term_months", "start_date", "origination_date"];
const LOAN_MATCHING = ["payment_iban", "payment_text"];

function loanUpdate(c: RowChange<LoanRow>, ctx: MapContext): readonly EventDraft[] {
  refuseChanged(c, "loans", FIXED);
  const post = need("loans", c.post);
  const snap = eventsOf(
    "loans",
    ctx.attempt(() => mapLoan(post, ctx)),
  );
  const terms = pick("loans", snap, "loan.termsSet");
  const out: EventDraft[] = [];
  if (anyChanged(c, ...LOAN_TERMS)) out.push(terms);
  if (anyChanged(c, ...LOAN_MATCHING)) {
    // Genesis emits the matching only while one of its values is set; clearing both (an empty
    // string in Python) is the same event with both values null, on the snapshot's account.
    const matching =
      snap.find((e) => e.type === "loan.paymentMatchingSet") ??
      derived(terms, "loan.paymentMatchingSet", {
        account: terms.data.account,
        paymentIban: post.paymentIban,
        paymentText: post.paymentText,
      });
    out.push(matching);
  }
  return onRow(c.gid, out);
}

const loans: TableBridge<LoanRow> = {
  table: "loans",
  gid: "det",
  columns: {
    ...carried(["loan.termsSet"], ...FIXED, ...LOAN_TERMS),
    ...carried(["loan.termsSet", "loan.paymentMatchingSet"], ...LOAN_MATCHING),
  },
  insert: (c, ctx) =>
    eventsOf(
      "loans",
      ctx.attempt(() => mapLoan(need("loans", c.post), ctx)),
    ),
  update: loanUpdate,
};

// ----------------------------------------------------------------------------------------------- //
// Depreciations

const CURVE = ["purchase_price", "purchase_date", "annual_rate", "floor"];

function depreciationSnapshot(row: DepreciationRow | undefined, ctx: MapContext) {
  const post = need("depreciations", row);
  return eventsOf(
    "depreciations",
    ctx.attempt(() => mapDepreciation(post, ctx)),
  );
}

const depreciations: TableBridge<DepreciationRow> = {
  table: "depreciations",
  gid: "det",
  columns: { ...carried(["depreciation.set"], ...FIXED, ...CURVE) },
  insert: (c, ctx) => depreciationSnapshot(c.post, ctx),
  update: (c, ctx) => {
    refuseChanged(c, "depreciations", FIXED);
    return anyChanged(c, ...CURVE) ? onRow(c.gid, depreciationSnapshot(c.post, ctx)) : [];
  },
};

// ----------------------------------------------------------------------------------------------- //
// Asset details

function detailsSnapshot(row: AssetDetailsRow | undefined, ctx: MapContext) {
  const post = need("asset_details", row);
  return eventsOf(
    "asset_details",
    ctx.attempt(() => mapAssetDetails(post, ctx)),
  );
}

const assetDetails: TableBridge<AssetDetailsRow> = {
  table: "asset_details",
  gid: "det",
  columns: {
    ...carried(["assetDetails.noteSet"], ...FIXED, "note"),
  },
  insert: (c, ctx) => detailsSnapshot(c.post, ctx),
  update: (c, ctx) => {
    refuseChanged(c, "asset_details", FIXED);
    return c.changed.has("note") ? onRow(c.gid, detailsSnapshot(c.post, ctx)) : [];
  },
};

export const assetsLoansBridges: readonly TableBridge[] = [loans, depreciations, assetDetails];
