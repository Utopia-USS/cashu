import { S as U } from "@cashu/i18n/core/ui.strings";
import type { ReactNode } from "react";
import { Tag } from "../surfaces/Tag.js";
import { stepDisc as disc } from "./stepDisc.js";

/** A text node as a constant: the DOM-only markup keeps the old space (raw JSX text is for <Text>). */
const SP = " ";

type StepStatus = "done" | "on" | "todo";
export interface SetupStepItem {
  key: string;
  title: ReactNode;
  hint?: ReactNode;
  status: StepStatus;
  tag?: ReactNode;
  actions?: ReactNode;
  /** Extra content under the title (old `s.body`, e.g. an expanded how-to), before the hint. */
  body?: ReactNode;
  /** Never counts toward the module state: `opcjonalnie` after the title until done (unless `tag` is given). */
  optional?: boolean;
}

/** Vertical step list with live status (old `.setup-steps`). */
export interface SetupStepsProps {
  steps: readonly SetupStepItem[];
}

export function SetupSteps({ steps }: SetupStepsProps) {
  return (
    <div>
      {steps.map((step, index) => (
        <div
          key={step.key}
          className="grid items-start gap-3 border-b border-border py-3 last:border-b-0 last:pb-1"
          style={{ gridTemplateColumns: "28px minmax(0, 1fr) auto" }}
        >
          <span>
            <b
              aria-hidden="true"
              className={`mt-px inline-flex size-6 flex-none items-center justify-center rounded-full border text-xs font-strong ${disc[step.status]}`}
            >
              {step.status === "done" ? "✓" : index + 1}
            </b>
            <span className="sr-only">
              {step.status === "done" ? U.stepDone : U.stepN(index + 1)}
            </span>
          </span>
          <div className="min-w-0">
            <div
              className={`flex flex-wrap items-center gap-2 text-md font-strong ${step.status === "todo" ? "text-fg-muted" : ""}`}
            >
              {step.title}
              {SP}
              {step.tag ??
                (step.optional && step.status !== "done" ? <Tag>{U.optional}</Tag> : null)}
            </div>
            {step.body}
            {step.hint != null && (
              <div className="mt-0.5 max-w-measure text-xs-plus text-fg-muted">{step.hint}</div>
            )}
          </div>
          <div className="mt-px flex flex-wrap items-center justify-end gap-1.5">
            {step.actions}
          </div>
        </div>
      ))}
    </div>
  );
}
