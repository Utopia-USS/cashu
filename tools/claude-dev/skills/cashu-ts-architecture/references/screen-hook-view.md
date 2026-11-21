---
title: Screen hook + pure View
impact: CRITICAL
tags: architecture, screen, react, react-native, hooks, suspense, routing
---

# Screen hook + pure View

A screen is three pieces, two of them new files:

- **Route file** (Expo Router file on mobile, TanStack Router route on desktop): reads typed route
  params, builds navigation callbacks, calls the screen hook, returns the View. The route file also
  owns the screen's Suspense and error boundary.
- **Screen hook** `useXScreen.ts`, colocated with the screen in the app: all logic. Composes feature
  hooks from `packages/ui-logic` and store queries / commands, derives values, owns form state.
  Returns a typed state object. No JSX, no platform imports.
- **View** `XView.tsx`: renders the state it gets as props, composed from `packages/ui` and native
  controls. May use presentational hooks (open / closed, hover, refs, animation, `useStrings`, form
  field bindings). Never imports the store, sync, ui-logic hooks, commands, navigation or network.
  Every View has `XView.stories.tsx` with fake state for each phase (see `cashu-ui`).

**Promotion:** a screen hook used by one platform stays in that app. When the second platform builds
the same screen, the shared part moves into a feature hook in `ui-logic`; each app keeps a thin
screen hook. Do not create a shared screen hook in advance.

## Example

```ts
// apps/mobile/src/screens/merchants/useMerchantsScreen.ts
export type MerchantsScreenState =
  | { kind: "empty" }
  | {
      kind: "ready";
      rows: readonly MerchantRow[]; // Money stays Money; the View renders it with <Money>
      isSaving: boolean;
      onCategoryPicked(merchant: MerchantGid, category: CategoryId): void;
      onOpen(merchant: MerchantGid): void;
    };

export function useMerchantsScreen(args: {
  profile: VaultId;
  openMerchant(merchant: MerchantGid): void; // navigation comes in from the route file
}): MerchantsScreenState {
  const merchants = useUncategorizedMerchants(args.profile); // ui-logic feature hook over useQuery
  const { run, isPending } = useCommand(budget.setMerchantCategory);
  if (merchants.length === 0) return { kind: "empty" };
  return {
    kind: "ready",
    rows: merchants.map(toRow), // plain code: the React Compiler memoizes it
    isSaving: isPending,
    onCategoryPicked: (merchant, category) => run({ profile: args.profile, merchant, category }),
    onOpen: args.openMerchant,
  };
}
```

```tsx
// apps/mobile/app/(tabs)/budget/merchants.tsx - route file
export default function MerchantsRoute() {
  const profile = useCurrentProfile();
  const state = useMerchantsScreen({
    profile,
    openMerchant: (id) => router.push({ pathname: "/budget/merchant/[id]", params: { id } }),
  });
  return <MerchantsView state={state} />;
}
export { RouteErrorBoundary as ErrorBoundary } from "@/shell/RouteErrorBoundary";

// apps/mobile/src/screens/merchants/MerchantsView.tsx - View
export function MerchantsView({ state }: { state: MerchantsScreenState }) {
  const t = useStrings(merchantsStrings);
  switch (state.kind) {
    case "empty":
      return <EmptyState title={t.emptyTitle} />;
    case "ready":
      return <MerchantList rows={state.rows} onPick={state.onCategoryPicked} />; // FlashList inside
    default:
      return assertNever(state);
  }
}
```

The desktop has its own route file, screen hook and View; both screen hooks compose the same
`useUncategorizedMerchants` feature hook.

## Rules

- **No `loading` phase.** Data comes from `useQuery`, which returns rows; the first async read
  suspends to the route's `<Suspense>` fallback. Discriminated unions are for domain phases
  (`setupRequired | empty | ready`), switched exhaustively in the View.
- **Boundaries per route.** Mobile: each route file exports `ErrorBoundary` (Expo Router) and the
  layout provides `<Suspense>`. Desktop: TanStack Router `pendingComponent` / `errorComponent` per
  route, plus a root boundary in both apps. Argument changes (filters, period) go through
  `useTransition` so the previous data stays visible instead of flashing a fallback.
- **Typed routes.** Expo Router typed routes (`experiments.typedRoutes`) and TanStack Router on the
  desktop (memory or hash history in Electron, `validateSearch` with zod so filters live in the URL,
  not in state). Never build a path string by hand.
- **Intent-named callbacks** (`onCategoryPicked`, not `onPress`); navigation and platform effects are
  arguments of the screen hook, never imported by it.
- **What the state carries:** data, raw `Money` / dates for the value components, and dynamic labels.
  Static copy comes from `useStrings` in the View.
- **Dialogs and sheets** with their own logic get their own hook + View and return their result
  through a callback argument.
- **Big screens** compose section hooks (`usePositionsSection`) inside the screen hook; the View passes
  each slice to a section View.
- **Static screens** (no data, no actions) may be a route file rendering `packages/ui` directly; split
  the moment data or an action arrives.
- Desktop tabs that should keep state while hidden use React 19.2 `<Activity>` instead of remounting.
