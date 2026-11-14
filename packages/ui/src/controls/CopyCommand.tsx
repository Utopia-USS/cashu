import { Button } from "./Button.js";

export interface CommandCodeProps {
  /** The command or path, shown in monospace. */
  children: string;
  /** Wraps (breaking anywhere) and flows inline, for a long path inside a sentence (old `code.cmd.wrap`). */
  wrap?: boolean;
  /** `card` on a chip-filled box (old `.sched code.cmd`); default the chip fill. */
  surface?: "chip" | "card";
  title?: string;
}

/** A command in monospace (old research `code.cmd`: 12px / 1.4, chip fill, radius 6, padding 3px 8px, one line
 * with an ellipsis; `wrap` = `code.cmd.wrap`). */
export function CommandCode({ children, wrap, surface = "chip", title }: CommandCodeProps) {
  return (
    <code
      title={title}
      className={`rounded-sm px-2 py-0.75 font-mono text-xs leading-cozy text-fg [font-variant-ligatures:none] ${surface === "card" ? "bg-surface-raised" : "bg-chip"} ${
        wrap
          ? "inline break-all whitespace-normal"
          : "inline-block max-w-full overflow-hidden text-ellipsis whitespace-nowrap align-bottom"
      }`}
    >
      {children}
    </code>
  );
}

export interface CopyCommandProps {
  command: string;
  /** The button text (e.g. "Kopiuj polecenie"). */
  label: string;
  /** Primary (accent) button; default true. */
  primary?: boolean;
  /** The command in front of the button; default true. */
  showCommand?: boolean;
  /** `sm` = the small button. */
  size?: "sm" | "md";
  title?: string;
  /** Copy the command (the screen copies it and confirms with a toast). */
  onCopy(): void;
}

/** Monospace command + copy button (old research primitives `CopyCommand`: `code.cmd` then `.btn`). */
export function CopyCommand({
  command,
  label,
  primary = true,
  showCommand = true,
  size = "md",
  title,
  onCopy,
}: CopyCommandProps) {
  return (
    <>
      {showCommand && <CommandCode title={command}>{command}</CommandCode>}
      <Button
        variant={primary ? "primary" : "secondary"}
        size={size}
        title={title}
        onPress={onCopy}
      >
        {label}
      </Button>
    </>
  );
}
