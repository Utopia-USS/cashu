import type { Meta, Story } from "../charts/testing/csf.js";
import { FieldNote, type FieldNoteProps } from "./FieldNote.js";

const meta = {
  title: "Controls/FieldNote",
  component: FieldNote,
  args: { children: "Wystarczy fragment tytułu albo nazwy odbiorcy." },
} satisfies Meta<FieldNoteProps>;
export default meta;
export const Hint: Story<FieldNoteProps> = {};
export const ErrorNote: Story<FieldNoteProps> = {
  args: { tone: "negative", children: "Podaj nazwę." },
};
