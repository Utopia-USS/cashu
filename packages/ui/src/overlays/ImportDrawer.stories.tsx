import type { Meta, Story } from "../charts/testing/csf.js";
import { ImportDrawer, type ImportDrawerProps } from "./ImportDrawer.js";

const meta = {
  title: "Overlays/ImportDrawer",
  component: ImportDrawer,
  args: {
    title: "Statement import",
    tag: "Synthetic bank",
    steps: ["Source", "File", "Preview", "Done"],
    step: 1,
    footer: null,
    onClose: () => {},
    children: "Fields",
  },
} satisfies Meta<ImportDrawerProps>;
export default meta;
export const Default: Story<ImportDrawerProps> = {};
