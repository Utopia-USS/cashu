// While incognito is on, keeps the profile's banana scale (`core.bananaScale`) in the incognito module,
// where the formatters and the shell read it. Mounted beside the shell (outside its remount key), once
// per vault, so a new scale remounts the page once and turning incognito off or switching the profile
// drops the old one. The scale is pinned for the day: a portfolio anchor moves with every price, and
// each change remounts the page (open drawers, typed forms). A failing read leaves the dots.

import type { BananaScale } from "@cashu/domain/core";
import { overviewQueries } from "@cashu/store/overview";
import { useQuery } from "@cashu/store-react";
import { setBananaScale } from "@cashu/ui-logic/core/incognito";
import { Component, type ReactNode, Suspense, useEffect, useRef } from "react";
import { useCalendarDay } from "./useCalendarDay.js";

const queries = overviewQueries({ prices: null });

function Sync({ vault }: { vault: string }): null {
  const today = useCalendarDay();
  const scale = useQuery(queries.bananaScale, { today });
  const pinned = useRef<{ day: string; scale: BananaScale | null } | null>(null);
  useEffect(() => {
    const was = pinned.current;
    if (was !== null && was.day === today && was.scale?.anchor === scale?.anchor) return;
    pinned.current = { day: today, scale };
    setBananaScale(scale, vault);
  }, [scale, today, vault]);
  useEffect(() => () => setBananaScale(null), []);
  return null;
}

class Quiet extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override render() {
    return this.state.failed ? null : this.props.children;
  }
}

export function BananaScaleSync({ vault }: { vault: string }) {
  return (
    <Quiet>
      <Suspense fallback={null}>
        <Sync vault={vault} />
      </Suspense>
    </Quiet>
  );
}
