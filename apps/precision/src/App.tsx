import { RouterProvider, createRouter } from "@tanstack/react-router";
import { useBetterAuthTauri } from "@daveyplate/better-auth-tauri/react";
import { RouteError } from "./components/route-error";
import { tauriAuthClient } from "./lib/auth-client";
import { routeTree } from "./routeTree.gen";

/**
 * WHY a default error boundary: without one a screen's failed query (a refusal
 * after losing access to an estimate, say) replaced the whole app, shell and
 * all, with no way back. Each screen now fails in place inside the shell.
 */
const router = createRouter({ routeTree, defaultErrorComponent: RouteError });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

/** Root app component with Tauri deep link handling and file-based routing. */
function App() {
  useBetterAuthTauri({
    authClient: tauriAuthClient,
    scheme: "truss",
    debugLogs: false,
    onRequest: () => {},
    onSuccess: () => {},
    onError: () => {},
  });

  return <RouterProvider router={router} />;
}

export default App;
