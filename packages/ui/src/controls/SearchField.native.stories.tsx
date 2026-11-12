import type { Meta, Story } from "../charts/testing/csf.js";
import { SearchField, type SearchFieldProps } from "./SearchField.js";

const meta = {
  title: "Native/SearchField",
  component: SearchField,
  args: {
    value: "",
    placeholder: "Search payments",
    onChange: () => {},
    onClear: () => {},
    clearLabel: "Clear search",
  },
} satisfies Meta<SearchFieldProps>;
export default meta;
export const Empty: Story<SearchFieldProps> = {};
export const WithQuery: Story<SearchFieldProps> = { args: { value: "insurance" } };
