/** Old `.steps .st b` / `.setup-steps b.n` number disc: chip by default, accent when on, positive when done. */
export const stepDisc = {
  todo: "border-border bg-chip text-chip-fg",
  on: "border-accent bg-accent text-on-accent",
  done: "border-positive bg-positive text-on-accent",
} as const;
