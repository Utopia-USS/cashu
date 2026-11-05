import { S as U } from "@cashu/i18n/core/ui.strings";
import { Button } from "./Button.js";

/** Monospace command with a copy button (old `.code` + ui.tsx `Code`; `multiline` = `.code.multi`). */
export interface CodeLineProps {
  command: string;
  onCopy(): void;
  /** Wrap long or multi-line text (a JSON snippet) instead of scrolling one line. */
  multiline?: boolean;
}

export function CodeLine({ command, onCopy, multiline }: CodeLineProps) {
  return (
    <div className="my-1.5 flex items-center gap-2.5 rounded-control border border-border bg-chip py-1.5 pr-2 pl-3 font-mono text-xs-plus leading-normal text-fg">
      <span
        className={`min-w-0 flex-1 overflow-auto [font-variant-ligatures:none] ${multiline ? "break-all whitespace-pre-wrap" : "whitespace-pre"}`}
      >
        {command}
      </span>
      <Button onPress={onCopy} className="flex-none font-sans">
        {U.copy}
      </Button>
    </div>
  );
}
