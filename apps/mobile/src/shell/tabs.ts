// Which tabs a profile shows: Today, Activity and Net worth always; Investments with its module.
export type TabName = "today" | "activity" | "investments" | "networth";

export function tabsFor(modules: readonly string[]): readonly TabName[] {
  return modules.includes("investments")
    ? ["today", "activity", "investments", "networth"]
    : ["today", "activity", "networth"];
}

/** The letter in a profile's avatar circle: the first character of its name, upper case. */
export function initialOf(name: string): string {
  return ([...name.trim()][0] ?? "?").toLocaleUpperCase();
}
