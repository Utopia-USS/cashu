/** Native per-call historical inputs, with one coherent strategy and device-cache authority. */
import type { CalendarDate, performance, views } from "@cashu/domain/investments";
export interface InvestmentHistoryReads {
  portfolio(asOf: CalendarDate): views.PortfolioViewState;
  performance(): performance.HistoryMetrics | null;
}
