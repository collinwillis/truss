import { RouterProvider, createRouter } from "@tanstack/react-router";
import { useBetterAuthTauri } from "@daveyplate/better-auth-tauri/react";
import { tauriAuthClient } from "./lib/auth-client";
import { routeTree } from "./routeTree.gen";

const router = createRouter({ routeTree });

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
