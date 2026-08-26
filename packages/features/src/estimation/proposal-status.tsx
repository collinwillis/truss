import { cn } from "@truss/ui/lib/utils";

/**
 * One definition of how a proposal status looks.
 *
 * WHY THIS EXISTS: Precision had two status palettes that disagreed. The
 * estimates list rendered `bidding` as amber and `submitted` as indigo; the
 * estimate overview rendered `bidding` as blue and `submitted` as amber. The same
 * estimate therefore changed colour depending on which screen you were on, which
 * is worse than either choice — a colour that means nothing consistent is just
 * decoration.
 *
 * The list's palette was also light-mode only (`bg-amber-100` with
 * `text-amber-800`), so in dark mode it rendered as a pale blob with dark text.
 * The overview's `bg-*-500/10` + `dark:text-*-400` treatment adapts to both
 * themes, so that is the one kept.
 *
 * SEMANTICS, which is why these hues and not others:
 *   bidding / open    active work in our hands   -> blue
 *   submitted         waiting on someone else    -> amber
 *   awarded           won                        -> green
 *   rejected          lost                       -> red
 *   declined / closed no longer live             -> neutral fill
 *
 * @see .context/design-principles.md — semantic tokens, dark-mode parity
 */

/** Every status a proposal can hold, per the Convex schema. */
export type ProposalStatus =
  | "bidding"
  | "submitted"
  | "awarded"
  | "rejected"
  | "declined"
  | "open"
  | "closed";

/** Tinted chip classes: a translucent fill so it works on either theme. */
const CHIP_CLASSES: Record<ProposalStatus, string> = {
  bidding: "bg-blue-500/10 text-blue-600 dark:text-blue-400",
  open: "bg-blue-500/10 text-blue-600 dark:text-blue-400",
  submitted: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
  awarded: "bg-green-500/10 text-green-600 dark:text-green-400",
  rejected: "bg-red-500/10 text-red-600 dark:text-red-400",
  declined: "bg-fill-secondary text-muted-foreground",
  closed: "bg-fill-secondary text-muted-foreground",
};

/**
 * Solid fills for the distribution bar.
 *
 * Saturated rather than translucent because a 10%-opacity segment inside a
 * rounded track reads as empty. Hues match {@link CHIP_CLASSES} so the bar and
 * the chips describe the same thing the same way.
 */
const BAR_CLASSES: Record<ProposalStatus, string> = {
  bidding: "bg-blue-500",
  open: "bg-blue-500",
  submitted: "bg-amber-500",
  awarded: "bg-green-500",
  rejected: "bg-red-500",
  declined: "bg-fill-primary",
  closed: "bg-fill-primary",
};

/** Neutral fallback for a status outside the union — legacy data is not clean. */
const UNKNOWN_CHIP = "bg-fill-secondary text-muted-foreground";
const UNKNOWN_BAR = "bg-fill-primary";

function isProposalStatus(value: string): value is ProposalStatus {
  return value in CHIP_CLASSES;
}

/** Chip classes for a status, falling back to neutral for unrecognised values. */
export function proposalStatusChipClasses(status: string | null | undefined): string {
  if (!status || !isProposalStatus(status)) return UNKNOWN_CHIP;
  return CHIP_CLASSES[status];
}

/** Bar-segment classes for a status, falling back to neutral. */
export function proposalStatusBarClasses(status: string | null | undefined): string {
  if (!status || !isProposalStatus(status)) return UNKNOWN_BAR;
  return BAR_CLASSES[status];
}

export interface ProposalStatusChipProps {
  status: string | null | undefined;
  className?: string;
  /**
   * `pill` — a tinted capsule. Right where a status appears ONCE, as a fact
   * about the thing on screen.
   *
   * `dot` — a 5px mark and plain text. Right in a LIST, where the pill's
   * tinted background repeats down every row and turns a column of 731 rows
   * into a stripe of colour. Same hue, same meaning, a fraction of the ink:
   * the colour marks the row, the word still says which state it is.
   */
  variant?: "pill" | "dot";
}

/**
 * The status chip itself.
 *
 * Renders nothing for an absent status rather than an empty pill, so a row with
 * no status reads as blank instead of broken.
 */
export function ProposalStatusChip({
  status,
  className,
  variant = "pill",
}: ProposalStatusChipProps): React.ReactElement | null {
  if (!status) return null;

  if (variant === "dot") {
    return (
      <span className={cn("inline-flex items-center gap-1.5 capitalize", className)}>
        <span
          className={cn("h-[5px] w-[5px] shrink-0 rounded-full", proposalStatusBarClasses(status))}
          aria-hidden="true"
        />
        <span className="truncate text-muted-foreground">{status}</span>
      </span>
    );
  }

  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-1.5 py-px text-[10px] font-medium capitalize",
        proposalStatusChipClasses(status),
        className
      )}
    >
      {status}
    </span>
  );
}
