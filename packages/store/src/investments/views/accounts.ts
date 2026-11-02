/** Account metadata is live, vault-local, and ordered by canonical gid only for display. */
import { views } from "@cashu/domain/investments";
import type { Read } from "../queries/shared.js";
import { type PortfolioAtRequest, portfolioAt } from "./portfolio.js";

export function readAccounts(read: Read, request: PortfolioAtRequest) {
  const state = portfolioAt(read, request);
  return state.ok
    ? { ok: true as const, value: views.accountsView(state.value.accounts, state.value) }
    : state;
}
