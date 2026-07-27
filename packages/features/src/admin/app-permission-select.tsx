import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@truss/ui/components/select";
import type { JSX } from "react";

import type { AppPermissionLevel } from "../organizations/types";
import { getPermissionOptionLabel } from "./member-display";

/**
 * Offered levels, highest first.
 *
 * WHY this order: an admin scanning the menu reads down from most to least
 * access, which matches how the levels are discussed ("give them edit").
 */
const PERMISSION_OPTIONS = ["admin", "write", "read", "none"] as const;

/**
 * Narrow the raw string Radix hands back to a permission level.
 *
 * WHY a guard rather than a cast: the four options below are the only values the
 * trigger can emit, so this never rejects in practice — but it means the level
 * reaching the Convex mutation is proven, not asserted.
 */
function isAppPermissionLevel(value: string): value is AppPermissionLevel {
  return PERMISSION_OPTIONS.some((option) => option === value);
}

/** Props for {@link AppPermissionSelect}. */
export interface AppPermissionSelectProps {
  /**
   * Currently granted level. Typed as `string` because the backend returns the
   * stored permission as an open string; unrecognised values still render via
   * {@link getPermissionOptionLabel} instead of collapsing to an empty trigger.
   */
  value: string;
  /** Fires with the newly chosen level. */
  onValueChange: (permission: AppPermissionLevel) => void;
  /** Owners always hold full access, so their control is inert. */
  disabled?: boolean;
  /** Trigger sizing differs between the dense table cell and the detail card. */
  triggerClassName?: string;
}

/**
 * Editable per-app permission control.
 *
 * Shared by the members table and the member detail page so the two never offer
 * a different set of levels for the same grant.
 */
export function AppPermissionSelect({
  value,
  onValueChange,
  disabled,
  triggerClassName,
}: AppPermissionSelectProps): JSX.Element {
  return (
    <Select
      value={value}
      onValueChange={(next) => {
        if (isAppPermissionLevel(next)) onValueChange(next);
      }}
      disabled={disabled}
    >
      <SelectTrigger className={triggerClassName}>
        <SelectValue>{getPermissionOptionLabel(value)}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        {PERMISSION_OPTIONS.map((option) => (
          <SelectItem key={option} value={option} className="text-callout">
            {getPermissionOptionLabel(option)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
