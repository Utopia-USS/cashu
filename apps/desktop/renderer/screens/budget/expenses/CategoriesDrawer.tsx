// The "Kategorie" drawer for the budget Start page / actions (contract-E.md). Needs a ToastProvider above it.
import { Suspense } from "react";
import { CategoriesDrawerLoadingView, CategoriesDrawerView } from "./CategoriesDrawerView.js";
import { type CategoriesDrawerOptions, useCategoriesDrawer } from "./useCategoriesDrawer.js";

export type { CategoriesDrawerOptions } from "./useCategoriesDrawer.js";

export function CategoriesDrawer(props: CategoriesDrawerOptions) {
  return (
    <Suspense fallback={<CategoriesDrawerLoadingView onClose={() => props.onClose(false)} />}>
      <BoundCategories {...props} />
    </Suspense>
  );
}

function BoundCategories(props: CategoriesDrawerOptions) {
  return <CategoriesDrawerView state={useCategoriesDrawer(props)} />;
}
