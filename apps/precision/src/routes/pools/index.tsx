import { createFileRoute, redirect } from "@tanstack/react-router";

/** Redirect /pools to /pools/labor as the default view. */
export const Route = createFileRoute("/pools/")({
  beforeLoad: () => {
    throw redirect({ to: "/pools/labor" });
  },
});
