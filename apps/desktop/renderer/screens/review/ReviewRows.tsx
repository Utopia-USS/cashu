import { VirtualList } from "@cashu/ui";
import type { ReactNode } from "react";

export function Rows<T>({
  rows,
  rowKey,
  children,
  label,
}: {
  rows: readonly T[];
  rowKey(row: T): string;
  children(row: T): ReactNode;
  label: string;
}) {
  return (
    <VirtualList
      items={rows}
      getKey={rowKey}
      renderItem={(row) => children(row)}
      label={label}
      estimateSize={80}
      rowClassName="border-b border-border py-3"
    />
  );
}
