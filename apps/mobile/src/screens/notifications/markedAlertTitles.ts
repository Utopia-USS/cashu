// The titles of the alerts marked "tell my phone", for the settings screen's sub line: read from the
// alert signals (the light `readSignalRows` path), never the whole signals screen query (no valuation,
// no alert evaluation). A marked alert was marked from one of its signals, so its newest signal carries
// its title; the hook makes the text safe for the screen.
import { readSignalRows } from "@cashu/store/investments/signals-screen";
import { defineQuery } from "@cashu/store/query";

export interface MarkedAlertTitle {
  readonly alert: string;
  /** The alert's own title as its signal carries it, else the engine's message. */
  readonly text: string;
}

export const markedAlertTitles = defineQuery({
  id: "mobile.notifications.markedAlertTitles",
  run(read, args: { readonly now: string; readonly marked: readonly string[] }) {
    if (args.marked.length === 0) return [];
    const texts = new Map<string, string>();
    // Newest signal first: the first one of each alert wins.
    for (const signal of readSignalRows(read, args.now, "all")) {
      if (signal.alert === null || texts.has(signal.alert) || !args.marked.includes(signal.alert))
        continue;
      const title = signal.messageParams?.title;
      texts.set(signal.alert, typeof title === "string" ? title : signal.message);
    }
    return args.marked.flatMap((alert): MarkedAlertTitle[] => {
      const text = texts.get(alert);
      return text === undefined ? [] : [{ alert, text }];
    });
  },
});
