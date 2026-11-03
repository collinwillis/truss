import { ConvexError } from "convex/values";

/**
 * A server refusal as a person should read it.
 *
 * Convex wraps a thrown `Error` in its own framing (the request id, "Server
 * Error", "Uncaught Error", and in development a stack trace), and on a
 * production deployment it redacts the message entirely. Refusals meant for
 * the user are therefore sent as a `ConvexError` whose data carries the
 * sentence; anything else is unwrapped as far as it can be.
 */
export function refusalText(error: unknown): string {
  // A ConvexError's `.message` is its serialised payload, so read `data`.
  const data: unknown = error instanceof ConvexError ? error.data : undefined;
  if (typeof data === "object" && data !== null) {
    const message = (data as { message?: unknown }).message;
    if (typeof message === "string" && message.trim() !== "") return message;
  }
  if (!(error instanceof Error)) return "Nothing was changed.";
  const withoutFrame = error.message.replace(/^.*?Uncaught Error:\s*/s, "");
  const firstLine = withoutFrame.split("\n")[0] ?? withoutFrame;
  const trimmed = firstLine.replace(/\s+at\s+handler\b.*$/, "").trim();
  // A production deployment redacts to "[CONVEX M(...)] [Request ID: ...] Server Error".
  if (trimmed === "" || /(^|\]\s*)Server Error$/.test(trimmed)) return "Nothing was changed.";
  return trimmed;
}
