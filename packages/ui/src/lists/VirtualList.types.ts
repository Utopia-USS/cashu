import type { ReactNode } from "react";

export interface VirtualListProps<T> {
  items: readonly T[];
  getKey(item: T): string;
  renderItem(item: T, index: number): ReactNode;
  label: string;
  estimateSize: number;
  className?: string;
  rowClassName?: string;
}
