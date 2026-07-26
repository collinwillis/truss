/**
 * @truss/features/activities
 *
 * Activity-authoring UI shared by Momentum and Precision. The components own
 * the form and its keyboard-first UX; each host app owns its data access and
 * injects catalogs plus a submit handler.
 */

export type * from "./types";
export { AddActivityDialog, type AddActivityDialogProps } from "./add-activity-dialog";
