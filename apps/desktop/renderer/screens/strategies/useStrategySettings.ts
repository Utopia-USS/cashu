// The investment strategy status card (ab24ab6 v2/StrategySettings.tsx InvestmentsStrategySettings with
// Header.tsx StrategyPopover): validation, inactive rules, pending proposals, the file paths, reload and the
// version history. Reads the native strategies screen (no file selection); the writes are the native strategy
// init / reload actions with the old toasts; a proposal opens in the route's proposal drawer.
import { lang } from "@cashu/i18n";
import { S as H } from "@cashu/i18n/investments/Header.strings";
import { S } from "@cashu/i18n/investments/v2/StrategySettings.strings";
import {
  strategiesQueries,
  strategyInit,
  strategyReload,
} from "@cashu/store/investments/strategies-screen";
import { useQuery, useUiAction } from "@cashu/store-react";
import { useToast, useUiEnv } from "@cashu/ui";
import { label } from "@cashu/ui-logic/core/messages";
import type { StrategyStatus } from "@cashu/ui-logic/investments/types";
import { useState } from "react";
import { wire } from "../investments/home/legacyWire.js";
import { S as N } from "./Strategies.strings.js";
import {
  type PendingProposal,
  popoverModel,
  proposalNotice,
  strategyTag,
} from "./strategiesModel.js";

const queries = strategiesQueries();
const reasonText = (reason: string) => label(`error.${reason}`) ?? reason;

/** Copy to the clipboard, then the old toast (ui.tsx copyText). */
export async function copyText(text: string, done: () => void) {
  try {
    await navigator.clipboard.writeText(text);
    done();
  } catch {
    // The old copyText fell back silently: nothing to tell the owner.
  }
}

/** Old postStrategyInit + postStrategyReload: answers null when it went through, else the failure text. */
export function useStrategyWrites(revision: string | null) {
  const init = useUiAction(strategyInit);
  const reload = useUiAction(strategyReload);
  return {
    busy: init.isPending || reload.isPending,
    init: async (): Promise<string | null> => {
      if (revision === null) return reasonText("capability_unavailable");
      const r = await init.run({ revision });
      if (r.status !== "completed") return reasonText(r.reason);
      if (r.value.status === "recovery_required") return reasonText(r.value.reason);
      if (r.value.status !== "created_and_recorded")
        await reload.run({ revision: r.value.revision }).catch(() => null);
      return null;
    },
    /** Old postStrategyReload: `{ version }` or the failure text. */
    reload: async (): Promise<{ version: number | null } | { error: string }> => {
      if (revision === null) return { error: reasonText("capability_unavailable") };
      const r = await reload.run({ revision });
      if (r.status !== "completed") return { error: reasonText(r.reason) };
      const v = r.value;
      if (v.status === "recorded" || v.status === "unchanged") return { version: v.version };
      if (v.status === "missing") return { version: null };
      return { error: reasonText("reason" in v ? v.reason : v.status) };
    },
  };
}

export interface StrategySettingsOptions {
  /** On the Strategie tab's side column (old `.strat-side > div { margin-top: 0 }`); else 18px above. */
  side?: boolean;
  /** Opens a pending proposal (the route's proposal drawer); false when it cannot open. */
  onProposalOpened?(gid: string): void;
}

export function useStrategySettings(o: StrategySettingsOptions) {
  const toast = useToast();
  const { privacy } = useUiEnv();
  const data = useQuery(queries.screen, { lang: lang(), privacy, selection: null });
  const writes = useStrategyWrites(data.status === "current" ? data.revision : null);
  const [history, setHistory] = useState(false);
  const s = data.status === "current" ? wire<StrategyStatus>(data.strategy) : null;
  const brief = s
    ? {
        state: s.state,
        errors: s.errors,
        warnings: s.warnings,
        inactive_rules: s.inactive_rules.length,
      }
    : null;
  const proposals: PendingProposal[] = data.proposals.map((p) => ({
    gid: p.gid,
    kind: p.kind,
    summary: p.summary,
  }));
  const notice = proposalNotice(proposals);
  const copyPath = (path: string, name: string) => {
    void copyText(path, () => toast(H.pathCopied(name), 2000));
  };
  const onInit = () => {
    void writes
      .init()
      .then((failure) =>
        failure === null ? toast(S.created, 3000) : toast(S.createFailed(failure), 4000),
      );
  };
  const onReload = () => {
    void writes.reload().then((r) => {
      if ("error" in r) toast(S.loadFailed(r.error), 4000);
      else toast(r.version != null ? S.loaded(r.version) : S.noFile, 2500);
    });
  };
  const onProposal = (gid: string) => o.onProposalOpened?.(gid);
  const popover = !s
    ? ({ kind: "unavailable" } as const)
    : s.state === "missing"
      ? ({
          kind: "missing",
          strategy: H.strategy,
          tag: { key: "none", text: H.none, tone: "warning" },
          fromTemplate: H.fromTemplate,
          copyCommand: H.copyCommand,
          onInit,
          onCopyCommand: () => {
            void copyText("/investments-setup", () => toast(H.copied, 2000));
          },
          notice,
        } as const)
      : ({
          kind: "ready",
          ...popoverModel(s),
          notice,
          onYaml: () => copyPath(s.files.yaml, "strategy.yaml"),
          onMd: () => copyPath(s.files.md, "strategy.md"),
          reload: H.reload,
          reloadTitle: H.reloadTitle,
          onReload,
          history,
          onHistory: () => setHistory((v) => !v),
          cols: [H.colVersion, H.colSaved, H.colState] as const,
        } as const);
  return {
    side: !!o.side,
    title: S.title,
    tag: strategyTag(brief),
    /** Native-only states: privacy mode hides the strategy, a host without file access cannot read it. */
    unavailableText:
      data.status === "unavailable" && data.reason === "privacy" ? N.privacy : N.unavailable,
    popover,
    view: H.view,
    onProposal,
  };
}
export type StrategySettingsState = ReturnType<typeof useStrategySettings>;
