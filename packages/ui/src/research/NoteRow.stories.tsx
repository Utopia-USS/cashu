import type { Meta, Story } from "../charts/testing/csf.js";
import { NoteRow, type NoteRowProps } from "./NoteRow.js";

const meta = {
  title: "Research/NoteRow",
  component: NoteRow,
  args: {
    id: "note-1",
    title: "A synthetic note title",
    tip: "news · 2.11",
    relation: { tone: "sup", glyph: "+", label: "supports the thesis" },
    open: true,
    onToggle: () => {},
    summary: "A synthetic summary with +4.2% growth.",
    sources: {
      label: "sources (1)",
      items: [{ who: "Example", url: "https://example.com", date: "2.11" }],
    },
    dismiss: { label: "dismiss", onDismiss: () => {} },
  },
} satisfies Meta<NoteRowProps>;
export default meta;
export const Open: Story<NoteRowProps> = {};
export const Closed: Story<NoteRowProps> = { args: { open: false } };
export const Dismissed: Story<NoteRowProps> = {
  args: {
    open: false,
    dim: true,
    restore: { text: "dismissed 2.11", action: "restore", onRestore: () => {} },
  },
};
