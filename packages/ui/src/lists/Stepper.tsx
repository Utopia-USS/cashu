// biome-ignore-all lint/correctness/noReactNativeRawText: DOM-only markup (text nodes kept 1:1 with the old DOM); the native side gets its own pair when needed.
import { S as U } from "@cashu/i18n/core/ui.strings";
import { Fragment } from "react";
import { stepDisc as disc } from "./stepDisc.js";

/** Horizontal wizard stepper: steps before `current` are done, `current` is on (0-based). */
export interface StepperProps {
  steps: readonly string[];
  current: number;
}

export function Stepper({ steps, current }: StepperProps) {
  return (
    <ol aria-label={U.steps} className="m-0 mb-4.5 flex list-none items-center gap-2 p-0 text-sm">
      {steps.map((step, index) => {
        const state = index < current ? "done" : index === current ? "on" : "todo";
        return (
          <Fragment key={step}>
            {index > 0 && <li aria-hidden="true" className="h-px min-w-5 flex-1 bg-border" />}
            <li
              aria-current={index === current ? "step" : undefined}
              className={`flex items-center gap-2 whitespace-nowrap ${state === "on" ? "font-strong text-fg" : "text-fg-muted"}`}
            >
              <b
                className={`inline-flex size-5.5 flex-none items-center justify-center rounded-full border text-xs font-strong ${disc[state]}`}
              >
                {index < current ? "✓" : index + 1}
              </b>{" "}
              {step}
            </li>
          </Fragment>
        );
      })}
    </ol>
  );
}
