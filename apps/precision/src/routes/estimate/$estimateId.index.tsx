import { createFileRoute, redirect } from "@tanstack/react-router";

/**
 * Opening an estimate lands on its Overview.
 *
 * WHY OVERVIEW, reversing the earlier "land on the first WBS" rule: the
 * estimators asked for it. Overview is where an estimate is read as a whole
 * (totals, rates, every WBS with its cost), and the WBS they want is one click
 * from there. Landing inside one WBS made them back out before doing anything.
 *
 * A redirect in `beforeLoad` rather than a rendered `<Navigate>`: the target
 * no longer depends on any data, so there is nothing to wait for and no
 * skeleton to flash. `replace` keeps this bare URL out of history, or Back
 * from Overview would land here and bounce straight back to Overview.
 */
export const Route = createFileRoute("/estimate/$estimateId/")({
  beforeLoad: ({ params }) => {
    throw redirect({
      to: "/estimate/$estimateId/overview",
      params: { estimateId: params.estimateId },
      replace: true,
    });
  },
});
