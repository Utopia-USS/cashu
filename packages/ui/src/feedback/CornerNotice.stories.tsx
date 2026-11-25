import type { Meta, Story } from "../charts/testing/csf.js";
import { CornerNotice, type CornerNoticeProps } from "./CornerNotice.js";

const meta = {
  title: "Feedback/CornerNotice",
  component: CornerNotice,
  args: { title: "Nowa wersja 1.2.0", sub: "Masz 1.1.0", onClose() {} },
} satisfies Meta<CornerNoticeProps>;
export default meta;
export const Default: Story<CornerNoticeProps> = {};
