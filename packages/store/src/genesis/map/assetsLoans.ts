// Genesis row mappers, loans and assets (S26 spec 4.3; events.md 8.4; gid.md 4.5): the 1:1 rows of
// an account, gid DET[@account].
import type { AssetDetailsRow, DepreciationRow, LoanRow } from "../rows.js";
import {
  event,
  gidOf,
  type MapContext,
  type RowEvents,
  requiredGid,
  rowEvents,
  stampsOf,
} from "./context.js";

/** `loan.termsSet`, plus `loan.paymentMatchingSet` when an IBAN or a title phrase is set. */
export function mapLoan(r: LoanRow, ctx: MapContext): RowEvents | undefined {
  const gid = gidOf(ctx, "loans", r.id);
  if (gid === undefined) return undefined;
  const account = requiredGid(ctx, "accounts", r.accountId);
  const stamps = stampsOf(r, ["createdAt", "updatedAt"]);
  const terms = {
    account,
    principal: r.principal,
    annualRate: r.annualRate,
    termMonths: r.termMonths,
    startDate: r.startDate,
    originationDate: r.originationDate,
  };
  const events = [event("loan.termsSet", gid, terms, stamps)];
  if (r.paymentIban !== null || r.paymentText !== null) {
    const matching = { account, paymentIban: r.paymentIban, paymentText: r.paymentText };
    events.push(event("loan.paymentMatchingSet", gid, matching, stamps));
  }
  return rowEvents("loans", r.id, events);
}

export function mapDepreciation(r: DepreciationRow, ctx: MapContext): RowEvents | undefined {
  const gid = gidOf(ctx, "depreciations", r.id);
  if (gid === undefined) return undefined;
  const data = {
    account: requiredGid(ctx, "accounts", r.accountId),
    purchasePrice: r.purchasePrice,
    purchaseDate: r.purchaseDate,
    annualRate: r.annualRate,
    floor: r.floor,
  };
  return rowEvents("depreciations", r.id, [
    event("depreciation.set", gid, data, stampsOf(r, ["createdAt"])),
  ]);
}

export function mapAssetDetails(r: AssetDetailsRow, ctx: MapContext): RowEvents | undefined {
  const gid = gidOf(ctx, "asset_details", r.id);
  if (gid === undefined) return undefined;
  const data = { account: requiredGid(ctx, "accounts", r.accountId), note: r.note };
  return rowEvents("asset_details", r.id, [
    event("assetDetails.noteSet", gid, data, stampsOf(r, ["createdAt", "updatedAt"])),
  ]);
}
