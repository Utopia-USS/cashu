import { todayLocal } from "@cashu/ui-logic/core/time";
import { useEffect, useState } from "react";

/** Calendar boundary and window focus, independent of financial query/cache invalidation. */
export function useCalendarDay(): string {
  const [day, setDay] = useState(() => todayLocal());
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => {
      clearTimeout(timer);
      const now = new Date();
      const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
      timer = setTimeout(refresh, next.getTime() - now.getTime() + 1);
    };
    const refresh = () => {
      setDay(todayLocal());
      schedule();
    };
    schedule();
    window.addEventListener("focus", refresh);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("focus", refresh);
    };
  }, []);
  return day;
}
