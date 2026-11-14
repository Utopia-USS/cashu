import type { Meta, Story } from "../charts/testing/csf.js";
import { AppHeader, type AppHeaderProps } from "./AppHeader.js";

const meta = {
  title: "Shell/AppHeader",
  component: AppHeader,
  args: { logo: { light: "", dark: "", label: "cashU" }, brand: "Profile", actions: "Actions" },
} satisfies Meta<AppHeaderProps>;
export default meta;
export const Default: Story<AppHeaderProps> = {};
