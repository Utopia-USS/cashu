import { AssetDrawerView } from "./AssetsWidgetView.js";
import assets from "./AssetsWidgetView.stories.js";
export default {
  title: "Desktop/Assets/Drawer",
  component: AssetDrawerView,
  args: { ...assets.args, state: { ...assets.args.state, open: true } },
};
export const Ready = {};
export const Privacy = { args: { ...assets.args, privacy: true } };
