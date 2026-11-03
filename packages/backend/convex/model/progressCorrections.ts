/**
 * The rules for correcting progress that was already logged.
 *
 * A progress entry is one number per activity per day. Momentum's logs are
 * mostly typed from paper days after the work (in production only 6% are
 * logged on the day itself, and one sitting covered fifty dates), so the two
 * corrections this module serves are common: a number typed on the wrong day,
 * and a number typed wrong.
 *
 * PURE, with no Convex imports, so every rule here is tested in plain Node.
 *
 * @module
 */

/**
 * Whether a string is a real "YYYY-MM-DD" calendar date.
 *
 * WHY STRICT: the server used to accept any string as a date, and the weekly
 * report turns every entry's date into a week ending. One malformed date
 * stored by any caller made that throw, and Reports and the Excel export
 * broke for the whole project. "2026-02-30" is shaped right and is not a day.
 */
export function isEntryDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T12:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/**
 * The latest day progress may be logged for, given the server's clock.
 *
 * ONE DAY AHEAD OF UTC, on purpose. The workbook picks dates in the user's
 * local time, and on a Texas evening the local date is still a day behind
 * UTC's, while in the other direction a user ahead of UTC can be a day past
 * it. A day of slack refuses nothing a real user can pick and still refuses a
 * date next month.
 */
export function latestEntryDate(nowMs: number): string {
  return new Date(nowMs + 24 * 3600 * 1000).toISOString().slice(0, 10);
}

/**
 * The note a combined day keeps when a moved number lands on one already there.
 *
 * Both notes survive, because each explains its own half of the number.
 */
export function combineNotes(
  existing: string | undefined,
  moved: string | undefined
): string | undefined {
  const parts = [existing, moved]
    .map((note) => note?.trim())
    .filter((note): note is string => !!note);
  const distinct = [...new Set(parts)];
  return distinct.length > 0 ? distinct.join(" · ") : undefined;
}

/**
 * The note a saved entry ends up with.
 *
 * ⚠️ THIS FIXES NOTES VANISHING ON EVERY CORRECTION. The workbook saves a typed
 * quantity without its note, and the server wrote `notes: undefined`, which
 * deleted the note. Fixing a number erased the explanation of it.
 *
 * The rule has to keep working for Momentum clients already installed, which
 * cannot be changed: they send no note on a quantity edit, and they also send
 * no note to CLEAR one (a note saved empty arrives as undefined, with the
 * quantity unchanged). So:
 *
 * - a note was sent: it is the note, and an empty one clears it;
 * - no note, and the quantity changed: a quantity edit, keep the note;
 * - no note, and the quantity did not change: an old client clearing it.
 *
 * Current clients always send the note when saving one, so the third case
 * only ever comes from an old client.
 */
export function noteAfterSave(input: {
  sent: string | undefined;
  existing: string | undefined;
  quantityChanged: boolean;
}): string | undefined {
  if (input.sent !== undefined) {
    const trimmed = input.sent.trim();
    return trimmed === "" ? undefined : input.sent;
  }
  return input.quantityChanged ? input.existing : undefined;
}

/** A moved number's key: one activity, or one split row of it. */
export function entryKey(activityId: string, splitId: string | undefined): string {
  return splitId ? `${activityId}|${splitId}` : activityId;
}
