import type { ReactNode } from "react";
import { Skeleton } from "../feedback/Skeleton.js";
import { Grid } from "../grid/Grid.js";
import { type SetupStepItem, SetupSteps } from "../lists/SetupSteps.js";
import { PageHead } from "./PageHead.js";
import { Widget } from "./Widget.js";

export interface ModuleStartProps {
  /** The page head (`Budżet domowy`, `Kredyty`, `Majątek`). */
  title: ReactNode;
  /** The steps tag after the title (`2/3 kroków`, `gotowy`). */
  tag?: ReactNode;
  /** The steps widget's title (`Pierwsze kroki`). */
  stepsTitle: string;
  /** null while loading: three skeleton rows. */
  steps: readonly SetupStepItem[] | null;
  /** The steps widget's footer (the Claude Code / CLI guide link). */
  footer?: ReactNode;
  /** The narrow widget next to the steps (the Agent AI widget). */
  aside?: ReactNode;
  /** Drawers of the page. */
  children?: ReactNode;
}

/** A module's in-app first steps (old core/StartPage.tsx): page head with the steps tag, then the steps widget
 * (two columns) next to the aside widget (one column) in the dashboard grid. */
export function ModuleStart(props: ModuleStartProps) {
  return (
    <>
      <PageHead title={props.title}>{props.tag}</PageHead>
      <Grid
        items={[
          {
            id: "start",
            span: 2,
            node: (
              <Widget title={props.stepsTitle} tight footer={props.footer}>
                {props.steps ? (
                  <SetupSteps steps={props.steps} />
                ) : (
                  <div className="grid gap-3.5 py-3">
                    <Skeleton height={36} />
                    <Skeleton height={36} />
                    <Skeleton height={36} />
                  </div>
                )}
              </Widget>
            ),
          },
          ...(props.aside != null ? [{ id: "agent", span: 1 as const, node: props.aside }] : []),
        ]}
      />
      {props.children}
    </>
  );
}
