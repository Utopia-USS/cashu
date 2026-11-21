import { ClassificationView } from "./ClassificationView.js";
import { useClassificationScreen } from "./useClassificationScreen.js";

export function ClassificationPanel() {
  return <ClassificationView state={useClassificationScreen()} />;
}
