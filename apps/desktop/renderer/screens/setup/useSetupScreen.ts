import { builtinRegistry, moduleName } from "@cashu/domain/core";
import { lang } from "@cashu/i18n";
import { S as BUDGET } from "@cashu/i18n/budget/index.strings";
import { S as P } from "@cashu/i18n/core/SetupPage.strings";
import { S as INVESTMENTS } from "@cashu/i18n/investments/index.strings";
import { S as LOANS } from "@cashu/i18n/loans/index.strings";
import { profile } from "@cashu/store/core";
import { overviewQueries } from "@cashu/store/overview";
import { useProfile, useQuery } from "@cashu/store-react";
import { useUiEnv } from "@cashu/ui";
import { useEffect, useRef, useState } from "react";
import { type SetupNavigation, setupActionIntent } from "./actionIntent.js";
import { S } from "./Setup.strings.js";

export type SetupAgentContext =
  | { readonly kind: "unavailable"; readonly reason: string }
  | {
      readonly kind: "ready";
      readonly cliPrefix: string;
      readonly mcpAdd: string;
      readonly translocated: boolean;
    };

export interface SetupScreenProps {
  readonly moduleId: string;
  readonly agent: SetupAgentContext;
  readonly onNavigate: (target: SetupNavigation) => void;
  readonly onCopy: (text: string) => Promise<void>;
}

const registry = builtinRegistry();
/** The label of a module's first tab (old `def.tabs[0].label`); a module without tabs opens on Przegląd. */
const firstTabLabel = (module: string): string | null =>
  module === "budget"
    ? BUDGET.tabExpenses
    : module === "loans"
      ? LOANS.title
      : module === "investments"
        ? INVESTMENTS.tab
        : null;
const q = overviewQueries({ prices: null });

export function useSetupScreen(props: SetupScreenProps) {
  const vault = useProfile();
  const { privacy: incognito } = useUiEnv();
  const identity = useQuery(profile);
  const states = useQuery(q.moduleStates);
  const setup = useQuery(q.moduleSetup, {
    module: props.moduleId,
    cli: !incognito && props.agent.kind === "ready" ? props.agent.cliPrefix : "",
    lang: lang(),
  });
  const scope = `${vault}:${incognito}:${props.agent.kind}`;
  const [notice, setNotice] = useState<{
    readonly scope: string;
    readonly text: string;
    readonly n: number;
  } | null>(null);
  const lifetime = useRef(0);
  useEffect(() => {
    lifetime.current++;
  }, [vault, incognito, props.agent.kind]);
  const spec = registry.modules.get(props.moduleId);
  const enabled = new Set(states.filter((row) => row.enabled).map((row) => row.id));
  const valid = Boolean(spec && setup.ok);
  const steps = setup.ok ? setup.value.steps : [];
  const required = steps.filter((step) => !step.optional);
  const done = required.filter((step) => step.status === "done").length;
  return {
    kind: !valid
      ? ("unknown" as const)
      : !enabled.has(props.moduleId)
        ? ("disabled" as const)
        : ("ready" as const),
    moduleId: props.moduleId,
    name: spec ? moduleName(spec, lang()) : props.moduleId,
    setupState: setup.ok ? setup.value.state : ("empty" as const),
    skill: setup.ok ? setup.value.skill : null,
    steps: steps.map((step) => ({
      ...step,
      actions: step.actions.map((action) => ({
        ...action,
        intent: incognito
          ? null
          : setupActionIntent(props.moduleId, action, enabled, props.agent.kind === "ready"),
      })),
    })),
    done,
    total: required.length,
    agent: incognito ? { kind: "unavailable" as const, reason: "privacy" } : props.agent,
    mcpPrivacy: identity?.mcpPrivacy ?? "strict",
    /** A copy result for a toast; `n` changes on every copy so the same text toasts again. */
    notice: notice?.scope === scope ? { text: notice.text, n: notice.n } : null,
    firstTabLabel: firstTabLabel(props.moduleId),
    skillHint: props.moduleId === "investments" ? INVESTMENTS.skillHint : null,
    onAction: async (intent: ReturnType<typeof setupActionIntent>) => {
      if (!intent || incognito) return;
      if (intent.kind === "navigate") props.onNavigate(intent.target);
      else {
        const generation = lifetime.current;
        try {
          await props.onCopy(intent.text);
          if (generation === lifetime.current)
            setNotice((old) => ({ scope, text: P.copied, n: (old?.n ?? 0) + 1 }));
        } catch {
          if (generation === lifetime.current)
            setNotice((old) => ({ scope, text: S.copyFailed, n: (old?.n ?? 0) + 1 }));
        }
      }
    },
    onOpenModule: () => {
      if (incognito) return;
      const firstTab: Readonly<Record<string, string>> = {
        budget: "expenses",
        loans: "list",
        investments: "portfolio",
      };
      const tab = firstTab[props.moduleId];
      props.onNavigate(
        tab
          ? { kind: "module", module: props.moduleId, tab }
          : { kind: "overview", module: props.moduleId },
      );
    },
    onAgentSettings: () => props.onNavigate({ kind: "settings", section: "agent" }),
  };
}

export type SetupScreenState = ReturnType<typeof useSetupScreen>;
