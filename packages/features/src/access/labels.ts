/**
 * Every word the access screens use, in one place.
 *
 * The Members table, the member detail page, the Share dialog and Momentum's
 * People panel all name the same levels. One copy keeps them from drifting
 * into "Edit" here and "Can edit" there on screens that grant access.
 */

import type { AppName } from "../organizations/types";
import type { AccessNoun, AppAccessSetting, EffectiveAppAccess, ItemAccessLevel } from "./types";

/** What each app-access value is called, `full` included. */
export const APP_ACCESS_LABELS: Readonly<Record<EffectiveAppAccess, string>> = {
  none: "No access",
  assigned: "Only assigned",
  view_all: "Can view all",
  edit_all: "Can edit all",
  full: "Full access",
};

/**
 * The settings a Member can be given, least to most.
 *
 * WHY this order: it reads as a ladder, so the menu says what each step adds
 * without any explanation.
 */
export const APP_ACCESS_OPTIONS: readonly AppAccessSetting[] = [
  "none",
  "assigned",
  "view_all",
  "edit_all",
];

/** What each item level is called. */
export const ITEM_LEVEL_LABELS: Readonly<Record<ItemAccessLevel, string>> = {
  edit: "Can edit",
  view: "Can view",
};

/** Item levels as menus offer them, most first: adding someone is usually to work. */
export const ITEM_LEVEL_OPTIONS: readonly ItemAccessLevel[] = ["edit", "view"];

/** The items each app's access covers. */
export const APP_NOUNS: Readonly<Record<AppName, AccessNoun>> = {
  precision: "estimates",
  momentum: "projects",
};

/** Display names of the two apps. */
export const APP_NAMES: Readonly<Record<AppName, string>> = {
  precision: "Precision",
  momentum: "Momentum",
};

/** The app whose items a noun names. */
export function appForNoun(noun: AccessNoun): AppName {
  return noun === "estimates" ? "precision" : "momentum";
}

/**
 * The one-line meaning of an app-access setting, or `null` where the label
 * already says it all.
 *
 * @param access - The setting to explain
 * @param app - Which app, so the line names its items
 * @returns A sentence fragment for the option's second line
 */
export function appAccessMeaning(access: AppAccessSetting, app: AppName): string | null {
  const noun = APP_NOUNS[app];
  switch (access) {
    case "assigned":
      // Precision's Only assigned may also start estimates (and edits what it
      // starts), so it is not the narrower choice beside Can view all there.
      return app === "precision"
        ? `Sees only the ${noun} they've been added to; can start new ones`
        : `Sees only the ${noun} they've been added to`;
    case "view_all":
      return "Opens every one, changes nothing";
    case "edit_all":
      return "Works on every one";
    case "none":
      return null;
  }
}

/**
 * Narrow a server role string to an organization role.
 *
 * Unknown values read as `member`, the least privileged, so a role this build
 * does not know is never shown as an admin.
 *
 * @param role - The stored Better Auth role
 * @returns `owner`, `admin` or `member`
 */
export function toMemberRole(role: string | null | undefined): "owner" | "admin" | "member" {
  return role === "owner" || role === "admin" ? role : "member";
}

/**
 * Two-letter initials for an avatar fallback.
 *
 * WHY not `@truss/lib`'s `getInitials`: that implementation slices to the
 * requested length before discarding empty segments, so a name containing a
 * double space yields a single letter.
 *
 * @param name - The person's display name
 * @returns Up to two uppercase letters
 */
export function getMemberInitials(name: string): string {
  return name
    .split(" ")
    .map((part) => part[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();
}
