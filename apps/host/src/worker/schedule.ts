/** S56 section 8: one local daily slot, including start and wake ticks; no missed-day replay. */
const DEFAULT_SCHEDULE = Object.freeze({ hour: 7, minute: 30 });
export interface LocalSlot {
  readonly hour: number;
  readonly minute: number;
}
export function checkedSchedule(slot: LocalSlot = DEFAULT_SCHEDULE): LocalSlot {
  if (
    !Number.isInteger(slot.hour) ||
    !Number.isInteger(slot.minute) ||
    slot.hour < 0 ||
    slot.hour > 23 ||
    slot.minute < 0 ||
    slot.minute > 59
  )
    throw new Error("invalid_worker_schedule");
  return { hour: slot.hour, minute: slot.minute };
}
const pad = (n: number) => String(n).padStart(2, "0");
export const slotText = (slot: LocalSlot): string => `${pad(slot.hour)}:${pad(slot.minute)}`;
export const localDay = (time: number): string => {
  const d = new Date(time);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
export function slotPassed(time: number, slot: LocalSlot): boolean {
  const d = new Date(time);
  return d.getHours() > slot.hour || (d.getHours() === slot.hour && d.getMinutes() >= slot.minute);
}
export function nextSlot(time: number, slot: LocalSlot): string {
  const d = new Date(time);
  d.setHours(slot.hour, slot.minute, 0, 0);
  if (d.getTime() <= time) d.setDate(d.getDate() + 1);
  return d.toISOString();
}
