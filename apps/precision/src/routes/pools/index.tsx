import { createFileRoute, redirect } from "@tanstack/react-router";

/** The pools are four tabs of one catalog now; /pools opens it on labor. */
export const Route = createFileRoute("/pools/")({
  beforeLoad: () => {
    throw redirect({ to: "/catalog", search: { pool: "labor" } });
  },
});
