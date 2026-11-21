import { AssetDrawerView } from "./AssetsWidgetView.js";
import assets from "./AssetsWidgetView.stories.js";
export default {
  title: "Desktop/Assets/Drawer",
  component: AssetDrawerView,
  args: { ...assets.args, state: { ...assets.args.state, open: true } },
};
export const Ready = {};
/** An edit opened in incognito: the money fields start empty, shown as dots. */
export const Masked = {
  args: { ...assets.args, state: { ...assets.args.state, open: true, masked: true } },
};
