import type { Meta, Story } from "../charts/testing/csf.js";
import { DetailDrawer, type DetailDrawerProps } from "./DetailDrawer.js";

const meta = {
  title: "Overlays/DetailDrawer",
  component: DetailDrawer,
  args: {
    name: "Synthetic Energy",
    crumbLabel: "Breadcrumb",
    root: "Investments",
    section: "Assets",
    onCrumb: () => {},
    onClose: () => {},
    pageLink: { label: "open as a page", onPress: () => {} },
    children: "The instrument's detail.",
  },
} satisfies Meta<DetailDrawerProps>;
export default meta;
export const Default: Story<DetailDrawerProps> = {};
