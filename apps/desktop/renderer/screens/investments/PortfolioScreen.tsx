import { useProfile } from "@cashu/store-react";
import { useUiEnv } from "@cashu/ui";
import type { PerfRange } from "@cashu/ui-logic/investments/v2/types";
import { InvestmentsHomeScreen } from "./home/InvestmentsHomeScreen.js";
import type { InvestmentsHomeOptions } from "./home/useInvestmentsHomeScreen.js";

type Props = Omit<InvestmentsHomeOptions, "slug" | "range" | "review" | "account"> & {
  /** The profile slug (the Home's first-steps command line). */
  slug?: string;
  /** The account filter gid of the route. */
  account?: string | null;
  /** The chart range of the route (`period`). */
  range?: string;
  review?: boolean;
};

const RANGES: readonly PerfRange[] = ["1m", "3m", "ytd", "1y", "3y", "max"];
const rangeOf = (range: string | undefined): PerfRange => RANGES.find((r) => r === range) ?? "1y";

/** The investments tab: the Home (ab24ab6 v2/Home.tsx: the review deck over it, `assets/{id}` = the asset drawer
 * over it, `assets/{id}?page=1` = the asset page in place of its grid). The Home stays mounted while an asset
 * opens and closes, as in the old app. */
export function PortfolioScreen(props: Props) {
  const vault = useProfile();
  const { privacy } = useUiEnv();
  return (
    <InvestmentsHomeScreen
      key={`${vault}:${privacy}`}
      {...props}
      slug={props.slug ?? ""}
      account={props.account ?? null}
      range={rangeOf(props.range)}
      review={props.review ?? false}
    />
  );
}
