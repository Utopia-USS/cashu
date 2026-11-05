// Przegląd (ab24ab6 core/Overview.tsx): the hero strip (net worth and the facts that matter), then the widget
// grid on thirds; the widget nodes come from the screen in the old order. Pure.
import { S as O } from "@cashu/i18n/core/Overview.strings";
import { Button, Empty, Grid, type GridItem, Hero, Tag, Widget } from "@cashu/ui";
import { RichText } from "./OverviewWidgetsView.js";
import type { HeroModel, Link } from "./overviewModel.js";

export interface OverviewViewProps {
  hero: HeroModel;
  /** The widget cells after the hero, already in the old slot order. */
  slots: readonly GridItem[];
  /** No module enabled: the `Moduły` card with the settings link. */
  noModules: Link | null;
  flash?: string | null;
}

export function OverviewView({ hero, slots, noModules, flash = null }: OverviewViewProps) {
  const items: GridItem[] = [{ id: "hero", span: 3, node: <NetHeroView m={hero} /> }];
  if (noModules)
    items.push({
      id: "nomods",
      span: 3,
      node: (
        <Widget title={O.modules}>
          <Empty
            inWidget
            title={O.noModules}
            action={<Button onPress={noModules.onPress}>{noModules.label}</Button>}
          />
        </Widget>
      ),
    });
  items.push(...slots);
  return <Grid items={items} flash={flash} />;
}

/** The hero (old NetHero `.w.hero`): figure with the change since last month, facts, other currencies. */
function NetHeroView({ m }: { m: HeroModel }) {
  return (
    <Hero
      label={m.label}
      caption={m.caption}
      value={<span data-testid="net-worth">{m.value}</span>}
      delta={m.delta ? <RichText runs={m.delta} /> : undefined}
      facts={m.facts.map((f) => ({
        ...f,
        detail:
          typeof f.detail === "object" && f.detail !== null ? (
            <RichText runs={f.detail} />
          ) : (
            f.detail
          ),
      }))}
      right={m.other ? <Tag>{m.other}</Tag> : undefined}
      meta={m.meta ?? undefined}
    />
  );
}
