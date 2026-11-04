import { AdmissionView } from "./AdmissionView.js";

export default {
  title: "Desktop/Shell/Admission",
  component: AdmissionView,
  args: { status: "migration_required", onRetry: () => {} },
};

export const MigrationRequired = {};
export const Refused = { args: { status: "refused" } };
