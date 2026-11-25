import type { Meta, Story } from "../charts/testing/csf.js";
import { VirtualList } from "./VirtualList.js";
import type { VirtualListProps } from "./VirtualList.types.js";

type Row = { id: string; label: string };
const meta = {
  title: "Lists/VirtualList",
  component: VirtualList,
  args: {
    items: Array.from({ length: 200 }, (_, index) => ({
      id: String(index),
      label: `Row ${index + 1}`,
    })),
    getKey: (row: Row) => row.id,
    renderItem: (row: Row) => <p>{row.label}</p>,
    label: "Rows",
    estimateSize: 48,
  },
} satisfies Meta<VirtualListProps<Row>>;
export default meta;
export const Long: Story<VirtualListProps<Row>> = {};
export const Empty: Story<VirtualListProps<Row>> = { args: { items: [] } };
