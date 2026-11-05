// Generic pieces of the old ui.tsx that the investments Home needs and packages/ui does not have yet: the
// horizontal wizard Stepper (`.steps`), the vertical SetupSteps list (`.setup-steps`), the soft Notice
// (`.notice`), the RadioList (`.radios`) and the copyable command line (`.code`). Pure presentational; candidates
// for promotion to packages/ui on their second use (H1 note in the investments-ui-poc checkpoint).
import { S as U } from "@cashu/i18n/core/ui.strings";
import { Button, Tag } from "@cashu/ui";
import { Fragment, type ReactNode } from "react";

/** Old `.steps .st b` / `.setup-steps b.n` number disc: chip by default, accent when on, positive when done. */
const disc = {
  todo: "border-border bg-chip text-chip-fg",
  on: "border-accent bg-accent text-on-accent",
  done: "border-positive bg-positive text-on-accent",
} as const;

/** Horizontal wizard stepper: steps before `current` are done, `current` is on (0-based). */
export function Stepper({ steps, current }: { steps: readonly string[]; current: number }) {
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

type StepStatus = "done" | "on" | "todo";
export interface SetupStepItem {
  key: string;
  title: ReactNode;
  hint?: ReactNode;
  status: StepStatus;
  tag?: ReactNode;
  actions?: ReactNode;
  /** Never counts toward the module state: `opcjonalnie` after the title until done (unless `tag` is given). */
  optional?: boolean;
}

/** Vertical step list with live status (old `.setup-steps`). */
export function SetupSteps({ steps }: { steps: readonly SetupStepItem[] }) {
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
              {step.title}{" "}
              {step.tag ??
                (step.optional && step.status !== "done" ? <Tag>{U.optional}</Tag> : null)}
            </div>
            {step.hint != null && (
              <div className="mt-0.5 max-w-[calc(64ch)] text-xs-plus text-fg-muted">
                {step.hint}
              </div>
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

const notices = {
  neutral: "border-border bg-chip",
  info: "border-info bg-info-bg",
  warning: "border-warning bg-warning-bg",
  negative: "border-negative bg-negative-bg",
  positive: "border-positive bg-positive-bg",
} as const;

/** Soft message box (old `.notice`, softer than `.err`). `className` is layout only (margin). */
export function Notice({
  tone = "neutral",
  children,
  className = "mb-3",
}: {
  tone?: keyof typeof notices;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`flex items-center gap-3 rounded-control border px-3.5 py-2.5 text-sm ${notices[tone]} ${className}`}
    >
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

export interface RadioOption<T extends string> {
  value: T;
  title: ReactNode;
  desc?: ReactNode;
}

/** Radio choices as bordered rows (old `.radios`); `value` null = nothing picked yet. */
export function RadioList<T extends string>({
  name,
  value,
  onChange,
  options,
}: {
  name: string;
  value: T | null;
  onChange(value: T): void;
  options: readonly RadioOption<T>[];
}) {
  return (
    <div role="radiogroup">
      {options.map((option) => {
        const on = option.value === value;
        return (
          <label
            key={option.value}
            className={`mb-2 flex cursor-pointer items-start gap-2.5 rounded-md border px-3 py-2.5 ${on ? "border-accent ring-1 ring-accent ring-inset" : "border-border"}`}
          >
            <input
              type="radio"
              name={name}
              value={option.value}
              checked={on}
              onChange={() => onChange(option.value)}
              className="mt-1 accent-accent"
            />
            <div>
              <div className="flex flex-wrap items-center gap-2 text-md font-strong">
                {option.title}
              </div>
              {option.desc != null && <div className="text-sm text-fg-muted">{option.desc}</div>}
            </div>
          </label>
        );
      })}
    </div>
  );
}

/** Monospace command with a copy button (old `.code` + ui.tsx `Code`). */
export function CodeLine({ command, onCopy }: { command: string; onCopy(): void }) {
  return (
    <div className="my-1.5 flex items-center gap-2.5 rounded-control border border-border bg-chip py-1.5 pr-2 pl-3 font-mono text-xs-plus leading-normal text-fg">
      <span className="min-w-0 flex-1 overflow-auto whitespace-pre [font-variant-ligatures:none]">
        {command}
      </span>
      <Button onPress={onCopy} className="flex-none font-sans">
        {U.copy}
      </Button>
    </div>
  );
}
