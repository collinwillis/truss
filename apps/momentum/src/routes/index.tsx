import { createFileRoute, redirect } from "@tanstack/react-router";

/**
 * Root index route.
 *
 * Redirects to the projects list page as the entry point for the app.
 * Users must select a project before viewing progress tracking data.
 */
export const Route = createFileRoute("/")({
  beforeLoad: () => {
    throw redirect({ to: "/projects" });
  },
});
