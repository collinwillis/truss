import { RouterProvider, createRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";

/**
 * Create router instance with generated route tree.
 *
 * TanStack Router automatically generates the route tree from files in src/routes/.
 * The generated tree includes type-safe route definitions and navigation.
 */
const router = createRouter({ routeTree });

/**
 * Extend TanStack Router module to register router type.
 * Enables type-safe navigation and route parameters throughout the app.
 */
declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

/**
 * Main application component for Momentum.
 *
 * Provides router context for file-based routing with:
 * - Authentication (handled in __root.tsx)
 * - App shell layout (handled in __root.tsx)
 * - Nested routing for WBS drill-down navigation
 */
function App() {
  return <RouterProvider router={router} />;
}

export default App;
