// The investments Home page (ab24ab6 v2/Home.tsx; the full grid laid out as design V5): the full grid leads with the
// statement hero (no page-title row: the head's filter and status tags sit on the hero's label line, Add
// transaction and the review on its right), then one split cell with the widgets in the main column and the rail,
// the research strip last. The light grid and the empty portfolio's first steps keep the page head. Also the loading
// skeleton and the error line. Pure: models come from homeModel.ts, the widget / rail / research / review nodes from
// the screen.
import { S } from "@cashu/i18n/investments/v2/Home.strings";
import {
  AgentWidget,
  Button,
  CodeLine,
  type FactProps,
  Grid,
  type GridItem,
  Hero,
  PageHead,
  Seg,
  SetupSteps,
  Skeleton,
  Split,
  type SplitItem,
  Tag,
  Widget,
} from "@cashu/ui";
import type { ReactNode } from "react";
import type { HeadModel, HeroFact, HeroModel, HeroValueParts, StartModel } from "./homeModel.js";

/** Inline code (old global `code { font: 0.92em ui-monospace }`, no ligatures). */
const code = "font-mono text-code-ui [font-variant-ligatures:none]";

/** The old `.wrap.wide` page box (max 1440px, 20px sides, 70px bottom, centred; the shell above it carries the 24px top) with the old body type (15px / 1.5); `narrow` = the old `.wrap.narrow` (1120px, the asset page). */
export function HomePage({ children, narrow = false }: { children: ReactNode; narrow?: boolean }) {
  return (
    <main
      data-testid="native-portfolio"
      className={`mx-auto px-5 pb-17.5 text-base leading-normal text-fg ${narrow ? "max-w-280" : "max-w-360"}`}
    >
      {children}
    </main>
  );
}

/** First load (Home.tsx:373-380): the head with two placeholders and three placeholder widgets. */
export function HomeLoadingView() {
  return (
    <>
      <PageHead title={S.investments} actions={<Skeleton width={260} height={26} />}>
        <Skeleton width={320} height={26} />
      </PageHead>
      <Grid
        items={[
          { id: "hero", span: 3, node: <Skeleton height={92} radius="widget" /> },
          { id: "value", span: 2, node: <Skeleton height={260} radius="widget" /> },
          { id: "alloc", span: 1, node: <Skeleton height={260} radius="widget" /> },
        ]}
      />
    </>
  );
}

/** The overview or positions failed before anything loaded (old `.err`). */
export function HomeErrorView({ message }: { message: string }) {
  return (
    <div className="mb-4 rounded-control bg-negative px-3.5 py-2.5 text-on-accent">
      {S.error(message)}
    </div>
  );
}

interface HomeHeadProps {
  head: HeadModel;
  onAccount(id: number | null): void;
  onStale(): void;
  onAddTxn(): void;
}

function HomeHead({ head, onAccount, onStale, onAddTxn }: HomeHeadProps) {
  return (
    <PageHead
      title={S.investments}
      actions={head.addTxn && <Button onPress={onAddTxn}>{S.addTxn}</Button>}
    >
      <HeadTags head={head} onAccount={onAccount} onStale={onStale} />
    </PageHead>
  );
}

/** The head's account filter and status tags (the page head's items, or the statement hero's label line). */
function HeadTags({ head, onAccount, onStale }: Omit<HomeHeadProps, "onAddTxn">) {
  return (
    <>
      {head.accounts && (
        <Seg<number | null>
          quiet
          label={S.account}
          items={head.accounts.items}
          value={head.accounts.value}
          onChange={onAccount}
        />
      )}
      {head.prices && <Tag title={head.prices.title}>{head.prices.text}</Tag>}
      {head.stale && (
        <Tag tone="warning" title={head.stale.title} onPress={onStale}>
          {head.stale.text}
        </Tag>
      )}
      {head.rules && (
        <Tag tone={head.rules.warn ? "warning" : "neutral"} title={head.rules.title}>
          {head.rules.text}
        </Tag>
      )}
    </>
  );
}

/** The statement figure: the currency small and muted, the decimals dimmed (the text stays the formatted value). */
function StatementValue({ value, parts }: { value: string; parts: HeroValueParts | null }) {
  if (!parts) return value;
  const currency = "text-4xl font-strong tracking-heading text-fg-muted";
  return (
    <>
      {parts.pre && <span className={`${currency} align-top`}>{parts.pre}</span>}
      {parts.main}
      {parts.fraction && <span className="text-fg-muted">{parts.fraction}</span>}
      {parts.post && <span className={currency}>{parts.post}</span>}
    </>
  );
}

/** The full grid's hero (design V5): label line with the head's tags, the figure, the week; actions right. */
function StatementCell({
  hero,
  reviewSlot,
  head,
  onAccount,
  onStale,
  onAddTxn,
}: HomeHeadProps & { hero: HeroModel; reviewSlot: ReactNode }) {
  return (
    <Hero
      variant="statement"
      label={S.portfolioValue}
      caption={S.portfolioValue}
      value={<StatementValue value={hero.value} parts={hero.valueParts} />}
      facts={[]}
      meta={<HeadTags head={head} onAccount={onAccount} onStale={onStale} />}
      delta={
        hero.week ? (
          <>
            <span className={tones[hero.week.tone]}>{hero.week.text}</span>
            {S.thisWeek}
          </>
        ) : undefined
      }
      // The secondary action (design V5's place of Import, which investments do not have: the agent imports) and
      // the review as the page's one primary button.
      right={
        <>
          <Button size="lg" className="h-10" onPress={onAddTxn}>
            {S.addTxn}
          </Button>
          {reviewSlot}
        </>
      }
    />
  );
}

const tones = { positive: "text-positive", negative: "text-negative" } as const;

function factProps(fact: HeroFact): FactProps {
  const bench = fact.bench;
  return {
    label: fact.label,
    value: fact.value,
    ...(fact.title ? { title: fact.title } : {}),
    detail: bench ? (
      <>
        {bench.lead}
        {bench.pp && (
          <>
            {" · "}
            <span className={tones[bench.pp.tone]}>{bench.pp.text}</span>
          </>
        )}
      </>
    ) : (
      fact.detail
    ),
  };
}

export interface HomeViewProps extends HomeHeadProps {
  content:
    | {
        kind: "home";
        /** The statement hero (its facts go to the value chart's KPI strip, not here). */
        hero: HeroModel;
        /** The hero's review slot (review/deck ReviewSlotView), null without a digest. */
        reviewSlot: ReactNode;
        main: SplitItem[];
        rail: SplitItem[];
        /** The research strip (last grid cell), null before the first run. */
        research: ReactNode;
      }
    | {
        /** The light grid of a zero-start profile (Home.tsx:537-540): hero, Wpłaty, Rachunki, Obserwowane. */
        kind: "light";
        hero: HeroModel;
        reviewSlot: ReactNode;
        contributions: ReactNode;
        accounts: ReactNode;
        /** Only with watched instruments or on the watch route. */
        watch: ReactNode;
      }
    | { kind: "start"; start: StartModel; onCopy(): void; onSettings(): void };
  /** Layers over the page: the review deck, the signals dialog, the Import drawer. */
  overlays?: ReactNode;
}

export function HomeView({ content, overlays, ...head }: HomeViewProps) {
  return (
    <>
      {content.kind === "home" ? (
        <>
          <StatementCell {...head} hero={content.hero} reviewSlot={content.reviewSlot} />
          <HomeGrid {...content} />
        </>
      ) : (
        <>
          <HomeHead {...head} />
          {content.kind === "light" ? <LightGrid {...content} /> : <StartView {...content} />}
        </>
      )}
      {overlays}
    </>
  );
}

function HeroCell({ hero, reviewSlot }: { hero: HeroModel; reviewSlot: ReactNode }) {
  return (
    <Hero
      label={S.portfolioValue}
      caption={S.portfolioValue}
      value={hero.value}
      delta={
        hero.week ? (
          <>
            <span className={tones[hero.week.tone]}>{hero.week.text}</span>
            {S.thisWeek}
          </>
        ) : undefined
      }
      facts={hero.facts.map(factProps)}
    >
      {reviewSlot}
    </Hero>
  );
}

function LightGrid({
  hero,
  reviewSlot,
  contributions,
  accounts,
  watch,
}: Extract<HomeViewProps["content"], { kind: "light" }>) {
  const items: GridItem[] = [
    { id: "hero", span: 3, node: <HeroCell hero={hero} reviewSlot={reviewSlot} /> },
    { id: "contrib", span: 2, node: contributions },
    { id: "accounts", span: 1, node: accounts },
  ];
  if (watch != null) items.push({ id: "watch", span: 1, node: watch });
  return <Grid items={items} />;
}

function HomeGrid({ main, rail, research }: Extract<HomeViewProps["content"], { kind: "home" }>) {
  const items: GridItem[] = [{ id: "split", span: 3, node: <Split main={main} rail={rail} /> }];
  if (research != null) items.push({ id: "research", span: 3, node: research });
  return <Grid items={items} />;
}

/** First steps of an empty portfolio (strategy first, purchases later) next to the Agent AI widget. */
function StartView({
  start,
  onCopy,
  onSettings,
}: Extract<HomeViewProps["content"], { kind: "start" }>) {
  return (
    <Grid
      items={[
        {
          id: "start",
          span: 2,
          node: (
            <Widget title={S.firstSteps} tight>
              <SetupSteps
                steps={start.steps.map((step) => ({
                  key: step.key,
                  status: step.status,
                  title: step.title,
                  hint: step.strategyHint ? (
                    <>
                      <code className={code}>strategy.yaml</code>
                      {S.orInterview}
                      <code className={code}>/investments-setup</code>
                    </>
                  ) : (
                    step.hint
                  ),
                  tag: step.tag ? <Tag tone={step.tag.tone}>{step.tag.text}</Tag> : undefined,
                  actions: step.actions.length ? (
                    <>
                      {step.actions.map((action) => (
                        <Button
                          key={action.label}
                          variant={action.primary ? "primary" : "secondary"}
                          disabled={action.disabled}
                          onPress={action.onPress}
                        >
                          {action.label}
                        </Button>
                      ))}
                    </>
                  ) : undefined,
                }))}
              />
              {start.command && <CodeLine command={start.command} onCopy={onCopy} />}
            </Widget>
          ),
        },
        {
          id: "privacy",
          span: 1,
          node: <AgentWidget privacy={"strict"} onSettings={onSettings} />,
        },
      ]}
    />
  );
}
