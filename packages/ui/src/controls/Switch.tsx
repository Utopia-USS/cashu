/** On / off toggle (old ui.tsx `Switch`, `.switch`): a bare `role="switch"` button, 34x20 track on the border
 * colour (accent when on) with a 16px white knob; `label` is the accessible name, `title` says why it is off. */
export interface SwitchProps {
  on: boolean;
  onChange(on: boolean): void;
  label: string;
  disabled?: boolean;
  title?: string;
  /** Layout only. */
  className?: string;
}

export function Switch({ on, onChange, label, disabled, title, className = "" }: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      title={title}
      disabled={disabled}
      onClick={() => onChange(!on)}
      className={`relative inline-block h-5 w-8.5 flex-none cursor-pointer rounded-full border-0 p-0 align-middle after:absolute after:top-0.5 after:size-4 after:rounded-full after:bg-on-accent after:transition-[left] after:duration-120 disabled:cursor-default disabled:opacity-50 ${on ? "bg-accent after:left-4" : "bg-border after:left-0.5"} ${className}`}
    />
  );
}
