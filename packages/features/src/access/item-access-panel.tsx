import { Avatar, AvatarFallback, AvatarImage } from "@truss/ui/components/avatar";
import { Button } from "@truss/ui/components/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@truss/ui/components/command";
import { Popover, PopoverContent, PopoverTrigger } from "@truss/ui/components/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@truss/ui/components/select";
import { Skeleton } from "@truss/ui/components/skeleton";
import { cn } from "@truss/ui/lib/utils";
import { ChevronsUpDown, Lock, UserPlus, Users } from "lucide-react";
import { useState, type JSX } from "react";

import {
  APP_ACCESS_LABELS,
  APP_NAMES,
  ITEM_LEVEL_LABELS,
  ITEM_LEVEL_OPTIONS,
  appForNoun,
  getMemberInitials,
} from "./labels";
import type {
  AccessCandidate,
  AccessNoun,
  ImplicitAccessCounts,
  ItemAccessLevel,
  ItemAccessPerson,
} from "./types";

/** Props for {@link ItemAccessPanel}. */
export interface ItemAccessPanelProps {
  /** People added to the item, sorted for display; `undefined` while loading. */
  people: ItemAccessPerson[] | undefined;
  /** Who reaches the item through their role or app access; `undefined` while loading. */
  implicit: ImplicitAccessCounts | undefined;
  /** Who can be added: not already listed, not an Owner or Admin. `undefined` while loading. */
  candidates: AccessCandidate[] | undefined;
  /** "estimates" or "projects", for the summary rows. */
  noun: AccessNoun;
  /**
   * A section heading with an Add button that reveals the add row, for a
   * settings page. Without it the add row is always shown, as in a dialog.
   */
  title?: string;
  /** The last action's failure, shown under the add row. */
  error?: string | null;
  /** People with a change in flight that this panel did not start. */
  pendingUserIds?: readonly string[];
  /** Adds someone. A rejection keeps the picked person so a retry is one click. */
  onAdd: (userId: string, level: ItemAccessLevel) => void | Promise<void>;
  onChangeLevel: (userId: string, level: ItemAccessLevel) => void | Promise<void>;
  onRemove: (userId: string) => void | Promise<void>;
}

/** What a row with a change in flight shows: the new level, or that it is leaving. */
type PendingChange = ItemAccessLevel | "removing";

/** Select value for the Remove option; never a level. */
const REMOVE = "remove";

/** Narrow the raw Select value to a level. */
function isItemAccessLevel(value: string): value is ItemAccessLevel {
  return ITEM_LEVEL_OPTIONS.some((option) => option === value);
}

/**
 * Who can open one estimate or project, and controls to add, change and remove
 * them. Shared by Precision's Share dialog and Momentum's People panel.
 *
 * Presentational: every change goes out through a callback, and a row shows
 * its new level until that callback's promise settles, so the list never
 * snaps back while the server answers.
 */
export function ItemAccessPanel({
  people,
  implicit,
  candidates,
  noun,
  title,
  error,
  pendingUserIds,
  onAdd,
  onChangeLevel,
  onRemove,
}: ItemAccessPanelProps): JSX.Element {
  const [pending, setPending] = useState<Readonly<Record<string, PendingChange>>>({});
  const [showAdd, setShowAdd] = useState(false);
  const inSection = title !== undefined;
  const app = appForNoun(noun);

  const track = (userId: string, change: PendingChange, action: () => void | Promise<void>) => {
    setPending((current) => ({ ...current, [userId]: change }));
    void Promise.resolve()
      .then(action)
      .catch(() => {
        // The container reports the failure; the row returns to its stored level.
      })
      .finally(() =>
        setPending((current) => {
          const next = { ...current };
          delete next[userId];
          return next;
        })
      );
  };

  const addRow = <AddPersonRow candidates={candidates} autoOpen={inSection} onAdd={onAdd} />;

  const rows = (
    <PeopleRows
      people={people}
      implicit={implicit}
      noun={noun}
      appName={APP_NAMES[app]}
      pending={pending}
      externalPending={pendingUserIds}
      inSection={inSection}
      onChangeLevel={(userId, level) => track(userId, level, () => onChangeLevel(userId, level))}
      onRemove={(userId) => track(userId, "removing", () => onRemove(userId))}
    />
  );

  const errorLine = error ? <p className="text-subheadline text-destructive">{error}</p> : null;

  if (!inSection) {
    return (
      <div className="min-w-0 space-y-3">
        {addRow}
        {errorLine}
        {rows}
      </div>
    );
  }

  return (
    <div className="min-w-0 space-y-3">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-body font-semibold text-muted-foreground">{title}</h2>
        <Button
          variant="outline"
          size="lg"
          className="gap-1.5 text-callout"
          onClick={() => setShowAdd((open) => !open)}
        >
          <UserPlus className="size-3" />
          Add
        </Button>
      </div>
      <div className="overflow-hidden rounded-mac-card border bg-card">
        {(showAdd || error) && (
          <div className="space-y-2 border-b bg-fill-quaternary/30 px-4 py-3">
            {showAdd && addRow}
            {errorLine}
          </div>
        )}
        {rows}
      </div>
    </div>
  );
}

/** Avatar with an initials fallback, at the size the panel's rows use. */
function PersonAvatar({ name, image }: { name: string; image?: string }): JSX.Element {
  return (
    <Avatar className="size-7 shrink-0">
      {image && <AvatarImage src={image} alt={name} />}
      <AvatarFallback className="text-footnote font-medium">
        {getMemberInitials(name)}
      </AvatarFallback>
    </Avatar>
  );
}

/** Pick a person, pick a level, add. */
function AddPersonRow({
  candidates,
  autoOpen,
  onAdd,
}: {
  candidates: AccessCandidate[] | undefined;
  /** Open the picker on mount: the Add button that revealed this row meant "pick someone". */
  autoOpen: boolean;
  onAdd: (userId: string, level: ItemAccessLevel) => void | Promise<void>;
}): JSX.Element {
  const [pickerOpen, setPickerOpen] = useState(autoOpen);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [level, setLevel] = useState<ItemAccessLevel>("edit");
  const [adding, setAdding] = useState(false);

  // Derived, not stored: once someone is added the container drops them from
  // the candidates, and the picker empties itself without an effect.
  const selected = candidates?.find((candidate) => candidate.userId === selectedId) ?? null;

  const handleAdd = () => {
    if (!selected || adding) return;
    setAdding(true);
    void Promise.resolve()
      .then(() => onAdd(selected.userId, level))
      .then(() => setSelectedId(null))
      .catch(() => {
        // The container says why; the pick stays so a retry is one click.
      })
      .finally(() => setAdding(false));
  };

  return (
    <div className="flex min-w-0 items-center gap-2">
      <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            className="flex h-7 min-w-0 flex-1 items-center gap-2 rounded-lg border bg-background px-2.5 text-left text-callout shadow-xs hover:bg-fill-quaternary"
          >
            {selected ? (
              <span className="truncate">{selected.name || selected.email}</span>
            ) : (
              <span className="truncate text-muted-foreground">Add people</span>
            )}
            <ChevronsUpDown className="ml-auto size-3.5 shrink-0 text-foreground-subtle" />
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-(--radix-popover-trigger-width) min-w-64 p-0" align="start">
          <Command>
            <CommandInput placeholder="Search people..." />
            <CommandList>
              {candidates === undefined ? (
                <div className="space-y-2 p-2">
                  <Skeleton className="h-7 w-full" />
                  <Skeleton className="h-7 w-full" />
                </div>
              ) : (
                <CommandEmpty>
                  {candidates.length === 0 ? "No one else to add." : "No one found."}
                </CommandEmpty>
              )}
              {candidates !== undefined && (
                <CommandGroup>
                  {candidates.map((candidate) => (
                    <CommandItem
                      key={candidate.userId}
                      value={`${candidate.name} ${candidate.email} ${candidate.userId}`}
                      onSelect={() => {
                        setSelectedId(candidate.userId);
                        setPickerOpen(false);
                      }}
                      className="gap-2.5"
                    >
                      <PersonAvatar name={candidate.name} image={candidate.image} />
                      <div className="min-w-0">
                        <p className="truncate text-callout">{candidate.name || candidate.email}</p>
                        {candidate.name && (
                          <p className="truncate text-subheadline text-muted-foreground">
                            {candidate.email}
                          </p>
                        )}
                      </div>
                    </CommandItem>
                  ))}
                </CommandGroup>
              )}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>

      <LevelSelect
        value={level}
        onChange={setLevel}
        bordered
        disabled={adding}
        label="Access for the person being added"
      />

      <Button size="lg" className="text-callout" disabled={!selected || adding} onClick={handleAdd}>
        {adding ? "Adding…" : "Add"}
      </Button>
    </div>
  );
}

/** The people list, then the muted rows for who has access without being added. */
function PeopleRows({
  people,
  implicit,
  noun,
  appName,
  pending,
  externalPending,
  inSection,
  onChangeLevel,
  onRemove,
}: {
  people: ItemAccessPerson[] | undefined;
  implicit: ImplicitAccessCounts | undefined;
  noun: AccessNoun;
  appName: string;
  pending: Readonly<Record<string, PendingChange>>;
  externalPending: readonly string[] | undefined;
  inSection: boolean;
  onChangeLevel: (userId: string, level: ItemAccessLevel) => void;
  onRemove: (userId: string) => void;
}): JSX.Element {
  const rowClass = cn("flex min-w-0 items-center gap-2.5 py-2", inSection && "border-b px-4");

  if (people === undefined) {
    return (
      <div>
        {Array.from({ length: 2 }).map((_, i) => (
          <div key={i} className={rowClass}>
            <Skeleton className="size-7 rounded-full" />
            <div className="flex-1 space-y-1.5">
              <Skeleton className="h-3.5 w-32" />
              <Skeleton className="h-3 w-44" />
            </div>
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className={cn(inSection && "[&>*:last-child]:border-b-0")}>
      {people.length === 0 && (
        <p
          className={cn(
            "text-subheadline text-muted-foreground",
            inSection ? "border-b px-4 py-3" : "py-1"
          )}
        >
          No one added yet.
        </p>
      )}

      {people.map((person) => {
        const change = pending[person.userId];
        const busy = change !== undefined || externalPending?.includes(person.userId) === true;
        const suspended = person.suspended === true;
        const appOff = person.appAccess === "none";
        // Highest wins, so a Can view grant under Can edit all changes nothing;
        // the row says why instead of showing a level that isn't true.
        const editsAll = person.appAccess === "edit_all" && person.level === "view";
        const secondary = suspended
          ? "Suspended"
          : appOff
            ? `No access to ${appName}`
            : editsAll
              ? `Can edit all ${noun}`
              : person.email;
        const name = person.name || person.email;
        return (
          <div
            key={person.userId}
            className={cn(rowClass, change === "removing" && "opacity-50")}
            aria-busy={busy}
          >
            <PersonAvatar name={person.name} image={person.image} />
            <div className="min-w-0 flex-1">
              <p className="truncate text-body font-medium">{name}</p>
              <p
                className={cn(
                  "truncate text-subheadline",
                  // Orange only where the grant does nothing; more access than the
                  // grant is not a problem, so it stays quiet.
                  suspended || appOff ? "text-mac-orange" : "text-muted-foreground"
                )}
              >
                {secondary}
              </p>
            </div>
            {person.appAccess === "full" ? (
              <LockedLevel label={APP_ACCESS_LABELS.full} />
            ) : (
              <LevelSelect
                value={change && change !== "removing" ? change : person.level}
                onChange={(level) => onChangeLevel(person.userId, level)}
                onRemove={() => onRemove(person.userId)}
                busy={busy}
                // A level change is a grant: the server refuses it for a
                // suspended person, and for an app at No access it would turn
                // the app back on. Remove is all these rows can do.
                levelsDisabled={suspended || appOff}
                label={`${name}, access to this ${noun === "estimates" ? "estimate" : "project"}`}
              />
            )}
          </div>
        );
      })}

      {implicit &&
        implicitRows(noun, implicit).map((row) => (
          <div key={row.label} className={rowClass}>
            <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-fill-quaternary">
              <Users className="size-3.5 text-foreground-subtle" />
            </span>
            <p className="min-w-0 flex-1 truncate text-callout text-muted-foreground">
              {row.label} <span className="tabular-nums">({row.count})</span>
            </p>
            <LockedLevel label={row.level} />
          </div>
        ))}
    </div>
  );
}

/**
 * The summary rows for an item's implicit access, leaving out empty ones.
 *
 * WHY the two shapes: on an estimate an Admin's role and Can edit all reach the
 * same thing, so they share a row. On a project an Admin also holds its
 * settings and people, so Momentum shows Admins as Full access on their own.
 */
function implicitRows(
  noun: AccessNoun,
  implicit: ImplicitAccessCounts
): { label: string; count: number; level: string }[] {
  const rows =
    noun === "estimates"
      ? [
          {
            label: "Admins and anyone who can edit all estimates",
            count: implicit.admins + implicit.editAll,
            level: ITEM_LEVEL_LABELS.edit,
          },
        ]
      : [
          { label: "Admins", count: implicit.admins, level: APP_ACCESS_LABELS.full },
          {
            label: "Anyone who can edit all projects",
            count: implicit.editAll,
            level: ITEM_LEVEL_LABELS.edit,
          },
        ];
  rows.push({
    label: `Anyone who can view all ${noun}`,
    count: implicit.viewAll,
    level: ITEM_LEVEL_LABELS.view,
  });
  return rows.filter((row) => row.count > 0);
}

/** A level that cannot be changed here, with the lock that says so. */
function LockedLevel({ label }: { label: string }): JSX.Element {
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 px-1.5 text-subheadline text-muted-foreground">
      {label}
      <Lock className="size-3 text-foreground-subtle" aria-hidden />
    </span>
  );
}

/** Can edit / Can view, plus Remove when the row can be removed. */
function LevelSelect({
  value,
  onChange,
  onRemove,
  disabled,
  busy = false,
  levelsDisabled = false,
  label,
  bordered = false,
}: {
  value: ItemAccessLevel;
  onChange: (level: ItemAccessLevel) => void;
  onRemove?: () => void;
  disabled?: boolean;
  /**
   * A change is in flight: picks are ignored. Not `disabled`, because Radix
   * returns focus to the trigger on close and a disabled one cannot take it.
   */
  busy?: boolean;
  /** Offer only Remove; the current level still shows on the trigger. */
  levelsDisabled?: boolean;
  /** What the control sets, for assistive tech; the current level is appended. */
  label?: string;
  /** Bordered beside the person picker; borderless in a row. */
  bordered?: boolean;
}): JSX.Element {
  return (
    <Select
      value={value}
      onValueChange={(next) => {
        if (busy) return;
        if (next === REMOVE) onRemove?.();
        else if (isItemAccessLevel(next) && next !== value && !levelsDisabled) onChange(next);
      }}
      disabled={disabled}
    >
      <SelectTrigger
        aria-label={label ? `${label}: ${ITEM_LEVEL_LABELS[value]}` : undefined}
        aria-busy={busy}
        data-pending={busy ? "" : undefined}
        className={cn(
          "shrink-0 data-[pending]:opacity-60",
          bordered
            ? "h-7 w-[104px] text-callout"
            : "h-6 w-auto gap-1 border-0 bg-transparent px-1.5 text-subheadline shadow-none hover:bg-fill-quaternary/60"
        )}
      >
        <SelectValue>{ITEM_LEVEL_LABELS[value]}</SelectValue>
      </SelectTrigger>
      <SelectContent align="end" className="min-w-32">
        {ITEM_LEVEL_OPTIONS.map((option) => (
          <SelectItem
            key={option}
            value={option}
            disabled={levelsDisabled}
            className="text-callout"
          >
            {ITEM_LEVEL_LABELS[option]}
          </SelectItem>
        ))}
        {onRemove && (
          <>
            <SelectSeparator />
            <SelectItem
              value={REMOVE}
              className="text-callout text-destructive focus:text-destructive"
            >
              Remove
            </SelectItem>
          </>
        )}
      </SelectContent>
    </Select>
  );
}
