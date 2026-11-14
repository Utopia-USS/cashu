import type { ClassifierSettingsSource } from "@cashu/store/core/classifier-settings";
import type {
  CategorizeProvider,
  CloudCategorizeProvider,
} from "../cli/budget/categorizeOllama.js";
import type { UiActionRegistration } from "../uiActions.js";
import {
  createProductionClassifierBinding,
  type ProductionClassifierOptions,
} from "./production.js";

/** Stable ports whose authority is installed only after the worker receives the held lock. */
export class ClassifierHostPorts {
  private binding: ReturnType<typeof createProductionClassifierBinding> | undefined;

  readonly local: CategorizeProvider = {
    isHolder: (vault) => this.binding?.local.isHolder(vault) === true,
    refresh: async (vault) => this.binding?.local.refresh?.(vault),
    fetch: (request, init) => {
      if (!this.binding) throw new Error("classifier_authority_unavailable");
      return this.binding.local.fetch(request, init);
    },
  };

  readonly cloud: CloudCategorizeProvider = {
    isHolder: (vault) => this.binding?.cloud.isHolder(vault) === true,
    refresh: async (vault) => this.binding?.cloud.refresh?.(vault),
    fetch: (request, init) => {
      if (!this.binding) throw new Error("classifier_authority_unavailable");
      return this.binding.cloud.fetch(request, init);
    },
    consent: (vault) => this.binding?.cloud.consent(vault) ?? null,
    config: (vault) => this.binding?.cloud.config(vault) ?? null,
    credentials: {
      apiKey: (vault) => this.binding?.cloud.credentials.apiKey(vault) ?? Promise.resolve(null),
    },
  };

  readonly action: UiActionRegistration = {
    id: "core.settings.classifier",
    run: (stores, vault, input, current) =>
      this.binding?.action.run(stores, vault, input, current) ??
      Promise.resolve({ status: "not_started", reason: "capability_unavailable" } as const),
  };

  private readonly listeners = new Set<() => void>();

  /** The live settings query's source: unavailable until bound, then the binding's, re-run on its changes. */
  readonly settings: ClassifierSettingsSource = {
    changes: {
      subscribe: (listener) => {
        this.listeners.add(listener);
        return () => {
          this.listeners.delete(listener);
        };
      },
    },
    state: (vault) => this.binding?.settings.state(vault) ?? { status: "unavailable" },
  };

  bind(options: ProductionClassifierOptions): void {
    if (this.binding) throw new Error("classifier_binding_already_installed");
    this.binding = createProductionClassifierBinding(options);
    const changed = () => {
      for (const listener of [...this.listeners]) listener();
    };
    this.binding.settings.changes.subscribe(changed);
    changed();
  }
}
