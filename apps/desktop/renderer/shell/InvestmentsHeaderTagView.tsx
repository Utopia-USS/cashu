// The stale-prices tag in the shell header (old `button.tag.warn.hdr-tag`: transparent, 11px / 1.5, warn fill on
// hover). Pure.
import { Tag } from "@cashu/ui";
import type { InvestmentsHeaderTagState } from "./useInvestmentsHeaderTag.js";

export function InvestmentsHeaderTagView({ state }: { state: InvestmentsHeaderTagState }) {
  if (!state.tag) return null;
  return (
    <Tag
      tone="warning"
      title={state.tag.title}
      onPress={state.onOpen}
      className="hover:bg-warning-bg"
    >
      {state.tag.text}
    </Tag>
  );
}
