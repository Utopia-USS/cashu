import type { Meta, Story } from "../charts/testing/csf.js";
import { Page, type PageProps } from "./Page.js";

const meta = {
  title: "Surfaces/Page",
  component: Page,
  args: { children: "Przegląd", label: "Przegląd" },
} satisfies Meta<PageProps>;
export default meta;
export const Default: Story<PageProps> = {};
