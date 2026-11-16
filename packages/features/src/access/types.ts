/**
 * The client's vocabulary for access (docs/ACCESS.md): one role per person, one
 * app-access setting per Member per app, and people added to single estimates
 * or projects.
 *
 * Declared here rather than imported from the backend's `model/access.ts`,
 * which the backend package does not export. The containers hand server values
 * straight into props typed with these, so a value the server adds and this
 * file lacks fails the type check instead of rendering blank.
 */

/** A Member's stored setting for one app. */
export type AppAccessSetting = "none" | "assigned" | "view_all" | "edit_all";

/**
 * What one person's access to an app works out to.
 *
 * `full` is never stored: it is what an Owner or Admin has through their role,
 * shown locked on every access control.
 */
export type EffectiveAppAccess = AppAccessSetting | "full";

/** What someone added to one estimate or project may do there. */
export type ItemAccessLevel = "view" | "edit";

/** The items an app's access covers, as the panels name them. */
export type AccessNoun = "estimates" | "projects";

/** One person added to an estimate or project. */
export interface ItemAccessPerson {
  userId: string;
  name: string;
  email: string;
  image?: string;
  level: ItemAccessLevel;
  /**
   * Their access to the item's app. `none` means the grant is ignored until the
   * app is switched back on, and `full` that their role already covers it.
   */
  appAccess?: EffectiveAppAccess;
  /** Suspended people keep their place but reach nothing while suspended. */
  suspended?: boolean;
}

/** Who reaches an item without being added to it. */
export interface ImplicitAccessCounts {
  /** Owners and Admins. */
  admins: number;
  /** Members set to Can edit all in this app. */
  editAll: number;
  /** Members set to Can view all in this app. */
  viewAll: number;
}

/** Someone who could be added to an item. */
export interface AccessCandidate {
  userId: string;
  name: string;
  email: string;
  image?: string;
}
