import type { Meta, Story } from "../charts/testing/csf.js";
import { Drawer, type DrawerProps } from "./Drawer.js";

const meta = {
  title: "Overlays/Drawer",
  component: Drawer,
  args: {
    title: "Import",
    label: "Import",
    onClose: () => {},
    children: "Pick a file exported by the broker.",
    footer: "Next",
    width: 600,
  },
} satisfies Meta<DrawerProps>;
export default meta;
export const Default: Story<DrawerProps> = {};
