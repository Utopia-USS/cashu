import type { Meta, Story } from "../charts/testing/csf.js";
import { Notice, type NoticeProps } from "./Notice.js";

const meta = {
  title: "Surfaces/Notice",
  component: Notice,
  args: { children: "Prices were last updated on Friday." },
} satisfies Meta<NoticeProps>;
export default meta;
export const Neutral: Story<NoticeProps> = {};
export const Warning: Story<NoticeProps> = { args: { tone: "warning" } };
