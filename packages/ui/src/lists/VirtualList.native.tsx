import { FlashList } from "@shopify/flash-list";
import type { VirtualListProps } from "./VirtualList.types.js";

/** Recycled native list for unbounded collections. */
export function VirtualList<T>({ items, getKey, renderItem, label }: VirtualListProps<T>) {
  return (
    <FlashList
      data={items}
      keyExtractor={getKey}
      renderItem={({ item, index }) => <>{renderItem(item, index)}</>}
      accessibilityLabel={label}
    />
  );
}
