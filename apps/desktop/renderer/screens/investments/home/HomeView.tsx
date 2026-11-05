// The investments Home page (ab24ab6 v2/Home.tsx): the page head, then the grid on thirds (hero; one split cell
// with the widgets in the main column and the rail; the research strip last), the empty portfolio's first steps,
// the loading skeleton and the error line. Pure: models come from homeModel.ts, the widget / rail / research /
// review nodes from the screen.
import { S as A } from "@cashu/i18n/core/chrome.strings";
import { S as P } from "@cashu/i18n/core/SetupPage.strings";
import { S } from "@cashu/i18n/investments/v2/Home.strings";
import {
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
import type { HeadModel, HeroFact, HeroModel, StartModel } from "./homeModel.js";

/** The old `.wrap.wide` page box (max 1440px, 20px sides, 70px bottom, centred; the shell above it carries the 24px top) with the old body type (15px / 1.5). */
export function HomePage({ children }: { children: ReactNode }) {
  return (
    <main
      data-testid="native-portfolio"
      className="mx-auto max-w-360 px-5 pb-17.5 text-base leading-normal text-fg"
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
  onImport(): void;
  onAddTxn(): void;
}

function HomeHead({ head, onAccount, onStale, onImport, onAddTxn }: HomeHeadProps) {
  return (
    <PageHead
      title={S.investments}
      actions={
        <>
          <Button onPress={onImport}>{S.import}</Button>
          {head.addTxn && <Button onPress={onAddTxn}>{S.addTxn}</Button>}
        </>
      }
    >
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
    </PageHead>
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
        hero: HeroModel;
        /** The hero's review slot (review/deck ReviewSlotView), null without a digest. */
        reviewSlot: ReactNode;
        main: SplitItem[];
        rail: SplitItem[];
        /** The research strip (last grid cell), null before the first run. */
        research: ReactNode;
      }
    | { kind: "start"; start: StartModel; onCopy(): void; onSettings(): void };
  /** Layers over the page: the review deck, the signals dialog, the Import drawer. */
  overlays?: ReactNode;
}

export function HomeView({ content, overlays, ...head }: HomeViewProps) {
  return (
    <>
      <HomeHead {...head} />
      {content.kind === "home" ? <HomeGrid {...content} /> : <StartView {...content} />}
      {overlays}
    </>
  );
}

function HomeGrid({
  hero,
  reviewSlot,
  main,
  rail,
  research,
}: Extract<HomeViewProps["content"], { kind: "home" }>) {
  const items: GridItem[] = [
    {
      id: "hero",
      span: 3,
      node: (
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
      ),
    },
    { id: "split", span: 3, node: <Split main={main} rail={rail} /> },
  ];
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
                      <code>strategy.yaml</code>
                      {S.orInterview}
                      <code>/investments-setup</code>
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
          node: (
            <Widget
              title={A.agent}
              tight
              footer={
                <Button variant="link" size="md" onPress={onSettings}>
                  {A.settings}
                </Button>
              }
            >
              <div className="text-sm">
                <b>{P.strictBold}</b>
                {P.strictText}
              </div>
            </Widget>
          ),
        },
      ]}
    />
  );
}
