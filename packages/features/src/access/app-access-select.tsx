import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@truss/ui/components/select";
import { cn } from "@truss/ui/lib/utils";
import { Lock } from "lucide-react";
import { useState, type JSX } from "react";

import type { AppName } from "../organizations/types";
import { APP_ACCESS_LABELS, APP_ACCESS_OPTIONS, appAccessMeaning } from "./labels";
import type { AppAccessSetting, EffectiveAppAccess } from "./types";

/**
 * Narrow the raw string Radix hands back to a setting.
 *
 * A guard rather than a cast, so the value reaching the mutation is proven to
 * be one of the options offered.
 */
function isAppAccessSetting(value: string): value is AppAccessSetting {
  return APP_ACCESS_OPTIONS.some((option) => option === value);
}

/** Trigger chrome: borderless in the dense Members table, bordered in a card. */
const TRIGGER_CLASSES = {
  table:
    "h-6 w-[136px] border-0 bg-transparent px-1.5 text-subheadline shadow-none hover:bg-fill-quaternary/60",
  field: "h-7 w-[148px] text-callout",
} as const;

/** Props for {@link AppAccessSelect}. */
export interface AppAccessSelectProps {
  /** The person's access to `app`; `full` renders locked. */
  value: EffectiveAppAccess;
  /** Which app this sets, so the option meanings name its items. */
  app: AppName;
  /**
   * Fires with the chosen setting. While a returned promise is pending the
   * control shows the choice and ignores further picks, so it never snaps back
   * to the old value before the server's answer lands.
   */
  onChange: (access: AppAccessSetting) => void | Promise<void>;
  disabled?: boolean;
  /**
   * What the control sets, for assistive tech ("Dana Lee, Precision access").
   * The current value is appended, since a name replaces what is announced.
   */
  label?: string;
  /** Show "Full access" with a lock whatever the value: Owners and Admins. */
  locked?: boolean;
  /** `table` for the Members table, `field` for the member detail card. */
  variant?: keyof typeof TRIGGER_CLASSES;
  className?: string;
}

/**
 * One Member's access to one app: No access, Only assigned, Can view all or
 * Can edit all. Owners and Admins show "Full access", locked, because their
 * role already gives it and there is nothing to set.
 */
export function AppAccessSelect({
  value,
  app,
  onChange,
  disabled,
  label,
  locked,
  variant = "table",
  className,
}: AppAccessSelectProps): JSX.Element {
  const [pending, setPending] = useState<AppAccessSetting | null>(null);

  if (locked || value === "full") {
    return (
      <span
        className={cn(
          "inline-flex items-center gap-1.5 text-muted-foreground",
          variant === "table" ? "px-1.5 text-subheadline" : "text-callout",
          className
        )}
      >
        {APP_ACCESS_LABELS.full}
        <Lock className="size-3 shrink-0 text-foreground-subtle" aria-hidden />
      </span>
    );
  }

  const shown = pending ?? value;

  const handleChange = (next: string) => {
    if (pending !== null || !isAppAccessSetting(next) || next === shown) return;
    setPending(next);
    void Promise.resolve()
      .then(() => onChange(next))
      .catch(() => {
        // The container has said why; the control returns to the stored value.
      })
      .finally(() => setPending(null));
  };

  // WHY busy rather than disabled while saving: Radix returns focus to the
  // trigger when the menu closes, and a disabled trigger cannot take it, so a
  // keyboard user would be dropped back to the top of the page.
  return (
    <Select value={shown} onValueChange={handleChange} disabled={disabled}>
      <SelectTrigger
        aria-label={label ? `${label}: ${APP_ACCESS_LABELS[shown]}` : undefined}
        aria-busy={pending !== null}
        data-pending={pending !== null ? "" : undefined}
        className={cn(TRIGGER_CLASSES[variant], "data-[pending]:opacity-60", className)}
      >
        <SelectValue>{APP_ACCESS_LABELS[shown]}</SelectValue>
      </SelectTrigger>
      <SelectContent align="start" className="w-64">
        {APP_ACCESS_OPTIONS.map((option) => {
          const meaning = appAccessMeaning(option, app);
          return (
            <SelectItem key={option} value={option} className="text-callout">
              <div className="flex flex-col gap-0.5">
                <span>{APP_ACCESS_LABELS[option]}</span>
                {meaning && (
                  <span className="text-subheadline text-muted-foreground">{meaning}</span>
                )}
              </div>
            </SelectItem>
          );
        })}
      </SelectContent>
    </Select>
  );
}
