/**
 * Display helpers shared by the admin members list and the member detail page.
 *
 * WHY: Both views render the same avatar fallback and the same wording on the
 * permission picker. One copy keeps the list and the detail page from
 * disagreeing about what "write" is called — a disagreement that would be
 * actively misleading on a screen that grants and revokes application access.
 *
 * Org-role wording is not here: `getRoleLabel` in ../organizations/permissions
 * already says exactly the same thing, so this module defers to it.
 */

/**
 * Two-letter initials for an avatar fallback.
 *
 * WHY not `@truss/lib`'s `getInitials`: that implementation slices to the
 * requested length before discarding empty segments, so a name containing a
 * double space yields a single letter. The admin panel has always filtered
 * first, and changing what an avatar shows for existing members is not a change
 * worth making here.
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

/**
 * Label for a permission level as it appears on the admin permission picker.
 *
 * WHY this is not `getPermissionLabel` from ../organizations/permissions: that
 * one describes a level to the person holding it ("Can Edit", "View Only"),
 * which reads wrong in a menu where an admin is choosing what to grant. This is
 * the imperative, picker-length wording the admin panel ships today.
 *
 * Unknown levels echo through unchanged rather than rendering blank, because the
 * backend returns the stored permission as an open string.
 */
export function getPermissionOptionLabel(level: string): string {
  const labels: Record<string, string> = {
    none: "No access",
    read: "View",
    write: "Edit",
    admin: "Admin",
  };
  return labels[level] ?? level;
}
