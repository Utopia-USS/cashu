import assets from "../overview/AssetsWidgetView.stories.js";
import { AssetsStartView } from "./AssetsStartView.js";

const args = { ...assets.args, onOverviewOpened: () => {} };
export default { title: "Desktop/Assets/Start", component: AssetsStartView, args };
export const Ready = {};
export const Empty = {
  args: { ...args, state: { ...args.state, rows: [], displayRows: [], orderedTotals: [] } },
};
export const Privacy = { args: { ...args, privacy: true } };
