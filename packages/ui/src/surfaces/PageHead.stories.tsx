import type { Meta, Story } from "../charts/testing/csf.js";
import { PageHead, type PageHeadProps } from "./PageHead.js";

const meta = {
  title: "Surfaces/PageHead",
  component: PageHead,
  args: { title: "Investments", children: "prices Fri 30.10", actions: "Import" },
} satisfies Meta<PageHeadProps>;
export default meta;
export const Default: Story<PageHeadProps> = {};
