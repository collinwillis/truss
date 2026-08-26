import { createFileRoute, redirect } from "@tanstack/react-router";

/**
 * The equipment pool now lives in the catalog.
 *
 * A redirect for the same reason `/pools/labor` is one: the screen that stood
 * here read the published default and hid retired rows, so it could not answer
 * a question about a draft at all. The path is kept so existing links resolve.
 */
export const Route = createFileRoute("/pools/equipment")({
  beforeLoad: () => {
    throw redirect({ to: "/catalog", search: { pool: "equipment" } });
  },
});
