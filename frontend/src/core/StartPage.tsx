// The frame of a module's in-app first steps (design/v3/first-steps sections 3, 7, 10): page head with the steps
// tag, then `[Pierwsze kroki (2/3)][Agent AI (1/3)]`; the steps widget's footer links the CLI / Claude Code page.
// Statuses come from GET /modules/{id}/setup polled every 5 s (progress made in Claude Code or the CLI shows up);
// the module's own Start fills the steps and owns its drawers.
import { type ReactNode, useEffect } from "react";
import { usePoll } from "../hooks";
import { ck } from "../swr";
import { SetupSteps, type SetupStepItem, Skeleton } from "../ui";
import { Grid, Widget } from "../widgets";
import { AgentWidget } from "./AgentWidget";
import { getSetup, type SetupInfo, type SetupState } from "./api";
import { useShell } from "./context";
import { stepsTag } from "./SetupPage";

const POLL_MS = 5000;

/** The module's setup steps, polled. When the server's state differs from the shell's, the profile list is
 * re-read (the tab dot, the page swap) unless held: `hold` (a drawer is open: its flow must not unmount mid-way)
 * takes the shell's reload hold, which also stops the window-focus reload (one guard for both). */
export function useSetupPoll(slug: string, moduleId: string, state: SetupState, hold: boolean) {
  const { reloadProfiles, hold: shellHold } = useShell();
  const setup = usePoll(() => getSetup(slug, moduleId), POLL_MS, [slug, moduleId], { key: ck(slug, "setup", moduleId) });
  const live = setup.data?.state;
  // declared first: a release runs before the check below re-reads the guard
  useEffect(() => (hold ? shellHold.acquire() : undefined), [hold, shellHold]);
  useEffect(() => {
    if (live && live !== state && !shellHold.held()) void reloadProfiles();
  }, [live, state, hold, reloadProfiles, shellHold]);
  return setup;
}

export function StartPage({ moduleId, title, setup, state, steps, tag = true, children }: {
  moduleId: string;
  /** The page head (`Budżet domowy`, `Kredyty`, `Majątek`). */
  title: string;
  setup: SetupInfo | null;
  state: SetupState;
  /** null while loading: three skeleton rows. */
  steps: SetupStepItem[] | null;
  /** The steps tag in the head (assets has none: it is never partial). */
  tag?: boolean;
  /** Drawers. */
  children?: ReactNode;
}) {
  const { go } = useShell();
  return (
    <>
      <div className="pagehead">
        <h2 className="ph">{title}</h2>
        {tag && stepsTag(setup, state)}
      </div>
      <Grid items={[
        {
          id: "start", span: 2, node: (
            <Widget title="Pierwsze kroki" body="tight"
              footer={<button className="lnk" onClick={() => go({ kind: "setup", module: moduleId, cli: true })}>Instrukcja Claude Code i CLI</button>}>
              {steps ? <SetupSteps steps={steps} /> : (
                <div style={{ display: "grid", gap: 14, padding: "12px 0" }}>{[0, 1, 2].map((i) => <Skeleton key={i} h={36} />)}</div>
              )}
            </Widget>
          ),
        },
        { id: "agent", span: 1, node: <AgentWidget /> },
      ]} />
      {children}
    </>
  );
}
