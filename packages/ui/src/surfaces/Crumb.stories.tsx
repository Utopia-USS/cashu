import type { Meta, Story } from "../charts/testing/csf.js";
import { Crumb, type CrumbProps } from "./Crumb.js";

const meta = {
  title: "Surfaces/Crumb",
  component: Crumb,
  args: {
    label: "Breadcrumb",
    items: [
      { label: "Investments", onPress: () => {} },
      { label: "Assets", onPress: () => {} },
      { label: "Synthetic Energy" },
    ],
    end: "open in the panel",
  },
} satisfies Meta<CrumbProps>;
export default meta;
export const Default: Story<CrumbProps> = {};
