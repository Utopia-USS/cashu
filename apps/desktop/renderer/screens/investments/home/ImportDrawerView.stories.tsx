import { ImportDrawerView } from "./ImportDrawerView.js";
import type { ImportDrawerState } from "./useImportDrawer.js";

const noop = () => {};
const state: ImportDrawerState = {
  title: "Import transactions",
  accountTag: null,
  step: 0,
  steps: ["Account", "File", "Preview", "Done"],
  error: null,
  busy: false,
  onClose: noop,
  accountOptions: [{ value: "1", title: "Synthetic broker", desc: "Synthetic · PLN" }],
  account: null,
  onAccount: noop,
  onAddAccount: noop,
  importer: "auto",
  importerOptions: [{ value: "auto", label: "Automatic" }],
  onImporter: noop,
  remembered: null,
  mapping: null,
  mappingLabel: "Mapping",
  onMapping: noop,
  preview: null,
  onChangeImporter: noop,
  onManual: noop,
  done: null,
  onClassify: noop,
  footer: { kind: "account", nextDisabled: true, next: "Next" },
  onBack: noop,
  onNext: noop,
  onPreview: noop,
  onCommit: noop,
};

export default { title: "Investments/ImportDrawer", component: ImportDrawerView, args: { state } };

export const AccountStep = {};
