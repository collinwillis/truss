import { Badge } from "@truss/ui/components/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@truss/ui/components/select";
import { cn } from "@truss/ui/lib/utils";
import { Crown } from "lucide-react";
import { useState, type JSX } from "react";

import { getRoleLabel } from "../organizations/permissions";
import type { MemberRole } from "./types";

/** The roles an Owner or Admin can give: never Owner. */
export type AssignableRole = Exclude<MemberRole, "owner">;

const ASSIGNABLE_ROLES: readonly AssignableRole[] = ["admin", "member"];

function isAssignableRole(value: string): value is AssignableRole {
  return ASSIGNABLE_ROLES.some((role) => role === value);
}

const TRIGGER_CLASSES = {
  table:
    "h-6 w-[104px] border-0 bg-transparent px-1.5 text-subheadline shadow-none hover:bg-fill-quaternary/60",
  field: "h-7 w-[148px] text-callout",
} as const;

/** Props for {@link RoleSelect}. */
export interface RoleSelectProps {
  value: MemberRole;
  /** Fires with the new role; a returned promise holds the choice until it settles. */
  onChange: (role: AssignableRole) => void | Promise<void>;
  /**
   * What the control sets, for assistive tech ("Dana Lee, role"). The current
   * role is appended, since a name replaces what is announced.
   */
  label?: string;
  /** `table` for the Members table, `field` for the member detail card. */
  variant?: keyof typeof TRIGGER_CLASSES;
}

/**
 * Admin or Member, or the Owner badge: the Owner's role cannot be changed from
 * the app, and no one can be made Owner.
 */
export function RoleSelect({
  value,
  onChange,
  label,
  variant = "table",
}: RoleSelectProps): JSX.Element {
  const [pending, setPending] = useState<AssignableRole | null>(null);

  if (value === "owner") {
    return (
      <Badge variant="default" className="gap-1 text-footnote">
        <Crown className="size-2.5" />
        Owner
      </Badge>
    );
  }

  const shown = pending ?? value;

  const handleChange = (next: string) => {
    if (pending !== null || !isAssignableRole(next) || next === shown) return;
    setPending(next);
    void Promise.resolve()
      .then(() => onChange(next))
      .catch(() => {
        // The container has said why; the control returns to the stored role.
      })
      .finally(() => setPending(null));
  };

  // Busy rather than disabled while saving, so the trigger can take focus back
  // when the menu closes (see AppAccessSelect).
  return (
    <Select value={shown} onValueChange={handleChange}>
      <SelectTrigger
        aria-label={label ? `${label}: ${getRoleLabel(shown)}` : undefined}
        aria-busy={pending !== null}
        data-pending={pending !== null ? "" : undefined}
        className={cn(TRIGGER_CLASSES[variant], "data-[pending]:opacity-60")}
      >
        <SelectValue>{getRoleLabel(shown)}</SelectValue>
      </SelectTrigger>
      <SelectContent align="start">
        {ASSIGNABLE_ROLES.map((role) => (
          <SelectItem key={role} value={role} className="text-callout">
            {getRoleLabel(role)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
