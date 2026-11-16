import type { Id } from "@truss/backend/convex/_generated/dataModel";
import type { JSX } from "react";

import { ItemAccessPanel } from "./item-access-panel";
import { ShareDialog } from "./share-dialog";
import type { AccessNoun } from "./types";
import { useItemAccess, type AccessItem } from "./use-item-access";

/** Props for {@link ItemAccessPanelContainer}. */
export interface ItemAccessPanelContainerProps {
  /** The estimate or project whose access this shows. */
  item: AccessItem;
  noun: AccessNoun;
  /** Section heading with an Add button, for a settings page; omit inside a dialog. */
  title?: string;
}

/**
 * {@link ItemAccessPanel} wired to the server. Render only for Owners and
 * Admins: the queries behind it refuse everyone else.
 */
export function ItemAccessPanelContainer({
  item,
  noun,
  title,
}: ItemAccessPanelContainerProps): JSX.Element {
  const state = useItemAccess(item);
  return (
    <ItemAccessPanel
      people={state.people}
      implicit={state.implicit}
      candidates={state.candidates}
      noun={noun}
      title={title}
      error={state.error}
      onAdd={state.add}
      onChangeLevel={state.changeLevel}
      onRemove={state.remove}
    />
  );
}

/** Props for {@link ShareEstimateDialog}. */
export interface ShareEstimateDialogProps {
  proposalId: Id<"proposals">;
  /** Shown in the title, as the estimate list names it. */
  estimateName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Precision's Share dialog for one estimate. Owner/Admin only, like the
 * Share button that opens it.
 *
 * The dialog unmounts its content when closed, so a closed dialog holds no
 * subscriptions and every opening starts with an empty picker.
 */
export function ShareEstimateDialog({
  proposalId,
  estimateName,
  open,
  onOpenChange,
}: ShareEstimateDialogProps): JSX.Element {
  return (
    <ShareDialog open={open} onOpenChange={onOpenChange} name={estimateName}>
      <ItemAccessPanelContainer item={{ proposalId }} noun="estimates" />
    </ShareDialog>
  );
}
