import { ProfileProvider, StoreProvider } from "@cashu/store-react";
import type { StoreClient } from "@cashu/store-react/client";
import { RouterProvider } from "@tanstack/react-router";
import { Component, type ReactNode, Suspense } from "react";
import { S } from "./Desktop.strings.js";
import { RouteFailure, router } from "./routes.js";

class RootBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override render() {
    return this.state.failed ? <RouteFailure /> : this.props.children;
  }
}

export function App({ client }: { client: StoreClient }) {
  return (
    <StoreProvider client={client}>
      <RootBoundary>
        <Suspense
          fallback={
            <p role="status" className="p-6">
              {S.waiting}
            </p>
          }
        >
          <ProfileProvider fallback={<p className="p-6">{S.noProfile}</p>}>
            <RouterProvider router={router} />
          </ProfileProvider>
        </Suspense>
      </RootBoundary>
    </StoreProvider>
  );
}
