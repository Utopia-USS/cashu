import { LoansWidgetView } from "./OverviewWidgetsView.js";
import { loans } from "./overviewStoryData.js";

export default { title: "Desktop/Overview/Loans", component: LoansWidgetView, args: { m: loans } };
export const Ready = {};
export const Empty = { args: { m: { ...loans, rows: [], empty: "No loans.", foot: null } } };
export const Privacy = {
  args: {
    m: { ...loans, rows: loans.rows.map((r) => ({ ...r, name: "•••", value: "-PLN •••" })) },
  },
};
