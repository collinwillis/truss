import { ShieldAlert } from "lucide-react";
import type { JSX } from "react";
import { Button } from "@truss/ui/components/button";

/** Props for {@link MomentumAccessWall}. */
export interface MomentumAccessWallProps {
  /**
   * The caller is an active Member, so adding them to a project lets them in.
   * False for anyone else who lands here: a suspended account, or a session
   * the server did not recognise, which no grant can help.
   */
  activeMember: boolean;
  /** The account is suspended: no grant or setting helps until it is restored. */
  suspended?: boolean;
  onSignOut: () => void;
}

/**
 * Shown instead of the shell when the caller's Momentum access is No access.
 *
 * WHY it replaces the shell rather than sitting inside it: every screen in the
 * shell reads projects, and the server answers nothing to No access, so the
 * shell would only offer empty lists. Adding an active Member to a project
 * lifts their access automatically (docs/ACCESS.md), hence what it asks them
 * for; anyone else gets the generic ask, since a suspended person can't be added.
 */
export function MomentumAccessWall({
  activeMember,
  suspended = false,
  onSignOut,
}: MomentumAccessWallProps): JSX.Element {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-background px-4 text-center">
      <div className="mb-4 rounded-full bg-fill-quaternary p-3">
        <ShieldAlert className="size-6 text-label-quaternary" />
      </div>
      <p className="text-body font-medium text-foreground">
        {suspended ? "Account suspended" : "Momentum access required"}
      </p>
      <p className="mt-1 max-w-[280px] text-body text-muted-foreground">
        {suspended
          ? "Ask an organization admin to restore it."
          : activeMember
            ? "Ask an admin to add you to a project."
            : "Ask an organization admin for access."}
      </p>
      <Button variant="outline" size="sm" className="mt-4" onClick={onSignOut}>
        Sign Out
      </Button>
    </div>
  );
}
