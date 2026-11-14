/** The Signals read instants shared by the Home, the review deck, the asset page and the ported Signals screens. */

/** "Until next deposit" snoozes to the end of that local day. */
export const snoozeInstant = (day: string): string => new Date(`${day}T23:59:00`).toISOString();

/** The display clock: the current minute, for display-only values (ages, "x minutes ago"). */
export function minuteInstant(date: Date): string {
  const minute = new Date(date.getTime());
  minute.setUTCSeconds(0, 0);
  return minute.toISOString();
}

/** The Signals query's read instant: the start of the local calendar day. A pure function of the day, so
 * every Signals surface (rail, pages, dialogs) asks for the same query key all day and switching pages
 * never reloads; the host's live clock replaces it where it is bound (always on the desktop host). */
export function dayReadInstant(today: string): string {
  return new Date(`${today}T00:00:00`).toISOString();
}
