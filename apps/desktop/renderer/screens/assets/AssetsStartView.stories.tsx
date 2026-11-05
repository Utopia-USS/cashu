import assets from "../overview/AssetsWidgetView.stories.js";
import { AssetsStartView, type AssetsStartViewProps } from "./AssetsStartView.js";

const { state } = assets.args;
const args: AssetsStartViewProps = {
  state,
  today: assets.args.today,
  baseCurrency: assets.args.baseCurrency,
  privacy: false,
  onGuide: () => {},
};
export default { title: "Desktop/Assets/Start", component: AssetsStartView, args };
export const Ready = {};
export const Empty = {
  args: {
    ...args,
    state: {
      ...state,
      rows: [],
      steps: {
        position: "on" as const,
        vehicle: "todo" as const,
        count: 0,
        totals: "",
        vehicles: [],
      },
    },
  },
};
export const Loading = { args: { ...args, state: null } };
export const Privacy = { args: { ...args, privacy: true } };
