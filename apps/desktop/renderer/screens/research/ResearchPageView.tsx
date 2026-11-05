// The research page (ab24ab6 v2/research/Page.tsx ResearchPage): the crumb, the page head with `Uruchom teraz`,
// then the story (summary sentence and tabs) and the selected tab's widgets, or the never-ran state. Pure: the
// texts come from researchPageModel.ts, the state from the screen hook.
import { S } from "@cashu/i18n/investments/v2/research/Page.strings";
import { Crumb, Grid, type GridItem, PageHead, Widget } from "@cashu/ui";
import type { ResearchPageModel, ResearchPageUi } from "./researchPageModel.js";
import {
  CalendarTab,
  CandidatesTab,
  Copy,
  EmptyResearch,
  MineTab,
  NotesTab,
  RunsTab,
  ScopeWidget,
  StoryHead,
  TopicsTab,
} from "./researchPageParts.js";

type HeadUi = Pick<ResearchPageUi, "onBack">;

function Head({ ui, runNow }: { ui: HeadUi; runNow: ResearchPageModel["runNow"] }) {
  return (
    <>
      <Crumb
        label={S.crumb}
        items={[{ label: S.investments, onPress: ui.onBack }, { label: S.research }]}
      />
      <PageHead title={S.research} actions={runNow ? <Copy c={runNow} /> : undefined} />
    </>
  );
}

/** Privacy mode: one card with the hidden line instead of the story and the tabs. */
function Hidden({ text }: { text: string }) {
  return (
    <Widget title={S.research} tight>
      <div className="text-sm text-fg-muted">{text}</div>
    </Widget>
  );
}

export function ResearchPageView({
  model,
  ui,
}: {
  model: ResearchPageModel;
  ui: Pick<ResearchPageUi, "onBack" | "onTab" | "onSettings" | "onHow">;
}) {
  const b = model.body;
  const items: GridItem[] =
    b.kind === "hidden"
      ? [{ id: "hidden", span: 3, node: <Hidden text={b.text} /> }]
      : b.kind === "empty"
        ? [
            {
              id: "empty",
              span: 3,
              node: <EmptyResearch m={b.empty} onSettings={ui.onSettings} onHow={ui.onHow} />,
            },
          ]
        : [
            { id: "story", span: 3, node: <StoryHead m={b.head} onTab={ui.onTab} /> },
            ...tabItems(b.tab),
          ];
  return (
    <div data-testid="native-research">
      <Head ui={ui} runNow={model.runNow} />
      <Grid items={items} />
    </div>
  );
}

function tabItems(t: Extract<ResearchPageModel["body"], { kind: "story" }>["tab"]): GridItem[] {
  switch (t.kind) {
    case "topics":
      return [{ id: "st-topics", span: 3, node: <TopicsTab m={t} /> }];
    case "mine":
      return [{ id: "st-mine", span: 3, node: <MineTab m={t} /> }];
    case "notes":
      return [{ id: "notes", span: 3, node: <NotesTab m={t} /> }];
    case "calendar":
      return [{ id: "st-cal", span: 3, node: <CalendarTab m={t} /> }];
    case "candidates":
      return [{ id: "cands", span: 3, node: <CandidatesTab m={t} /> }];
    case "runs":
      return [
        { id: "runs", span: 3, node: <RunsTab m={t} /> },
        { id: "scope", span: 3, node: <ScopeWidget s={t.scope} /> },
      ];
  }
}
