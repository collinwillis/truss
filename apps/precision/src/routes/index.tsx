import { createFileRoute, redirect } from "@tanstack/react-router";

/** Redirect root to the estimates dashboard. */
export const Route = createFileRoute("/")({
  beforeLoad: () => {
    throw redirect({ to: "/estimates" });
  },
});
