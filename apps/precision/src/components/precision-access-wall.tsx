import { Button } from "@truss/ui/components/button";
import { ShieldAlert } from "lucide-react";
import type { JSX } from "react";
import { WindowDragStrip } from "./window-drag-strip";

/** Props for {@link PrecisionAccessWall}. */
export interface PrecisionAccessWallProps {
  /**
   * The caller is an active Member, so adding them to an estimate lets them in.
   * False for anyone else who lands here: a suspended account, or a session
   * the server did not recognise, which no grant can help.
   */
  activeMember: boolean;
  /** The account is suspended: no grant or setting helps until it is restored. */
  suspended?: boolean;
  /** Signs out, so someone on the wrong account can switch. */
  onSignOut: () => void;
}

/**
 * Shown instead of the shell to a member whose Precision access is No access.
 *
 * WHY it replaces the shell rather than overlaying it: the shell subscribes to
 * Precision queries (`getProposal`, `listProposals`, the WBS nav tree) that the
 * server refuses at No access, so rendering it would produce a page of query
 * errors, not an empty app.
 *
 * WHY an active Member is asked to be added to an estimate: adding someone to
 * one lifts their Precision access from No access to Only assigned
 * (docs/ACCESS.md), so that is the one request that gets them in. Anyone else
 * gets the generic ask, since the server refuses to add a suspended person.
 */
export function PrecisionAccessWall({
  activeMember,
  suspended = false,
  onSignOut,
}: PrecisionAccessWallProps): JSX.Element {
  return (
    <div className="relative flex min-h-screen flex-col items-center justify-center bg-background text-center">
      <WindowDragStrip />
      <div className="mb-4 rounded-full bg-fill-quaternary p-3">
        <ShieldAlert className="h-6 w-6 text-label-quaternary" />
      </div>
      <p className="text-body font-medium text-foreground">
        {suspended ? "Account suspended" : "Precision access required"}
      </p>
      <p className="mt-1 max-w-[280px] text-body text-muted-foreground">
        {suspended
          ? "Ask an organization admin to restore it."
          : activeMember
            ? "Ask an admin to add you to an estimate."
            : "Ask an organization admin for access."}
      </p>
      <Button variant="outline" size="sm" className="mt-4" onClick={onSignOut}>
        Sign Out
      </Button>
    </div>
  );
}
