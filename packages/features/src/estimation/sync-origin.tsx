import { PencilLine } from "lucide-react";

import { Badge } from "@truss/ui/components/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@truss/ui/components/tooltip";
import { cn } from "@truss/ui/lib/utils";

/**
 * Provenance indicators for an estimate's relationship to the MCP Estimator.
 *
 * An estimate is either still MIRRORING from the legacy estimator — the Firestore
 * sync keeps it current, and upstream edits will land here — or it has been
 * EDITED IN PRECISION, at which point the sync skips it permanently and upstream
 * changes will never arrive again. The two behave materially differently, so the
 * distinction has to be visible somewhere.
 *
 * WHY ONLY THE EXCEPTION IS LABELLED: every one of the 713 production estimates
 * is currently mirroring. Badging all of them with "Mirroring from MCP Estimator"
 * would label the default state on every row — noise that conveys nothing and
 * trains people to stop reading badges. The informative state is the departure
 * from the default, so that is the only one that gets a badge.
 *
 * WHY NO "RE-SYNC" ACTION HERE: re-attaching an estimate to the mirror discards
 * every Precision edit on the next sync. That is destructive and irreversible,
 * and `precision.ts` has no server-side authorization yet — shipping it gated
 * only in the client would repeat exactly the mistake D6 documents, where legacy
 * enforced a rule in React and not on the write path. The action belongs with
 * M10's authorization work.
 *
 * @see docs/precision/DECISIONS.md D1
 */

/** Shared copy, so the list and the detail screen cannot drift apart. */
const OWNED_LABEL = "Edited in Precision";
const OWNED_EXPLANATION =
  "This estimate no longer syncs from the MCP Estimator. Changes made there will not appear here.";
const MIRRORED_EXPLANATION =
  "This estimate still syncs from the MCP Estimator every 6 hours. Editing it here stops that permanently.";

/** Format a detach timestamp for display. `null` when the estimate is mirrored. */
function formatDetachedOn(precisionOwnedAt: number | null): string | null {
  if (precisionOwnedAt === null) return null;
  return new Date(precisionOwnedAt).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export interface SyncOriginBadgeProps {
  /** When the estimate detached from the mirror, or `null` if it never has. */
  precisionOwnedAt: number | null;
  className?: string;
  /**
   * Glyph only, no label — for a dense grid row where the full outline badge
   * would cost ~96px of a 30px line. The tooltip still carries the sentence,
   * so nothing is lost but the width.
   */
  iconOnly?: boolean;
}

/**
 * Compact provenance badge for a list row.
 *
 * Renders nothing for a mirrored estimate — see the module note on why the
 * default state is deliberately unlabelled.
 */
export function SyncOriginBadge({
  precisionOwnedAt,
  className,
  iconOnly = false,
}: SyncOriginBadgeProps): React.ReactElement | null {
  const detachedOn = formatDetachedOn(precisionOwnedAt);
  if (detachedOn === null) return null;

  if (iconOnly) {
    return (
      <TooltipProvider delayDuration={300}>
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              className={cn("text-foreground-subtle shrink-0", className)}
              aria-label={OWNED_LABEL}
            >
              <PencilLine className="h-3 w-3" aria-hidden="true" />
            </span>
          </TooltipTrigger>
          <TooltipContent>
            <p className="max-w-64 text-pretty">
              {OWNED_LABEL}. {OWNED_EXPLANATION} Detached {detachedOn}.
            </p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }

  return (
    // Its own provider because the shell mounts TooltipProvider only inside
    // specific chrome components, not around the route body — the same pattern
    // theme-switcher and status-bar already use.
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>
          {/*
            `outline` rather than a colour: this is provenance, not health. A
            coloured badge would read as a warning, and detaching is the normal
            result of doing your job in Precision.
          */}
          <Badge
            variant="outline"
            className={cn("text-foreground-muted gap-1 font-normal", className)}
          >
            <PencilLine aria-hidden="true" />
            {OWNED_LABEL}
          </Badge>
        </TooltipTrigger>
        <TooltipContent>
          <p className="max-w-64 text-pretty">
            {OWNED_EXPLANATION} Detached {detachedOn}.
          </p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

export interface SyncOriginNoticeProps {
  /** When the estimate detached from the mirror, or `null` if it never has. */
  precisionOwnedAt: number | null;
  className?: string;
}

/**
 * The fuller statement for an estimate's own screen.
 *
 * Unlike {@link SyncOriginBadge} this renders in BOTH states, because on the
 * estimate itself "will my edits survive?" is a question worth answering
 * outright rather than by absence.
 */
export function SyncOriginNotice({
  precisionOwnedAt,
  className,
}: SyncOriginNoticeProps): React.ReactElement {
  const detachedOn = formatDetachedOn(precisionOwnedAt);
  const isOwned = detachedOn !== null;

  return (
    <div
      className={cn("flex items-start gap-2 text-xs text-muted-foreground", className)}
      // A status region, not an alert: it must not interrupt a screen reader
      // mid-task, but it should be announced if it changes.
      role="status"
    >
      <span className="text-pretty">
        {isOwned ? (
          <>
            <span className="font-medium text-foreground">{OWNED_LABEL}</span>
            {" — "}
            {OWNED_EXPLANATION} Detached {detachedOn}.
          </>
        ) : (
          <>
            <span className="font-medium text-foreground">Mirroring from MCP Estimator</span>
            {" — "}
            {MIRRORED_EXPLANATION}
          </>
        )}
      </span>
    </div>
  );
}
