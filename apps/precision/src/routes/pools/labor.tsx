import { createFileRoute, redirect } from "@tanstack/react-router";

/**
 * The labor pool now lives in the catalog.
 *
 * ⚠️ A REDIRECT, NOT A SCREEN, AND DELIBERATELY SO. What used to be here read
 * `getDefaultBook` and `getLaborPool`, which means it showed the PUBLISHED
 * default with every retired row filtered out — the exact blind spot the
 * catalog exists to close. Leaving it in place as a second way in would leave
 * a screen that quietly answers "what do the labor constants say?" about the
 * wrong book. The path survives so old links and the command palette still
 * land somewhere real.
 */
export const Route = createFileRoute("/pools/labor")({
  beforeLoad: () => {
    throw redirect({ to: "/catalog", search: { pool: "labor" } });
  },
});
