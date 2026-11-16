/**
 * Access — who can see and change what (docs/ACCESS.md).
 *
 * The words, controls and panels the Members page, Precision's Share dialog
 * and Momentum's People panel share. Presentational components take plain
 * props and render without a Convex provider; the containers and
 * {@link useItemAccess} wire them to `api.access`.
 */

export type * from "./types";
export {
  APP_ACCESS_LABELS,
  APP_ACCESS_OPTIONS,
  APP_NAMES,
  APP_NOUNS,
  ITEM_LEVEL_LABELS,
  ITEM_LEVEL_OPTIONS,
  appAccessMeaning,
  appForNoun,
  getMemberInitials,
  toMemberRole,
} from "./labels";
export { accessErrorText, isAccessRefusal } from "./error-text";
export { AppAccessSelect, type AppAccessSelectProps } from "./app-access-select";
export { ItemAccessPanel, type ItemAccessPanelProps } from "./item-access-panel";
export { ShareDialog, type ShareDialogProps } from "./share-dialog";
export { useItemAccess, type AccessItem, type ItemAccessState } from "./use-item-access";
export {
  ItemAccessPanelContainer,
  ShareEstimateDialog,
  type ItemAccessPanelContainerProps,
  type ShareEstimateDialogProps,
} from "./item-access-containers";
