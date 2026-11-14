import type { Meta, Story } from "../charts/testing/csf.js";
import { Banner, type BannerProps } from "./Banner.js";

const meta = {
  title: "Native/Banner",
  component: Banner,
  args: {
    tone: "warning",
    icon: "bell",
    title: "Bank access expires in 3 days",
    body: "Renew it on your Mac to keep transactions coming in.",
  },
} satisfies Meta<BannerProps>;
export default meta;
export const Warning: Story<BannerProps> = {};
export const Info: Story<BannerProps> = {
  args: {
    tone: "info",
    icon: "shield",
    title: "Your data stays on your devices",
    body: "The phone reads a copy synced from your Mac.",
  },
};
