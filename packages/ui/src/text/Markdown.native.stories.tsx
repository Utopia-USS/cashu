import type { Meta, Story } from "../charts/testing/csf.js";
import { Markdown, type MarkdownProps } from "./Markdown.js";

const meta = {
  title: "Native/Markdown",
  component: Markdown,
  args: {
    blocks: [
      { t: "h", level: 1, c: ["Long-term, boring on purpose"] },
      { t: "h", level: 3, c: ["Goal"] },
      {
        t: "p",
        c: [
          "Independence from a salary by 2045. I can sit through a ",
          { t: "b", c: ["30% fall"] },
          " without selling.",
        ],
      },
      {
        t: "list",
        ordered: false,
        start: 1,
        items: [
          { task: null, blocks: [{ t: "p", c: ["Global stocks 60%"] }] },
          { task: null, blocks: [{ t: "p", c: ["Bonds 20%, cash 5%"] }] },
        ],
      },
      {
        t: "quote",
        blocks: [{ t: "p", c: [{ t: "i", c: ["A drawdown alone is not a reason to sell."] }] }],
      },
      { t: "hr" },
      {
        t: "p",
        c: [
          "Read more on ",
          { t: "a", href: "https://example.com/strategy", c: ["the example page"] },
          ".",
        ],
      },
    ],
  },
} satisfies Meta<MarkdownProps>;
export default meta;
export const Document: Story<MarkdownProps> = {};
export const TableAndCode: Story<MarkdownProps> = {
  args: {
    blocks: [
      {
        t: "table",
        align: [null, "right"],
        head: [["Bucket"], ["Target"]],
        rows: [
          [["Global stocks"], ["60%"]],
          [["Bonds"], ["20%"]],
        ],
      },
      { t: "code", lang: "yaml", v: "monthly_amount: 2500" },
      {
        t: "list",
        ordered: true,
        start: 1,
        items: [
          { task: true, blocks: [{ t: "p", c: ["Fill the cushion"] }] },
          { task: false, blocks: [{ t: "p", c: [{ t: "code", v: "rebalance" }, " once a year"] }] },
        ],
      },
    ],
  },
};
