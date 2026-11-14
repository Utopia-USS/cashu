// The world card: the portfolio's week against the market, the change in money (hidden in incognito),
// the distance from the 12-month high and the portfolio's typical weekly move.
import { Delta, Facts, type FactsItem, Percent } from "@cashu/ui/native";
import { S } from "../Review.strings";
import type { WorldCard as WorldModel } from "../useReviewDeck";

export function WorldCard({ body }: { body: WorldModel }) {
  const items: FactsItem[] = [
    {
      label: S.yourPortfolio,
      value: <Delta kind="percent" value={body.move} size="title" weight="strong" />,
      ...(body.change === null
        ? {}
        : { detail: <Delta kind="money" value={body.change} size="caption" fractionDigits={0} /> }),
    },
    {
      label: S.theMarket,
      value: <Delta kind="percent" value={body.benchmark} size="title" weight="strong" />,
    },
  ];
  if (body.drawdown !== null)
    items.push({
      label: S.fromHigh,
      value: <Percent value={body.drawdown} size="title" weight="strong" />,
      ...(body.maxDrawdown === null
        ? {}
        : {
            detail: <Percent value={body.maxDrawdown} size="caption" tone="muted" />,
          }),
    });
  if (body.sigma !== null)
    items.push({
      label: S.typicalWeek,
      value: <Percent value={body.sigma} size="title" weight="strong" />,
    });
  return <Facts items={items} />;
}
