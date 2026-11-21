/** The active watched list is independent of the account filter's held positions. */
import * as views from "@cashu/domain/investments/views";
import type { Read } from "../queries/shared.js";
import {
  canonicalAccountFilter,
  type PortfolioViewRequest,
  portfolioViewInputs,
} from "./portfolio.js";
export function readWatchlist(read: Read, request: PortfolioViewRequest) {
  // Account selection is validated context; Python's watched list always uses whole-profile holdings.
  const selected = canonicalAccountFilter(read, request.accounts);
  if (!selected.ok) return selected;
  const input = portfolioViewInputs(read, { ...request, accounts: null });
  return input.ok ? { ok: true as const, value: views.watchlistView(input.value) } : input;
}
