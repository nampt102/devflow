// Pure parts of the Triage snooze (openspec change add-triage-snooze): the days the dialog offers and the checks the server
// makes again. A request returns at 00:00 Vietnam time (UTC+7) of the chosen day, at most 90 days ahead.

export const MAX_SNOOZE_DAYS = 90;
const VN_OFFSET_MS = 7 * 3_600_000;
const DAY_MS = 86_400_000;

/** The calendar day (YYYY-MM-DD) in Vietnam at `at` plus `days`. */
export function vnDay(days: number, at: number = Date.now()): string {
  return new Date(at + VN_OFFSET_MS + days * DAY_MS).toISOString().slice(0, 10);
}

export const SNOOZE_PRESETS: Array<{ label: string; days: number }> = [
  { label: "Tomorrow", days: 1 },
  { label: "In a week", days: 7 },
  { label: "In a month", days: 30 },
];

/** Why a chosen day cannot be used, or null: it must be after today and within 90 days. */
export function snoozeBlocker(day: string, at: number = Date.now()): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return "Pick a day.";
  const start = Date.parse(`${day}T00:00:00+07:00`);
  if (Number.isNaN(start)) return "Pick a valid day.";
  if (start <= at) return "Pick a day after today.";
  if (start > at + MAX_SNOOZE_DAYS * DAY_MS) return `Snooze for at most ${MAX_SNOOZE_DAYS} days.`;
  return null;
}

/** "Back on 3 Nov" for the list of snoozed requests. */
export function backOnLabel(snoozedUntil: string): string {
  return `Back on ${new Date(snoozedUntil).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "Asia/Ho_Chi_Minh" })}`;
}
