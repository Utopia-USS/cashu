import { ClassificationView } from "./ClassificationView.js";
import type { useClassificationScreen } from "./useClassificationScreen.js";

const base = {
  vault: "synthetic-vault",
  busy: false,
  notice: null,
  key: "",
  setKey() {},
  model: "claude-haiku-4-5",
  setModel() {},
  accepted: false,
  setAccepted() {},
  async chooseLocal() {},
  async grantCloud() {},
  async revokeCloud() {},
  async saveKey() {},
  async clearKey() {},
} satisfies Omit<ReturnType<typeof useClassificationScreen>, "snapshot">;

export default { component: ClassificationView, title: "Desktop/Classification" };
export const Local = {
  render: () => (
    <ClassificationView
      state={{
        ...base,
        snapshot: { backend: "ollama", model: base.model, consented: false, keyPresent: false },
      }}
    />
  ),
};
export const Cloud = {
  render: () => (
    <ClassificationView
      state={{
        ...base,
        snapshot: { backend: "anthropic", model: base.model, consented: true, keyPresent: true },
      }}
    />
  ),
};
