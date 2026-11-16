import { ConvexError } from "convex/values";

/**
 * The `kind` the backend puts on every access refusal (`model/accessResolve.ts`).
 * Restated because the backend package does not export its model.
 */
const ACCESS_REFUSED = "access_refused";

/**
 * Whether an error is the server saying "you may not", not a crash.
 *
 * Lets a screen whose subscription was refused (someone removed from an
 * estimate while it is open) say so plainly instead of "Something went wrong".
 *
 * @param error - Whatever a query or mutation threw
 * @returns True for an access refusal
 */
export function isAccessRefusal(error: unknown): boolean {
  if (!(error instanceof ConvexError)) return false;
  const data: unknown = error.data;
  return (
    typeof data === "object" && data !== null && "kind" in data && data.kind === ACCESS_REFUSED
  );
}

/**
 * A failed access change as a person should read it.
 *
 * The access functions refuse with a `ConvexError` whose data carries the
 * sentence ("Admins have full access."), and a ConvexError's `.message` is its
 * serialised payload, so `data` is read first. Anything else is unwrapped from
 * Convex's "Uncaught Error" framing, and a production deployment's redacted
 * "Server Error" becomes a plain statement that nothing changed.
 *
 * @param error - Whatever the mutation threw
 * @returns One sentence fit for a toast or an inline error line
 */
export function accessErrorText(error: unknown): string {
  const data: unknown = error instanceof ConvexError ? error.data : undefined;
  if (typeof data === "object" && data !== null && "message" in data) {
    const { message } = data;
    if (typeof message === "string" && message.trim() !== "") return message;
  }
  if (!(error instanceof Error)) return "Nothing was changed.";
  const withoutFrame = error.message.replace(/^.*?Uncaught Error:\s*/s, "");
  const firstLine = withoutFrame.split("\n")[0] ?? withoutFrame;
  const trimmed = firstLine.replace(/\s+at\s+handler\b.*$/, "").trim();
  if (trimmed === "" || /(^|\]\s*)Server Error$/.test(trimmed)) return "Nothing was changed.";
  return trimmed;
}
